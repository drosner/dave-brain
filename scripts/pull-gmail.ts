#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Open Brain — Gmail Ingestion v3
 *
 * Uses Gmail's built-in categorization (Primary, Updates) as first-pass filter,
 * then a single LLM call per email to classify, extract metadata, and detect orders.
 *
 * Flow:
 *   1. Fetch emails from CATEGORY_PRIMARY + CATEGORY_UPDATES (Gmail's own filtering)
 *   2. One gpt-4o-mini call per email: classify + extract metadata + detect orders
 *   3. Skip remaining noise (anything that slipped through Gmail's filter)
 *   4. Embed and store meaningful emails as thoughts in Supabase
 *   5. Upsert orders/shipments into orders table
 *
 * Usage:
 *   deno run --allow-net --allow-read --allow-write --allow-env pull-gmail.ts [options]
 *
 * Options:
 *   --window=24h|7d|30d|90d|1y|2y|3y|5y|all  Time window (default: all)
 *   --categories=PRIMARY,UPDATES    Gmail categories (default: PRIMARY,UPDATES)
 *   --dry-run                       Classify and show results without storing
 *   --orders-only                   Only extract orders, skip thoughts/todos/people
 *   --limit=N                       Max emails to process (default: 50000)
 *   --skip=N                        Skip first N messages (resume after crash)
 *   --list-labels                   List Gmail labels and exit
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 * For Gmail: credentials.json + token.json
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const SCRIPT_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const CREDENTIALS_PATH = `${SCRIPT_DIR}credentials.json`;
const TOKEN_PATH = `${SCRIPT_DIR}token.json`;
const SYNC_LOG_PATH = `${SCRIPT_DIR}sync-log.json`;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// ─── Sync Log ────────────────────────────────────────────────────────────────

interface SyncLog {
  ingested_ids: Record<string, string>;
  skipped_ids: Record<string, string>;
  last_sync: string;
}

async function loadSyncLog(): Promise<SyncLog> {
  try {
    const data = JSON.parse(await Deno.readTextFile(SYNC_LOG_PATH));
    if (!data.skipped_ids) data.skipped_ids = {};
    return data;
  } catch {
    return { ingested_ids: {}, skipped_ids: {}, last_sync: "" };
  }
}

async function saveSyncLog(log: SyncLog): Promise<void> {
  await Deno.writeTextFile(SYNC_LOG_PATH, JSON.stringify(log, null, 2));
}

// ─── Content Fingerprint ────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function contentFingerprint(text: string): Promise<string> {
  return await sha256(text.toLowerCase().trim().replace(/\s+/g, " "));
}

// ─── CLI Parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  window: string;
  categories: string[];
  dryRun: boolean;
  ordersOnly: boolean;
  limit: number;
  skip: number;
  listLabels: boolean;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {
    window: "all",
    categories: ["PRIMARY", "UPDATES"],
    dryRun: false,
    ordersOnly: false,
    limit: 50000,
    skip: 0,
    listLabels: false,
  };

  for (const arg of Deno.args) {
    if (arg.startsWith("--window=")) args.window = arg.split("=")[1];
    else if (arg.startsWith("--categories=")) {
      args.categories = arg.split("=")[1].toUpperCase().split(",").map((c) => c.trim());
    }
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--orders-only") args.ordersOnly = true;
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.split("=")[1], 10);
    else if (arg.startsWith("--skip=")) args.skip = parseInt(arg.split("=")[1], 10);
    else if (arg === "--list-labels") args.listLabels = true;
  }

  return args;
}

// ─── OAuth2 + Token Manager ─────────────────────────────────────────────────

interface OAuthCredentials {
  installed: { client_id: string; client_secret: string; redirect_uris: string[]; };
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

async function loadCredentials(): Promise<OAuthCredentials> {
  try {
    return JSON.parse(await Deno.readTextFile(CREDENTIALS_PATH));
  } catch {
    console.error(`\nNo credentials.json found at: ${CREDENTIALS_PATH}`);
    console.error("See setup guide for Gmail API OAuth configuration.");
    Deno.exit(1);
  }
}

async function loadToken(): Promise<TokenData | null> {
  try { return JSON.parse(await Deno.readTextFile(TOKEN_PATH)); } catch { return null; }
}

async function saveToken(token: TokenData): Promise<void> {
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshAccessToken(creds: OAuthCredentials, token: TokenData): Promise<TokenData> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.installed.client_id,
      client_secret: creds.installed.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  const updated: TokenData = {
    access_token: data.access_token, refresh_token: token.refresh_token,
    token_type: data.token_type, expiry_date: Date.now() + data.expires_in * 1000,
  };
  await saveToken(updated);
  return updated;
}

class TokenManager {
  private creds: OAuthCredentials;
  private token: TokenData;
  constructor(creds: OAuthCredentials, token: TokenData) { this.creds = creds; this.token = token; }

  async getAccessToken(): Promise<string> {
    if (Date.now() >= this.token.expiry_date - 5 * 60_000) {
      console.log("   [Token expiring — refreshing...]");
      this.token = await refreshAccessToken(this.creds, this.token);
    }
    return this.token.access_token;
  }
}

async function authorize(creds: OAuthCredentials): Promise<string> {
  let token = await loadToken();
  if (token) {
    if (Date.now() < token.expiry_date - 60_000) return token.access_token;
    token = await refreshAccessToken(creds, token);
    return token.access_token;
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", creds.installed.client_id);
  authUrl.searchParams.set("redirect_uri", "http://localhost:3847/callback");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\nOpen this URL in your browser to authorize:\n");
  console.log(authUrl.toString());
  try {
    if (Deno.build.os === "windows") new Deno.Command("cmd", { args: ["/c", "start", '""', authUrl.toString()] }).spawn();
    else if (Deno.build.os === "darwin") new Deno.Command("open", { args: [authUrl.toString()] }).spawn();
    else new Deno.Command("xdg-open", { args: [authUrl.toString()] }).spawn();
  } catch { console.log("(Could not auto-open browser.)"); }

  console.log("\nWaiting for authorization...");
  const code = await new Promise<string>((resolve) => {
    const server = Deno.serve({ port: 3847, onListen: () => { } }, (req) => {
      const authCode = new URL(req.url).searchParams.get("code");
      if (authCode) {
        resolve(authCode);
        setTimeout(() => server.shutdown(), 100);
        return new Response("<html><body><h2>Done! Close this tab.</h2></body></html>", { headers: { "Content-Type": "text/html" } });
      }
      return new Response("Waiting...", { status: 400 });
    });
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: creds.installed.client_id, client_secret: creds.installed.client_secret,
      redirect_uri: "http://localhost:3847/callback", grant_type: "authorization_code",
    }),
  });
  const tokenData = await tokenRes.json();
  if (tokenData.error) throw new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error}`);
  const newToken: TokenData = {
    access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type, expiry_date: Date.now() + tokenData.expires_in * 1000,
  };
  await saveToken(newToken);
  console.log("\nAuthorization successful!\n");
  return newToken.access_token;
}

async function createTokenManager(creds: OAuthCredentials): Promise<TokenManager> {
  let token = await loadToken();
  if (token) {
    if (Date.now() >= token.expiry_date - 60_000) {
      console.log("Access token expired, refreshing...");
      token = await refreshAccessToken(creds, token);
    }
    return new TokenManager(creds, token);
  }
  await authorize(creds);
  token = await loadToken();
  if (!token) throw new Error("Failed to load token after authorization");
  return new TokenManager(creds, token);
}

// ─── Gmail API ───────────────────────────────────────────────────────────────

async function gmailFetch(accessToken: string, path: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Gmail API error ${res.status}: ${await res.text()}`);
  return res.json();
}

interface GmailLabel { id: string; name: string; type: string; messagesTotal?: number; }
interface GmailMessageRef { id: string; threadId: string; }
interface GmailMessagePart { mimeType: string; body: { data?: string; size: number }; parts?: GmailMessagePart[]; headers?: { name: string; value: string }[]; }
interface GmailMessage { id: string; threadId: string; labelIds: string[]; payload: GmailMessagePart; internalDate: string; }

async function listLabels(accessToken: string): Promise<GmailLabel[]> {
  return ((await gmailFetch(accessToken, "/labels")) as { labels: GmailLabel[] }).labels;
}

function windowToQuery(window: string): string {
  const now = new Date();
  let after: Date;
  switch (window) {
    case "24h": after = new Date(now.getTime() - 86400000); break;
    case "7d": after = new Date(now.getTime() - 7 * 86400000); break;
    case "30d": after = new Date(now.getTime() - 30 * 86400000); break;
    case "90d": after = new Date(now.getTime() - 90 * 86400000); break;
    case "1y": after = new Date(now.getTime() - 365 * 86400000); break;
    case "2y": after = new Date(now.getTime() - 2 * 365 * 86400000); break;
    case "3y": after = new Date(now.getTime() - 3 * 365 * 86400000); break;
    case "5y": after = new Date(now.getTime() - 5 * 365 * 86400000); break;
    case "all": return "";
    default: console.error(`Unknown window: ${window}`); Deno.exit(1);
  }
  return `after:${after.getFullYear()}/${String(after.getMonth() + 1).padStart(2, "0")}/${String(after.getDate()).padStart(2, "0")}`;
}

async function listMessagesForCategory(
  accessToken: string, category: string, query: string, limit: number,
): Promise<GmailMessageRef[]> {
  const catQuery = `category:${category.toLowerCase()}`;
  const fullQuery = query ? `${catQuery} ${query}` : catQuery;
  const messages: GmailMessageRef[] = [];
  let pageToken: string | undefined;
  while (messages.length < limit) {
    let path = `/messages?maxResults=${Math.min(100, limit - messages.length)}&q=${encodeURIComponent(fullQuery)}`;
    if (pageToken) path += `&pageToken=${pageToken}`;
    const data = (await gmailFetch(accessToken, path)) as { messages?: GmailMessageRef[]; nextPageToken?: string };
    if (!data.messages) break;
    messages.push(...data.messages);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return messages.slice(0, limit);
}

async function listMessages(
  accessToken: string, categories: string[], query: string, limit: number,
): Promise<GmailMessageRef[]> {
  const seen = new Set<string>();
  const all: GmailMessageRef[] = [];
  for (const cat of categories) {
    const msgs = await listMessagesForCategory(accessToken, cat, query, limit);
    for (const msg of msgs) {
      if (!seen.has(msg.id)) { seen.add(msg.id); all.push(msg); }
    }
  }
  return all.slice(0, limit);
}

async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  return (await gmailFetch(accessToken, `/messages/${id}?format=full`)) as GmailMessage;
}

function getHeader(msg: GmailMessage, name: string): string {
  const h = (msg.payload.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// ─── Email Body Extraction ───────────────────────────────────────────────────

function decodeBase64Url(data: string): string {
  const b = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4;
  return new TextDecoder().decode(Uint8Array.from(atob(pad ? b + "=".repeat(4 - pad) : b), (c) => c.charCodeAt(0)));
}

function extractTextFromParts(part: GmailMessagePart): { plain: string; html: string } {
  let plain = "", html = "";
  if (part.mimeType === "text/plain" && part.body.data) plain += decodeBase64Url(part.body.data);
  else if (part.mimeType === "text/html" && part.body.data) html += decodeBase64Url(part.body.data);
  if (part.parts) for (const sub of part.parts) { const e = extractTextFromParts(sub); plain += e.plain; html += e.html; }
  return { plain, html };
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n").replace(/<\/h[1-6]>/gi, "\n\n").replace(/<\/tr>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function stripQuotedReplies(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^On .+ wrote:$/i.test(t)) break;
    if (/^On .+/i.test(t) && !t.endsWith("wrote:")) {
      if (/^On .+ wrote:$/im.test(lines.slice(i, i + 4).join(" "))) break;
    }
    if (/^-{3,}\s*Original Message\s*-{3,}$/i.test(t)) break;
    if (/^_{3,}$/.test(t)) break;
    if (/^From:.*@/.test(t) && cleaned.length > 0) break;
    if (/^-{5,}\s*Forwarded message/i.test(t)) break;
    if (/^>/.test(t) && cleaned.length > 0) break;
    cleaned.push(lines[i]);
  }
  return cleaned.join("\n").trim();
}

function stripSignature(text: string): string {
  const lines = text.split("\n");
  const cleaned: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "--" || lines[i].trim() === "-- ") break;
    if (i > lines.length - 8) {
      if (/^(regards|best|thanks|cheers|sincerely|sent from)/i.test(lines[i].trim())) { cleaned.push(lines[i]); break; }
      const remaining = lines.slice(i).join("\n").toLowerCase();
      if (remaining.includes("sent from my iphone") || remaining.includes("sent from my ipad")) break;
    }
    cleaned.push(lines[i]);
  }
  return cleaned.join("\n").trim();
}

// ─── Contact Extraction ─────────────────────────────────────────────────────

interface ExtractedContact { name: string; email: string; }

function parseEmailAddresses(headerValue: string): ExtractedContact[] {
  if (!headerValue) return [];
  const contacts: ExtractedContact[] = [];
  for (const entry of headerValue.split(/,\s*/)) {
    const match = entry.match(/^"?([^"<]*)"?\s*<([^>]+)>/);
    if (match) contacts.push({ name: match[1].trim(), email: match[2].trim().toLowerCase() });
    else {
      const bare = entry.trim().match(/[\w.+-]+@[\w.-]+/);
      if (bare) contacts.push({ name: "", email: bare[0].toLowerCase() });
    }
  }
  return contacts;
}

// ─── Angel Flight Detection ──────────────────────────────────────────────────

function isAngelFlightBulkEmail(from: string, subject: string): boolean {
  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();
  const isFromAF = fromLower.includes("angelflighteast") || fromLower.includes("angel flight");
  const isBulk = subjectLower.includes("flights ready") ||
    subjectLower.includes("missions available") ||
    subjectLower.includes("flyby") ||
    subjectLower.includes("pilots needed") ||
    subjectLower.includes("flights needed") ||
    subjectLower.includes("help for") ||
    subjectLower.includes("lend a hand");
  return isFromAF && isBulk;
}

// ─── Area Inference ──────────────────────────────────────────────────────────

function inferArea(projectName: string | null): string {
  if (!projectName) return "personal";
  const name = projectName.toLowerCase();
  if (name.includes("house") || name.includes("pool") || name.includes("home") || name.includes("boiler")) return "house";
  if (name.includes("workshop") || name.includes("workbench") || name.includes("metal") || name.includes("wood")) return "workshop";
  if (name.includes("fly") || name.includes("angel flight") || name.includes("seneca") || name.includes("aviation") || name.includes("pilot")) return "aviation";
  if (name.includes("pi") || name.includes("brain") || name.includes("ai") || name.includes("home assistant") || name.includes("tech") || name.includes("scaffold")) return "tech";
  if (name.includes("wine")) return "wine";
  if (name.includes("ski") || name.includes("killington") || name.includes("rental")) return "rental_property";
  if (name.includes("work") || name.includes("deloitte") || name.includes("client")) return "work";
  if (name.includes("family")) return "family";
  return "personal";
}

// ─── Unified LLM Classification + Extraction ────────────────────────────────

interface ClassificationResult {
  skip: boolean;
  skip_reason?: string;
  type: string;
  people?: { name: string; email?: string; role: string }[];
  action_items?: { task: string; assignee?: string; due_date?: string; urgency: string }[];
  topics?: string[];
  dates_mentioned?: string[];
  relationship_context?: string;
  sentiment?: string;
  key_decisions?: string[];
  financial_amounts?: string[];
  project?: string;
  summary?: string;
  order?: {
    vendor: string;
    item_description: string;
    items_list: string[];
    order_number: string | null;
    amount: number | null;
    currency: string;
    estimated_delivery: string | null;
    actual_delivery: string | null;
    tracking_number: string | null;
    tracking_carrier: string | null;
    tracking_url: string | null;
    status: string;
    email_type: string;
    category: string;
    project: string | null;
  };
}

async function classifyAndExtract(
  subject: string, from: string, to: string, body: string, date: string, gmailCategory: string,
): Promise<ClassificationResult> {
  const prompt = `You are analyzing an email to decide if it's worth storing in a personal knowledge system, and if so, extracting all useful information from it.

EMAIL:
- Subject: ${subject}
- From: ${from}
- To: ${to}
- Date: ${date}
- Gmail Category: ${gmailCategory}
- Body: ${body.slice(0, 5000)}

STEP 1 — CLASSIFY: Is this email meaningful enough to store?

SKIP these (set skip=true):
- Marketing emails, promotional offers, sales announcements
- Newsletters, daily/weekly digests, content roundups — even if the writing is substantive or intellectual. If it was sent to a mailing list (not personally addressed), it's noise.
- Substack posts, Medium digests, Beehiiv newsletters, or any email from a publication/creator sent to subscribers
- Editorial content, opinion pieces, articles, essays delivered via email — these are content the user subscribes to, not personal communications
- Social media notifications (likes, follows, comments)
- Security alerts, password resets, verification codes, OTPs
- Automated account notifications (new sign-in, statement ready)
- Bank balance alerts and threshold notifications (e.g. "Your available balance is $X")
- Payment authorization emails from PayPal where another vendor confirmation email exists (e.g. "PayPal: You authorized $X to Vendor")
- Credit card statement available notifications (no action needed, auto-pay handles it)
- Spam, phishing, or generic form responses
- Mailing list messages with no personal relevance
- Subscription confirmations for content services
- Generic "welcome" or onboarding emails from services
- News updates, breaking news alerts, media digests
- Community digests (Nextdoor, HOA newsletters, neighborhood updates)
- Anything from Segpay

KEY RULE: If the email was sent to many subscribers (not personally to the recipient), it is NOISE regardless of how interesting or well-written the content is. The test is: "Did a human write this specifically to/for the recipient?" If no, skip it.

CRITICAL — these are always noise regardless of content quality:
- Any email from a Substack author (substack.com in sender domain or unsubscribe link)
- Any email from a paid newsletter or media publication (NYT, WSJ, Free Press, Attia, etc.)
- Any email with an unsubscribe link at the bottom that was sent to a mailing list
- FAASafety.gov webinar announcements and safety bulletins (mass distributed)
- Any email where the recipient is addressed generically ("Dear Member", "Hello Pilot")

KEEP these (set skip=false):
- Real conversations between people (personal or professional)
- Order confirmations, shipping notifications, delivery updates
- NOTE: CellarTracker "wines have been added" emails are NOT orders — they are cellar management notifications. Set skip=true for these.
- Invoices, receipts for actual purchases
- Emails with action items, tasks, or requests
- Scheduling, meeting coordination
- Appointment confirmations and reservations (haircuts, doctor, dentist, auto service, etc.) — even if sent from an automated booking system like Vagaro, Calendly, Booksy, Square, etc. These represent real upcoming commitments.
- Project-related discussions
- Important notifications about real-world events (property, travel, legal, medical)
- Emails from contractors, vendors about active work
- Financial communications (not marketing — actual account-specific info)
- Payment requests related to real transactions (rent, services, property)
- Travel confirmations, flight itineraries, hotel reservations, rental car bookings

STEP 2 — If skip=false, extract ALL of the following:

Return JSON:
{
  "skip": boolean,
  "skip_reason": string (only if skip=true — brief reason like "marketing", "newsletter", "security alert"),
  "type": one of "conversation", "task", "decision", "reference", "introduction", "follow_up", "scheduling", "negotiation", "delegation", "order_confirmation", "shipping_notification", "delivery_confirmation", "invoice", "payment_request", "noise",
  "people": [{"name", "email" (if visible), "role": "sender"|"recipient"|"cc"|"mentioned"}],
  "action_items": [{"task", "assignee" (if clear), "due_date" (YYYY-MM-DD or null), "urgency": "high"|"medium"|"low"}],
  "topics": array of 1-5 specific topic tags. Be specific: "killington rental insurance" not "insurance", "padauk stool project" not "woodworking",
  "dates_mentioned": [YYYY-MM-DD],
  "relationship_context": brief description ("vendor/client", "contractor", "family", "financial advisor", etc.),
  "sentiment": "positive"|"neutral"|"negative"|"urgent",
  "key_decisions": array of decisions made (empty if none),
  "financial_amounts": array of dollar amounts mentioned (empty if none),
  "project": project name if this relates to a known project, null if not,
  "summary": 1-2 sentence summary of what this email is about and why it matters,

  "order": (ONLY include if this is an order/shipment/delivery/invoice email) {
    "vendor": retailer or carrier name (normalize: "Amazon" not "Amazon.com"),
    "item_description": main item(s),
    "items_list": array of individual items,
    "order_number": string or null,
    "amount": number or null (just the number, no $),
    "currency": "USD" or appropriate code,
    "estimated_delivery": "YYYY-MM-DD" or null,
    "actual_delivery": "YYYY-MM-DD" or null (only if confirming delivery happened),
    "tracking_number": string or null (UPS: "1Z...", FedEx: 12-22 digits, USPS: 20-22 digits),
    "tracking_carrier": "UPS"|"FedEx"|"USPS"|"DHL"|"OnTrac"|"LaserShip" or null,
    "tracking_url": full URL or null,
    "status": "ordered"|"shipped"|"in_transit"|"out_for_delivery"|"delivered",
    "email_type": "order_confirmation"|"shipping_notification"|"delivery_confirmation"|"return_confirmation"|"carrier_shipping_update"|"carrier_delivery_confirmation"|"invoice",
    "category": "personal"|"project"|"house"|"workshop"|"aviation"|"rental_property",
    "project": project name or null
  }
}`;

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You classify emails and extract structured information. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const d = await res.json();
  try {
    return JSON.parse(d.choices[0].message.content) as ClassificationResult;
  } catch {
    return { skip: false, type: "conversation", topics: ["parse_error"], summary: "Failed to parse LLM response" };
  }
}

// ─── Embedding ───────────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000) }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()).data[0].embedding;
}

// ─── Supabase Operations ────────────────────────────────────────────────────

async function supabaseQuery(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(options.headers as Record<string, string> || {}),
    },
  });
}

let fingerprintSupported: boolean | null = null;

async function insertThought(
  content: string, embedding: number[], metadata: Record<string, unknown>,
): Promise<{ ok: boolean; id?: string; duplicate?: boolean; error?: string }> {
  const fingerprint = await contentFingerprint(content);
  const row: Record<string, unknown> = { content, embedding, metadata };
  if (fingerprintSupported !== false) row.content_fingerprint = fingerprint;

  const res = await supabaseQuery("/thoughts", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });

  if (res.status === 409) return { ok: true, duplicate: true };

  if (!res.ok && fingerprintSupported === null) {
    const body = await res.text();
    if (body.includes("content_fingerprint")) {
      fingerprintSupported = false;
      delete row.content_fingerprint;
      const retry = await supabaseQuery("/thoughts", {
        method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row),
      });
      if (!retry.ok) return { ok: false, error: `HTTP ${retry.status}: ${await retry.text()}` };
      const data = await retry.json();
      return { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id };
    }
    return { ok: false, error: `HTTP ${res.status}: ${body}` };
  }

  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
  if (fingerprintSupported === null) fingerprintSupported = true;

  const data = await res.json();
  return { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id };
}

// ─── Project Lookup ──────────────────────────────────────────────────────────

async function lookupProjectId(projectName: string | null): Promise<string | null> {
  if (!projectName) return null;
  const res = await supabaseQuery(`/projects?name=ilike.${encodeURIComponent(projectName)}&select=id&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length > 0 ? rows[0].id : null;
}

// ─── People Upsert ───────────────────────────────────────────────────────────

async function upsertPerson(name: string, email: string): Promise<void> {
  if (!email) return;
  await supabaseQuery("/people", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ name: name || email, email, type: "contact" }),
  });
}

// ─── Todo Insert ─────────────────────────────────────────────────────────────

async function insertTodo(
  task: string,
  urgency: string,
  dueDate: string | null,
  projectName: string | null,
  thoughtId: string | null,
  emailDate: string,
): Promise<void> {
  const projectId = await lookupProjectId(projectName);
  const priority = urgency === "high" ? "high" : urgency === "low" ? "low" : "medium";

  // Auto-cancel todos from emails older than 30 days — they're historical
  const emailAge = Date.now() - new Date(emailDate).getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  const status = emailAge > thirtyDays ? "cancelled" : "open";

  const res = await supabaseQuery("/todos", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({
      title: task,
      status,
      priority,
      due_date: dueDate || null,
      project_id: projectId,
      area: inferArea(projectName),
      thought_id: thoughtId || null,
      metadata: {
        source: "gmail",
        project_name: projectName || null,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Todo insert failed: ${body}`);
  }
}

// ─── Order Upsert ────────────────────────────────────────────────────────────

interface OrderData {
  vendor: string;
  item_description: string;
  items_list: string[];
  order_number: string | null;
  amount: number | null;
  currency: string;
  estimated_delivery: string | null;
  actual_delivery: string | null;
  tracking_number: string | null;
  tracking_carrier: string | null;
  tracking_url: string | null;
  status: string;
  email_type: string;
  category: string;
  project: string | null;
}

async function findExistingOrder(
  orderNumber: string | null, vendor: string | null, trackingNumber: string | null,
): Promise<{ id: string; thought_id: string | null; status: string } | null> {
  if (orderNumber && vendor) {
    const res = await supabaseQuery(`/orders?order_number=eq.${encodeURIComponent(orderNumber)}&vendor=ilike.${encodeURIComponent(vendor)}&select=id,thought_id,status`);
    if (res.ok) { const rows = await res.json(); if (rows.length > 0) return rows[0]; }
  }
  if (orderNumber) {
    const res = await supabaseQuery(`/orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=id,thought_id,status`);
    if (res.ok) { const rows = await res.json(); if (rows.length > 0) return rows[0]; }
  }
  if (trackingNumber) {
    const res = await supabaseQuery(`/orders?tracking_number=eq.${encodeURIComponent(trackingNumber)}&select=id,thought_id,status`);
    if (res.ok) { const rows = await res.json(); if (rows.length > 0) return rows[0]; }
  }
  return null;
}

async function upsertOrder(
  order: OrderData, emailDate: string, emailId: string,
): Promise<{ ok: boolean; id?: string; action?: string; error?: string }> {
  // Normalize status to match DB constraint
  const statusMap: Record<string, string> = {
    "out for delivery": "out_for_delivery",
    "in transit": "in_transit",
    "on the way": "in_transit",
    "refunded": "returned",
    "refund": "returned",
    "return": "returned",
    "returning": "returned",
    "return initiated": "returned",
    "canceled": "cancelled",
    "canceled by buyer": "cancelled",
    "canceled by seller": "cancelled",
    "cancellation": "cancelled",
    "out_for_delivery": "out_for_delivery",
    "arrived": "delivered",
    "complete": "delivered",
    "completed": "delivered",
    "dispatched": "shipped",
    "label created": "ordered",
    "payment received": "ordered",
    "processing": "ordered",
    "confirmed": "ordered",
  };
  const normalized = statusMap[order.status?.toLowerCase()];
  if (normalized) order.status = normalized;
  const validStatuses = ["ordered", "shipped", "in_transit", "out_for_delivery", "delivered", "returned", "cancelled"];
  if (!validStatuses.includes(order.status)) {
    console.log(`   ⚠️  Unknown status "${order.status}" — defaulting to "ordered"`);
    order.status = "ordered";
  }

  const existing = await findExistingOrder(order.order_number, order.vendor, order.tracking_number);

  if (existing) {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const statusRank: Record<string, number> = { ordered: 0, shipped: 1, in_transit: 2, out_for_delivery: 3, delivered: 4, returned: 5, cancelled: 6 };
    if ((statusRank[order.status] ?? 0) > (statusRank[existing.status] ?? 0)) updates.status = order.status;
    if (order.tracking_number) {
      updates.tracking_number = order.tracking_number;
      if (order.tracking_carrier) updates.tracking_carrier = order.tracking_carrier;
      if (order.tracking_url) updates.tracking_url = order.tracking_url;
    }
    if (order.email_type === "delivery_confirmation" || order.email_type === "carrier_delivery_confirmation") {
      updates.actual_delivery = order.actual_delivery || emailDate.split("T")[0];
      updates.status = "delivered";
    }
    if (order.estimated_delivery) updates.estimated_delivery = order.estimated_delivery;
    if (order.amount) updates.amount = order.amount;

    const metaRes = await supabaseQuery(`/orders?id=eq.${existing.id}&select=metadata`);
    let existingMeta: Record<string, unknown> = {};
    if (metaRes.ok) { const rows = await metaRes.json(); if (rows.length > 0) existingMeta = rows[0].metadata || {}; }
    const emailHistory = (existingMeta.email_history as string[] || []);
    emailHistory.push(`${order.email_type}:${emailId}:${emailDate.split("T")[0]}`);
    updates.metadata = { ...existingMeta, email_history: emailHistory, last_email_type: order.email_type };

    const res = await supabaseQuery(`/orders?id=eq.${existing.id}`, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(updates),
    });
    if (!res.ok) return { ok: false, error: `Update failed: ${await res.text()}` };
    return { ok: true, id: existing.id, action: "updated" };
  }

  const projectId = await lookupProjectId(order.project);
  const orderRow: Record<string, unknown> = {
    item_description: order.item_description || `Package via ${order.vendor || "carrier"}`,
    vendor: order.vendor,
    order_number: order.order_number,
    order_date: emailDate.split("T")[0],
    estimated_delivery: order.estimated_delivery,
    actual_delivery: order.actual_delivery,
    amount: order.amount,
    currency: order.currency || "USD",
    status: order.status || "ordered",
    tracking_number: order.tracking_number,
    tracking_carrier: order.tracking_carrier,
    tracking_url: order.tracking_url,
    category: order.category || "personal",
    project: order.project,
    project_id: projectId,
    source: "gmail",
    source_email_id: emailId,
    metadata: { items_list: order.items_list, email_history: [`${order.email_type}:${emailId}:${emailDate.split("T")[0]}`], last_email_type: order.email_type },
  };

  const res = await supabaseQuery("/orders", {
    method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(orderRow),
  });
  if (res.status === 409) return { ok: true, id: "duplicate", action: "skipped" };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
  const data = await res.json();
  return { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id, action: "created" };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const creds = await loadCredentials();
  const tokenMgr = await createTokenManager(creds);
  const accessToken = await tokenMgr.getAccessToken();

  if (args.listLabels) {
    const labels = await listLabels(accessToken);
    console.log("\nGmail Labels:\n");
    for (const label of labels.sort((a, b) => a.name.localeCompare(b.name))) {
      const count = label.messagesTotal !== undefined ? ` (${label.messagesTotal})` : "";
      console.log(`  ${label.id.padEnd(30)} ${label.name}${count}`);
    }
    return;
  }

  const allLabels = await listLabels(accessToken);
  const labelMap = new Map<string, string>();
  for (const l of allLabels) labelMap.set(l.id, l.name);

  const query = windowToQuery(args.window);
  console.log(`\nFetching emails...`);
  console.log(`  Categories: ${args.categories.join(", ")}`);
  console.log(`  Window:     ${args.window}${query ? ` (${query})` : ""}`);
  console.log(`  Limit:      ${args.limit}`);
  console.log(`  Mode:       ${args.dryRun ? "DRY RUN" : args.ordersOnly ? "ORDERS ONLY" : "live"}`);
  if (args.skip > 0) console.log(`  Skip:       ${args.skip} (resuming)`);
  console.log();

  if (!args.dryRun) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required."); Deno.exit(1);
    }
    if (!OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY required."); Deno.exit(1);
    }
  }

  const syncLog = await loadSyncLog();
  const allRefs = await listMessages(accessToken, args.categories, query, args.limit + args.skip);
  const messageRefs = args.skip > 0 ? allRefs.slice(args.skip) : allRefs;

  if (args.skip > 0) console.log(`Fetched ${allRefs.length} total, skipping first ${args.skip}.`);
  console.log(`Processing ${messageRefs.length} messages.\n`);
  if (messageRefs.length === 0) return;

  let processed = 0, alreadyDone = 0, noiseSkipped = 0, ingested = 0, errors = 0;
  let ordersCreated = 0, ordersUpdated = 0, totalWords = 0, classifyCalls = 0;

  for (let i = 0; i < messageRefs.length; i++) {
    const ref = messageRefs[i];
    const globalIdx = args.skip + i + 1;

    if (syncLog.ingested_ids[ref.id] || syncLog.skipped_ids[ref.id]) {
      alreadyDone++;
      continue;
    }

    try {
      const msg = await getMessage(await tokenMgr.getAccessToken(), ref.id);
      const subject = getHeader(msg, "Subject");
      const from = getHeader(msg, "From");
      const to = getHeader(msg, "To");
      const cc = getHeader(msg, "Cc");
      const date = new Date(parseInt(msg.internalDate)).toISOString();
      const { plain, html } = extractTextFromParts(msg.payload);
      let body = plain || htmlToText(html);

      if (!body.trim()) { noiseSkipped++; continue; }

      body = stripQuotedReplies(body);
      body = stripSignature(body);

      if (!body.trim() || body.split(/\s+/).filter((w) => w.length > 0).length < 5) {
        noiseSkipped++;
        continue;
      }

      const gmailCategory = (msg.labelIds || [])
        .find((l) => l.startsWith("CATEGORY_"))?.replace("CATEGORY_", "") || "UNKNOWN";

      console.log(`${globalIdx}. ${subject.slice(0, 70)}`);
      console.log(`   From: ${from.slice(0, 60)} | ${new Date(date).toLocaleDateString()} | [${gmailCategory}]`);

      const classification = await classifyAndExtract(subject, from, to, body, date, gmailCategory);
      classifyCalls++;

      if (classification.skip) {
        noiseSkipped++;
        syncLog.skipped_ids[ref.id] = new Date().toISOString();
        console.log(`   ⏭️  Skipped: ${classification.skip_reason || classification.type}`);
        console.log();
        continue;
      }

      processed++;
      const wc = body.split(/\s+/).filter((w) => w.length > 0).length;
      totalWords += wc;

      const typeIcon = classification.order ? "📦" :
        classification.type === "task" ? "✅" :
          classification.type === "scheduling" ? "📅" :
            classification.type === "decision" ? "⚖️" :
              classification.type === "follow_up" ? "🔄" : "💬";

      console.log(`   ${typeIcon} ${classification.type}: ${classification.summary || "(no summary)"}`);
      if (classification.topics?.length) console.log(`   Topics: ${classification.topics.join(", ")}`);
      if (classification.action_items?.length && !args.ordersOnly) {
        for (const ai of classification.action_items) {
          console.log(`   → TODO: ${ai.task}${ai.due_date ? ` (due ${ai.due_date})` : ""} [${ai.urgency}]`);
        }
      }
      if (classification.order) {
        const o = classification.order;
        console.log(`   📦 Order: ${o.vendor} — ${o.item_description} | $${o.amount || "?"} | ${o.status}`);
        if (o.tracking_number) console.log(`      Tracking: ${o.tracking_carrier || ""} ${o.tracking_number}`);
      }

      if (args.dryRun) {
        console.log();
        continue;
      }

      // ── ORDERS-ONLY MODE: process order if present, skip everything else ──
      if (args.ordersOnly) {
        if (classification.order) {
          try {
            const orderResult = await upsertOrder(classification.order, date, ref.id);
            if (orderResult.ok) {
              if (orderResult.action === "created") { ordersCreated++; console.log(`   📦 Order created`); }
              else if (orderResult.action === "updated") { ordersUpdated++; console.log(`   📦 Order updated`); }
              else console.log(`   📦 Order duplicate (skipped)`);
            } else {
              console.error(`   📦 Order error: ${orderResult.error}`);
            }
          } catch (orderErr) {
            console.error(`   📦 Order failed: ${orderErr}`);
          }
        }
        // Always mark processed so future full runs skip this email
        syncLog.skipped_ids[ref.id] = new Date().toISOString();
        ingested++;
        console.log();
        continue;
      }

      // ── FULL MODE: order emails go to orders table only, skip thought storage ──
      if (classification.order) {
        try {
          const orderResult = await upsertOrder(classification.order, date, ref.id);
          if (orderResult.ok) {
            if (orderResult.action === "created") { ordersCreated++; console.log(`   📦 Order created`); }
            else if (orderResult.action === "updated") { ordersUpdated++; console.log(`   📦 Order updated`); }
            else console.log(`   📦 Order duplicate (skipped)`);
          } else {
            console.error(`   📦 Order error: ${orderResult.error}`);
          }
        } catch (orderErr) {
          console.error(`   📦 Order failed: ${orderErr}`);
        }
        syncLog.skipped_ids[ref.id] = new Date().toISOString();
        ingested++;
        console.log();
        continue;
      }

      // ── Embed and store thought (non-order emails only) ───────────
      const header = `[Email from ${from} | To: ${to}${cc ? ` | CC: ${cc}` : ""} | Subject: ${subject} | Date: ${date}]`;
      const content = `${header}\n\n${body}`;

      const embedding = await getEmbedding(content);

      const metadata: Record<string, unknown> = {
        source: "gmail",
        gmail_id: ref.id,
        gmail_thread_id: ref.threadId,
        gmail_category: gmailCategory,
        from, to,
        cc: cc || undefined,
        direction: "inbound",
        contacts: [...parseEmailAddresses(from), ...parseEmailAddresses(to), ...parseEmailAddresses(cc)]
          .map(c => c.name ? `${c.name} <${c.email}>` : c.email),
        ...classification,
      };
      delete metadata.skip;
      delete metadata.skip_reason;
      delete metadata.people;
      delete metadata.order;

      // Tag Angel Flight emails for future flight-matching agent
      if (isAngelFlightBulkEmail(from, subject)) {
        metadata.angel_flight_type = "mission_availability";
        metadata.agent_target = "flight_matching_agent";
      }

      const thoughtResult = await insertThought(content, embedding, metadata);

      if (thoughtResult.ok) {
        ingested++;
        syncLog.ingested_ids[ref.id] = new Date().toISOString();
        const dupTag = thoughtResult.duplicate ? " (dup)" : "";
        console.log(`   → Stored${dupTag} [${ingested}/${messageRefs.length - alreadyDone} done]`);

        // ── Upsert contacts into people table ─────────────────────
        for (const contact of [...parseEmailAddresses(from), ...parseEmailAddresses(to), ...parseEmailAddresses(cc)]) {
          if (contact.email) await upsertPerson(contact.name, contact.email).catch(() => { });
        }

        // ── Write action items to todos table ─────────────────────
        const skipTodos = isAngelFlightBulkEmail(from, subject);
        if (classification.action_items?.length && thoughtResult.id && !skipTodos) {
          for (const ai of classification.action_items) {
            try {
              await insertTodo(
                ai.task,
                ai.urgency,
                ai.due_date || null,
                classification.project || null,
                thoughtResult.id,
                date,
              );
              console.log(`   ✅ TODO saved: ${ai.task.slice(0, 60)}`);
            } catch (todoErr) {
              console.error(`   ✅ TODO failed: ${todoErr}`);
            }
          }
        }

      } else {
        errors++;
        console.error(`   → ERROR: ${thoughtResult.error}`);
      }

      console.log();
      await new Promise((r) => setTimeout(r, 200));

      // Checkpoint every 10 emails
      if ((ingested + noiseSkipped) % 10 === 0 && (ingested + noiseSkipped) > 0) {
        syncLog.last_sync = new Date().toISOString();
        await saveSyncLog(syncLog);
        console.log(`   [Checkpoint saved]\n`);
      }

    } catch (err) {
      errors++;
      console.error(`\n   ⚠️  ERROR on ${globalIdx} (${ref.id}): ${err}`);
      console.error(`   Saving checkpoint and continuing...\n`);
      syncLog.last_sync = new Date().toISOString();
      await saveSyncLog(syncLog);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Final save
  if (!args.dryRun) {
    syncLog.last_sync = new Date().toISOString();
    await saveSyncLog(syncLog);
  }

  console.log("─".repeat(60));
  console.log("Summary:");
  console.log(`  Emails fetched:    ${messageRefs.length}`);
  if (alreadyDone > 0) console.log(`  Already processed: ${alreadyDone} (skipped)`);
  console.log(`  LLM classified:   ${classifyCalls}`);
  console.log(`  Noise skipped:    ${noiseSkipped}`);
  console.log(`  Meaningful:       ${processed}`);
  console.log(`  Total words:      ${totalWords.toLocaleString()}`);
  if (!args.dryRun) {
    console.log(`  Ingested:         ${ingested}`);
    console.log(`  Orders created:   ${ordersCreated}`);
    console.log(`  Orders updated:   ${ordersUpdated}`);
    console.log(`  Errors:           ${errors}`);
  }

  const classifyCost = classifyCalls * 0.00015;
  const embedCost = args.ordersOnly ? 0 : (totalWords / 750) * 0.00002;
  const totalCost = classifyCost + embedCost;
  console.log(`  Est. API cost:    $${totalCost.toFixed(4)} (classify: $${classifyCost.toFixed(4)}, embed: $${embedCost.toFixed(4)})`);
  if (args.ordersOnly) console.log(`  Mode: orders-only (no embedding cost)`);

  if (errors > 0) {
    console.log(`\n  ⚠️  ${errors} errors. Re-run to retry — processed emails are tracked in sync-log.`);
  }
}

main().catch((err) => { console.error("Fatal error:", err); Deno.exit(1); });
