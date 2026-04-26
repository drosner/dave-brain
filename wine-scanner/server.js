// server.js - Wine Scanner Pi Server
// Run: node server.js
// Requires: npm install express cors

import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3333;

// Config
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const WINE_MCP_URL = process.env.WINE_MCP_URL; // Edge Function URL

if (!OPENROUTER_API_KEY || !WINE_MCP_URL) {
  console.error("Missing env vars. Set OPENROUTER_API_KEY and WINE_MCP_URL");
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(__dirname));

async function callMCP(tool, input) {
  const rpcBody = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: tool,
      arguments: input,
    },
  };

  const res = await fetch(WINE_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify(rpcBody),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP error: ${res.status} ${raw}`);

  const eventDataMatches = [...raw.matchAll(/^data:\s*(.+)$/gm)];
  const payloadText = eventDataMatches.length
    ? eventDataMatches.map((match) => match[1]).join("\n")
    : raw;
  const data = JSON.parse(payloadText);
  return data.result;
}

function normalizeInventoryMatch(match) {
  if (!match) return null;
  return {
    ...match,
    purchase_price: match.purchase_price ?? match.price ?? null,
  };
}

function parseBottleSearchResult(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text?.trim();
  if (!text || /^no matching bottles found/i.test(text)) return null;

  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;

  const parsed = {};
  for (const segment of firstLine.split("|")) {
    const part = segment.trim();
    if (!part) continue;

    const eqIndex = part.indexOf("=");
    if (eqIndex !== -1) {
      const key = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();
      parsed[key] = value;
      continue;
    }

    if (/^\d{4}$/.test(part)) {
      parsed.vintage = Number(part);
    } else if (part === "active") {
      parsed.active = true;
    } else if (!parsed.producer) {
      parsed.producer = part;
    } else if (!parsed.wine) {
      parsed.wine = part;
    }
  }

  return normalizeInventoryMatch({
    wine: parsed.wine || null,
    producer: parsed.producer || null,
    vintage: parsed.vintage || null,
    location: parsed.location || null,
    bin: parsed.bin || null,
    ct_barcode: parsed.barcode || null,
    active: parsed.active === true,
  });
}

function parseWineSearchResults(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text?.trim();
  if (!text || /^no matching wines found/i.test(text)) return [];

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = {};
      for (const segment of line.split("|")) {
        const part = segment.trim();
        if (!part) continue;

        const eqIndex = part.indexOf("=");
        if (eqIndex !== -1) {
          const key = part.slice(0, eqIndex).trim();
          const value = part.slice(eqIndex + 1).trim();
          parsed[key] = value;
          continue;
        }

        if (/^\d{4}$/.test(part)) {
          parsed.vintage = Number(part);
        } else if (!parsed.producer) {
          parsed.producer = part;
        } else if (!parsed.wine) {
          parsed.wine = part;
        }
      }

      return {
        ct_iwine: parsed.iWine ? Number(parsed.iWine) : null,
        producer: parsed.producer || null,
        wine: parsed.wine || null,
        vintage: parsed.vintage || null,
      };
    });
}

function uniqueQueries(values) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))];
}

async function findInventoryMatch(vision) {
  const bottleQueries = uniqueQueries([
    [vision.vintage, vision.producer, vision.wine_name, vision.varietal, vision.region].filter(Boolean).join(" "),
    [vision.producer, vision.wine_name].filter(Boolean).join(" "),
    [vision.vintage, vision.producer, vision.varietal].filter(Boolean).join(" "),
    vision.wine_name,
    [vision.producer, vision.varietal].filter(Boolean).join(" "),
    vision.producer,
    vision.varietal,
  ]);

  for (const query of bottleQueries) {
    const result = await callMCP("search_bottles", { query, limit: 3 });
    const match = parseBottleSearchResult(result);
    if (match) {
      return { match, query, strategy: "search_bottles" };
    }
  }

  const wineQueries = uniqueQueries([
    [vision.producer, vision.wine_name].filter(Boolean).join(" "),
    vision.wine_name,
    [vision.producer, vision.varietal].filter(Boolean).join(" "),
    vision.producer,
    vision.varietal,
    vision.region,
    [vision.vintage, vision.varietal].filter(Boolean).join(" "),
  ]);

  for (const query of wineQueries) {
    const wineResult = await callMCP("search_wines", { query, limit: 3 });
    const wineMatches = parseWineSearchResults(wineResult);
    for (const wineMatch of wineMatches) {
      const followupQueries = uniqueQueries([
        [wineMatch.vintage, wineMatch.producer, wineMatch.wine].filter(Boolean).join(" "),
        [wineMatch.producer, wineMatch.wine].filter(Boolean).join(" "),
        wineMatch.wine,
        [wineMatch.producer, vision.varietal].filter(Boolean).join(" "),
        wineMatch.producer,
      ]);

      for (const followupQuery of followupQueries) {
        const bottleResult = await callMCP("search_bottles", { query: followupQuery, limit: 3 });
        const match = parseBottleSearchResult(bottleResult);
        if (match) {
          return {
            match: {
              ...match,
              ct_iwine: match.ct_iwine ?? wineMatch.ct_iwine,
            },
            query: `${query} -> ${followupQuery}`,
            strategy: "search_wines_then_search_bottles",
          };
        }
      }
    }
  }

  return { match: null, query: bottleQueries[0] || "", strategy: "none" };
}

function parseModelJson(content) {
  if (typeof content !== "string") {
    throw new Error("Model returned non-text content");
  }

  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Models sometimes wrap JSON in markdown fences despite JSON mode.
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error(`Model did not return valid JSON: ${trimmed.slice(0, 200)}`);
}

async function visionCall(systemPrompt, userPrompt, base64Image, mediaType = "image/jpeg") {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
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
  return parseModelJson(text);
}

app.post("/api/scan-single", async (req, res) => {
  try {
    const { image, mediaType = "image/jpeg" } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

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

    let inventoryMatch = null;
    let searchQuery = "";
    let matchStrategy = "none";
    try {
      const lookup = await findInventoryMatch(vision);
      inventoryMatch = lookup.match;
      searchQuery = lookup.query;
      matchStrategy = lookup.strategy;
    } catch (e) {
      console.warn("MCP search failed:", e.message);
    }

    res.json({
      vision,
      inventory: inventoryMatch,
      search_query: searchQuery,
      match_strategy: matchStrategy,
    });
  } catch (err) {
    console.error("/api/scan-single error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/scan-multi", async (req, res) => {
  try {
    const { image, mediaType = "image/jpeg" } = req.body;
    if (!image) return res.status(400).json({ error: "No image provided" });

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

    const enriched = await Promise.all(
      bottles.map(async (bottle) => {
        const query = [bottle.vintage, bottle.producer, bottle.wine_name, bottle.varietal]
          .filter(Boolean).join(" ");
        try {
          const lookup = await findInventoryMatch(bottle);
          const match = lookup.match;
          return {
            ...bottle,
            inventory: match,
            label: match
              ? {
                  price: match.purchase_price ? `$${match.purchase_price}` : null,
                  location: match.location || null,
                  bin: match.bin || null,
                  score: match.ct_score || match.my_score || null,
                  drink: match.drink_from && match.drink_to
                    ? `${match.drink_from}-${match.drink_to}`
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

app.get("/", (_, res) => res.sendFile(join(__dirname, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nWine Scanner running at http://0.0.0.0:${PORT}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://<pi-ip>:${PORT}\n`);
});
