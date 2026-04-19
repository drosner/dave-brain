// server.js — Wine Scanner Pi Server
// Run: node server.js
// Requires: npm install express cors

import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app  = express();
const PORT = process.env.PORT || 3333;

// ── Config ────────────────────────────────────────────────────────────────────
const OPENROUTER_API_KEY  = process.env.OPENROUTER_API_KEY;
const WINE_MCP_URL        = process.env.WINE_MCP_URL;        // your Edge Function URL
const WINE_MCP_KEY        = process.env.WINE_MCP_KEY;        // Bearer key

if (!OPENROUTER_API_KEY || !WINE_MCP_URL || !WINE_MCP_KEY) {
  console.error("Missing env vars. Set OPENROUTER_API_KEY, WINE_MCP_URL, WINE_MCP_KEY");
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

// ── MCP helper ────────────────────────────────────────────────────────────────
async function callMCP(tool, input) {
  const res = await fetch(WINE_MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WINE_MCP_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ tool, input }),
  });
  if (!res.ok) throw new Error(`MCP error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

// ── OpenRouter vision helper ──────────────────────────────────────────────────
async function visionCall(systemPrompt, userPrompt, base64Image, mediaType = "image/jpeg") {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64Image}` } },
            { type: "text", text: userPrompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.choices[0].message.content;
  return JSON.parse(text);
}

// ── Route: Single bottle scan ─────────────────────────────────────────────────
// POST /api/scan-single
// Body: { image: base64string, mediaType: "image/jpeg" }
// Returns: wine detail card data
app.post("/api/scan-single", async (req, res) => {
  try {
    const { image, mediaType = "image/jpeg" } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    // Step 1: Vision — identify wine
    const vision = await visionCall(
      `You are a wine identification expert. Analyze wine bottle labels and barcodes.
       Always respond with valid JSON only. No markdown, no explanation outside JSON.`,
      `Identify the wine in this image. Return JSON:
       {
         "vintage": number or null,
         "producer": "string",
         "wine_name": "full wine name as it appears on label",
         "varietal": "string or null",
         "region": "string or null",
         "country": "string or null",
         "confidence": "high|medium|low",
         "notes": "any additional observations about the label"
       }`,
      image,
      mediaType
    );

    // Step 2: MCP search — match to inventory
    const searchQuery = [
      vision.vintage,
      vision.producer,
      vision.wine_name,
      vision.varietal,
      vision.region
    ].filter(Boolean).join(" ");

    let inventoryMatch = null;
    try {
      const results = await callMCP("search_wine", {
        query: searchQuery,
        match_count: 3,
        active_only: false,
      });
      inventoryMatch = results?.[0] || null;
    } catch (e) {
      console.warn("MCP search failed:", e.message);
    }

    res.json({
      vision,
      inventory: inventoryMatch,
      search_query: searchQuery,
    });

  } catch (err) {
    console.error("/api/scan-single error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Route: Multi-bottle overlay scan ─────────────────────────────────────────
// POST /api/scan-multi
// Body: { image: base64string, mediaType: "image/jpeg" }
// Returns: array of bottles with position data for overlay
app.post("/api/scan-multi", async (req, res) => {
  try {
    const { image, mediaType = "image/jpeg" } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

    // Step 1: Vision — identify ALL bottles with positions
    const vision = await visionCall(
      `You are a wine identification expert. Analyze images containing multiple wine bottles.
       Always respond with valid JSON only. No markdown, no preamble.`,
      `Identify every wine bottle visible in this image.
       For each bottle estimate its center position as a percentage of image width/height.
       Return JSON:
       {
         "bottles": [
           {
             "vintage": number or null,
             "producer": "string",
             "wine_name": "full name",
             "varietal": "string or null",
             "region": "string or null",
             "position": {
               "x": 0-100,
               "y": 0-100
             },
             "confidence": "high|medium|low"
           }
         ]
       }`,
      image,
      mediaType
    );

    const bottles = vision.bottles || [];

    // Step 2: For each bottle, look up in inventory (parallel)
    const enriched = await Promise.all(
      bottles.map(async (bottle) => {
        const query = [bottle.vintage, bottle.producer, bottle.wine_name, bottle.varietal]
          .filter(Boolean).join(" ");
        try {
          const results = await callMCP("search_wine", {
            query,
            match_count: 1,
            active_only: false,
          });
          const match = results?.[0] || null;
          return {
            ...bottle,
            inventory: match,
            label: match
              ? {
                  price:    match.purchase_price ? `$${match.purchase_price}` : null,
                  location: match.location || null,
                  bin:      match.bin || null,
                  score:    match.ct_score || match.my_score || null,
                  drink:    match.drink_from && match.drink_to
                              ? `${match.drink_from}–${match.drink_to}`
                              : null,
                }
              : null,
          };
        } catch {
          return { ...bottle, inventory: null, label: null };
        }
      })
    );

    res.json({ bottles: enriched });

  } catch (err) {
    console.error("/api/scan-multi error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve app ─────────────────────────────────────────────────────────────────
app.get("/", (_, res) => res.sendFile(join(__dirname, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🍷 Wine Scanner running at http://0.0.0.0:${PORT}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://<pi-ip>:${PORT}\n`);
});
