import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { chromium, Download, Page, Response } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const envPath = process.platform === "win32"
  ? path.join(repoRoot, ".env")
  : "/home/drosner/dave-brain/.env";

dotenv.config({ path: envPath });

const DEFAULT_OUTPUT_DIR = process.env.CELLARTRACKER_OUTPUT_DIR ||
  (process.platform === "win32"
    ? path.join(repoRoot, "scripts", "logs", "cellartracker-exports")
    : "/home/drosner/dave-brain/scripts/logs/cellartracker-exports");

const CELLARTRACKER_USER = process.env.CT_USER || process.env.CELLARTRACKER_USER || "";
const CELLARTRACKER_PASSWORD = process.env.CT_PASSWORD || process.env.CELLARTRACKER_PASSWORD || "";

export interface CellarTrackerExportOptions {
  table?: string;
  bottleState?: string;
  format?: string;
  outputDir?: string;
  headless?: boolean;
  timeoutMs?: number;
  includeContent?: boolean;
}

export interface CellarTrackerExportResult {
  status: "success" | "error";
  message: string;
  ranAt: string;
  filePath?: string;
  fileName?: string;
  table?: string;
  bytes?: number;
  data?: string;
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function requireCredentials(): void {
  if (!CELLARTRACKER_USER || !CELLARTRACKER_PASSWORD) {
    throw new Error("Missing CT_USER/CT_PASSWORD in environment");
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function saveFailureScreenshot(page: Page, outputDir: string): Promise<void> {
  try {
    await ensureDir(outputDir);
    await page.screenshot({
      path: path.join(outputDir, "cellartracker-export-failure.png"),
      fullPage: true,
    });
  } catch {
    // Best effort only.
  }
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      await locator.fill(value);
      return true;
    }
  }
  return false;
}

async function loginToCellarTracker(page: Page, timeoutMs: number): Promise<void> {
  await page.goto("https://www.cellartracker.com/signin.asp", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });

  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

  const filledUser = await fillFirst(page, [
    'input[name="User"]',
    'input[name="user"]',
    'input[type="email"]',
    "#User",
    "#Email",
  ], CELLARTRACKER_USER);

  const filledPassword = await fillFirst(page, [
    'input[name="Password"]',
    'input[name="password"]',
    'input[type="password"]',
    "#Password",
  ], CELLARTRACKER_PASSWORD);

  if (!filledUser || !filledPassword) {
    throw new Error("Could not find CellarTracker login form fields");
  }

  const navigationPromise = page.waitForNavigation({
    waitUntil: "networkidle",
    timeout: timeoutMs,
  }).catch(() => null);

  const clicked = await clickFirst(page, [
    'input[type="submit"]',
    'button[type="submit"]',
    'input[value*="Sign"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
  ]);

  if (!clicked) {
    throw new Error("Could not find CellarTracker submit button");
  }

  await navigationPromise;
  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

  const currentUrl = page.url().toLowerCase();
  const loginStillVisible = await page.locator('input[name="Password"], input[type="password"]').count();

  if (currentUrl.includes("signin") && loginStillVisible > 0) {
    throw new Error("CellarTracker login did not complete. Check credentials or MFA requirements.");
  }
}

async function triggerExport(
  page: Page,
  options: Required<CellarTrackerExportOptions>,
): Promise<{ download: Download | null; response: Response | null }> {
  const exportUrl = new URL("https://www.cellartracker.com/xlquery.asp");
  exportUrl.searchParams.set("Format", options.format);
  exportUrl.searchParams.set("Table", options.table);
  if (options.bottleState) {
    exportUrl.searchParams.set("BottleState", options.bottleState);
  }

  const downloadPromise = page.waitForEvent("download", { timeout: options.timeoutMs });
  const response = await page.goto(exportUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs,
  });

  const download = await downloadPromise.catch(() => null);
  return { download, response };
}

export async function runCellarTrackerExport(
  input: CellarTrackerExportOptions = {},
): Promise<CellarTrackerExportResult> {
  requireCredentials();
  const table = input.table || "Bottles";
  const bottleState = input.bottleState ?? (table === "Bottles" ? "1" : "");

  const options: Required<CellarTrackerExportOptions> = {
    table,
    bottleState,
    format: input.format || "csv",
    outputDir: input.outputDir || DEFAULT_OUTPUT_DIR,
    headless: input.headless ?? true,
    timeoutMs: input.timeoutMs || 120000,
    includeContent: input.includeContent ?? false,
  };

  await ensureDir(options.outputDir);

  const browser = await chromium.launch({
    headless: options.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 960 },
  });

  const page = await context.newPage();
  const ranAt = new Date();

  try {
    await loginToCellarTracker(page, options.timeoutMs);
    const { download, response } = await triggerExport(page, options);
    const defaultName = `cellartracker-${options.table.toLowerCase()}`;
    const suggestedName = download?.suggestedFilename() || `${defaultName}.csv`;
    const ext = path.extname(suggestedName) || ".csv";
    const baseName = path.basename(suggestedName, ext) || defaultName;
    const finalFileName = `${baseName}-${timestampForFile(ranAt)}${ext}`;
    const finalPath = path.join(options.outputDir, finalFileName);

    let data: string | undefined;

    if (download) {
      await download.saveAs(finalPath);
    } else if (response) {
      data = await response.text();
      await fs.writeFile(finalPath, data, "utf8");
    } else {
      throw new Error("CellarTracker export returned no download or response");
    }

    if (options.includeContent && data == null) {
      data = await fs.readFile(finalPath, "utf8");
    }

    const stat = await fs.stat(finalPath);

    return {
      status: "success",
      message: `CellarTracker export complete (${options.table})`,
      ranAt: ranAt.toISOString(),
      filePath: finalPath,
      fileName: finalFileName,
      table: options.table,
      bytes: stat.size,
      data,
    };
  } catch (error) {
    await saveFailureScreenshot(page, options.outputDir);
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      message,
      ranAt: ranAt.toISOString(),
      table: options.table,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

if (process.argv[1] === __filename) {
  runCellarTrackerExport()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.status === "success" ? 0 : 1);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({
        status: "error",
        message,
        ranAt: new Date().toISOString(),
      }));
      process.exit(1);
    });
}
