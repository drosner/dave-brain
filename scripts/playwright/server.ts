import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";
import {
  runCellarTrackerExport,
  runCellarTrackerInventoryExportTest,
} from "./cellartracker-export.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const envPath = process.platform === "win32"
  ? path.join(repoRoot, ".env")
  : "/home/drosner/dave-brain/.env";

dotenv.config({ path: envPath });

const PORT = Number(process.env.PLAYWRIGHT_RUNNER_PORT || "3002");
const API_TOKEN = process.env.PLAYWRIGHT_API_TOKEN || "";

if (!API_TOKEN) {
  console.error("Missing PLAYWRIGHT_API_TOKEN in environment");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "playwright-runner" });
});

app.post("/api/cellartracker/export", async (req, res) => {
  const token = req.header("x-api-key");
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({
      status: "error",
      message: "Unauthorized",
      ranAt: new Date().toISOString(),
    });
  }

  const result = await runCellarTrackerExport({
    table: req.body?.table,
    bottleState: req.body?.bottleState,
    format: req.body?.format,
    outputDir: req.body?.outputDir,
    headless: req.body?.headless,
    includeContent: req.body?.includeContent,
  });

  return res.status(result.status === "success" ? 200 : 500).json(result);
});

app.post("/api/cellartracker/inventory-export-test", async (req, res) => {
  const token = req.header("x-api-key");
  if (!token || token !== API_TOKEN) {
    return res.status(401).json({
      status: "error",
      message: "Unauthorized",
      ranAt: new Date().toISOString(),
    });
  }

  const result = await runCellarTrackerInventoryExportTest({
    outputDir: req.body?.outputDir,
    headless: req.body?.headless,
    includeContent: req.body?.includeContent,
    parseRows: req.body?.parseRows,
    timeoutMs: req.body?.timeoutMs,
  });

  return res.status(result.status === "success" ? 200 : 500).json(result);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Playwright runner listening on http://0.0.0.0:${PORT}`);
});
