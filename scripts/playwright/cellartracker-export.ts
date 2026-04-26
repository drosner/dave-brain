import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Browser, BrowserContext, chromium, Download, Page, Response } from "playwright";

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
const CHROMIUM_EXECUTABLE_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH ||
  (process.platform === "win32" ? undefined : "/usr/bin/chromium");
const DEFAULT_USER_AGENT = process.env.PLAYWRIGHT_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

export interface CellarTrackerExportOptions {
  table?: string;
  bottleState?: string;
  format?: string;
  outputDir?: string;
  headless?: boolean;
  timeoutMs?: number;
  includeContent?: boolean;
  parseRows?: boolean;
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
  columns?: string[];
  rows?: Record<string, string>[];
  rowCount?: number;
  source?: "direct-url" | "inventory-ui";
}

function buildLaunchOptions(headless: boolean) {
  return {
    headless,
    executablePath: CHROMIUM_EXECUTABLE_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  };
}

async function buildContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 960 },
    userAgent: DEFAULT_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  return context;
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
    const html = await page.content();
    await fs.writeFile(
      path.join(outputDir, "cellartracker-export-failure.html"),
      html,
      "utf8",
    );
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

function parseCsvToObjects(raw: string): { columns: string[]; rows: Record<string, string>[] } {
  if (!raw || !raw.trim()) {
    return { columns: [], rows: [] };
  }

  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      matrix.push(row);
      row = [];
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  row.push(field);
  if (row.length > 1 || row[0] !== "") {
    matrix.push(row);
  }

  if (!matrix.length) {
    return { columns: [], rows: [] };
  }

  const columns = matrix[0].map((value) => String(value || "").trim());
  const rows = matrix
    .slice(1)
    .filter((values) => values.some((value) => String(value || "").trim() !== ""))
    .map((values) => {
      const record: Record<string, string> = {};
      columns.forEach((column, index) => {
        record[column] = values[index] ?? "";
      });
      return record;
    });

  return { columns, rows };
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

async function fillBestEffortLoginFields(page: Page): Promise<{ user: boolean; password: boolean }> {
  const textLikeInputs = page.locator([
    'input[type="email"]',
    'input[type="text"]',
    'input:not([type])',
  ].join(", "));

  let user = false;
  const textLikeCount = await textLikeInputs.count();
  for (let i = 0; i < textLikeCount; i += 1) {
    const locator = textLikeInputs.nth(i);
    const name = ((await locator.getAttribute("name")) || "").toLowerCase();
    const id = ((await locator.getAttribute("id")) || "").toLowerCase();
    const placeholder = ((await locator.getAttribute("placeholder")) || "").toLowerCase();
    const autocomplete = ((await locator.getAttribute("autocomplete")) || "").toLowerCase();
    const signal = `${name} ${id} ${placeholder} ${autocomplete}`;

    if (
      signal.includes("user") ||
      signal.includes("email") ||
      signal.includes("login") ||
      autocomplete.includes("username")
    ) {
      await locator.fill(CELLARTRACKER_USER);
      user = true;
      break;
    }
  }

  if (!user && textLikeCount > 0) {
    await textLikeInputs.first().fill(CELLARTRACKER_USER);
    user = true;
  }

  const passwordInputs = page.locator('input[type="password"]');
  const password = await passwordInputs.count() > 0;
  if (password) {
    await passwordInputs.first().fill(CELLARTRACKER_PASSWORD);
  }

  return { user, password };
}

async function loginToCellarTracker(page: Page, timeoutMs: number): Promise<void> {
  await page.goto("https://www.cellartracker.com/signin.asp", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });

  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});
  await page.locator('input, button').first().waitFor({ timeout: 10000 }).catch(() => {});

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

  let userOk = filledUser;
  let passwordOk = filledPassword;

  if (!userOk || !passwordOk) {
    const fallback = await fillBestEffortLoginFields(page);
    userOk = userOk || fallback.user;
    passwordOk = passwordOk || fallback.password;
  }

  if (!userOk || !passwordOk) {
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

async function openInventoryPage(page: Page, timeoutMs: number): Promise<void> {
  await page.goto("https://www.cellartracker.com/list.asp?Table=Inventory", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });

  await page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => {});

  const inventoryMarkers = [
    "text=My Cellar",
    "text=Inventory",
    'a[href*="list.asp?Table=Inventory"]',
    'form[action*="xlquery.asp"]',
  ];

  for (const selector of inventoryMarkers) {
    if (await page.locator(selector).count()) {
      return;
    }
  }

  throw new Error("Inventory page did not load as expected after login");
}

async function exportFromInventoryUi(
  page: Page,
  options: Required<CellarTrackerExportOptions>,
): Promise<{ download: Download | null; response: Response | null }> {
  await openInventoryPage(page, options.timeoutMs);

  const exportResponsePromise = page.waitForResponse((response) => {
    return response.url().includes("xlquery.asp");
  }, { timeout: options.timeoutMs }).catch(() => null);

  const downloadPromise = page.waitForEvent("download", { timeout: options.timeoutMs }).catch(() => null);

  const clicked = await clickFirst(page, [
    'a[href*="xlquery.asp"]',
    'a[href*="Format=csv"]',
    'a:has-text("Export")',
    'button:has-text("Export")',
    'input[value*="Export"]',
    'img[alt*="Export"]',
    '[title*="Export"]',
  ]);

  if (!clicked) {
    throw new Error("Could not find the CellarTracker export control on Inventory");
  }

  const download = await downloadPromise;
  const response = await exportResponsePromise;

  return { download, response };
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
    parseRows: input.parseRows ?? false,
  };

  await ensureDir(options.outputDir);
  const ranAt = new Date();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch(buildLaunchOptions(options.headless));
    context = await buildContext(browser);
    page = await context.newPage();

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
      source: "direct-url",
    };
  } catch (error) {
    if (page) {
      await saveFailureScreenshot(page, options.outputDir);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      message,
      ranAt: ranAt.toISOString(),
      table: options.table,
    };
  } finally {
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

export async function runCellarTrackerInventoryExportTest(
  input: CellarTrackerExportOptions = {},
): Promise<CellarTrackerExportResult> {
  requireCredentials();

  const options: Required<CellarTrackerExportOptions> = {
    table: "Inventory",
    bottleState: "",
    format: input.format || "csv",
    outputDir: input.outputDir || DEFAULT_OUTPUT_DIR,
    headless: input.headless ?? true,
    timeoutMs: input.timeoutMs || 120000,
    includeContent: input.includeContent ?? true,
    parseRows: input.parseRows ?? true,
  };

  await ensureDir(options.outputDir);
  const ranAt = new Date();
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch(buildLaunchOptions(options.headless));
    context = await buildContext(browser);
    page = await context.newPage();

    await loginToCellarTracker(page, options.timeoutMs);
    const { download, response } = await exportFromInventoryUi(page, options);

    const suggestedName = download?.suggestedFilename() || "cellartracker-inventory.csv";
    const ext = path.extname(suggestedName) || ".csv";
    const baseName = path.basename(suggestedName, ext) || "cellartracker-inventory";
    const finalFileName = `${baseName}-${timestampForFile(ranAt)}${ext}`;
    const finalPath = path.join(options.outputDir, finalFileName);

    let data: string | undefined;

    if (download) {
      await download.saveAs(finalPath);
    } else if (response) {
      data = await response.text();
      await fs.writeFile(finalPath, data, "utf8");
    } else {
      throw new Error("Inventory export did not produce a download or HTTP response");
    }

    if (options.includeContent && data == null) {
      data = await fs.readFile(finalPath, "utf8");
    }

    const stat = await fs.stat(finalPath);
    const parsed = options.parseRows && data ? parseCsvToObjects(data) : { columns: [], rows: [] };

    return {
      status: "success",
      message: "CellarTracker inventory UI export complete",
      ranAt: ranAt.toISOString(),
      filePath: finalPath,
      fileName: finalFileName,
      table: "Inventory",
      bytes: stat.size,
      data,
      columns: parsed.columns,
      rows: parsed.rows,
      rowCount: parsed.rows.length,
      source: "inventory-ui",
    };
  } catch (error) {
    if (page) {
      await saveFailureScreenshot(page, options.outputDir);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      message,
      ranAt: ranAt.toISOString(),
      table: "Inventory",
      source: "inventory-ui",
    };
  } finally {
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
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
