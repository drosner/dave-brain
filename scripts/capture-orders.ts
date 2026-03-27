#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Open Brain — Order Tracker
 *
 * Captures orders from Gmail confirmation emails or manual input,
 * stores them in both the orders table (structured) and as thoughts
 * (semantic search) in your Open Brain.
 *
 * Usage:
 *   # Pull order confirmations from Gmail (last 7 days)
 *   deno run --allow-net --allow-read --allow-write --allow-env capture-orders.ts --from-gmail --window=7d
 *
 *   # Pull from Gmail, dry run
 *   deno run --allow-net --allow-read --allow-write --allow-env capture-orders.ts --from-gmail --dry-run --limit=10
 *
 *   # Manual order entry (interactive)
 *   deno run --allow-net --allow-read --allow-write --allow-env capture-orders.ts --manual
 *
 *   # Update tracking for an order
 *   deno run --allow-net --allow-read --allow-write --allow-env capture-orders.ts --update-tracking
 *
 *   # Show open orders
 *   deno run --allow-net --allow-read --allow-write --allow-env capture-orders.ts --open-orders
 *
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
 * For Gmail mode: credentials.json + token.json (same as pull-gmail.ts)
 */

// ─── Configuration ───────────────────────────────────────────────────────────

const SCRIPT_DIR = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const CREDENTIALS_PATH = `${SCRIPT_DIR}credentials.json`;
const TOKEN_PATH = `${SCRIPT_DIR}token.json`;

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") || "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// ─── CLI Parsing ────────────────────────────────────────────────────────────

interface CliArgs {
  fromGmail: boolean;
  manual: boolean;
  updateTracking: boolean;
  openOrders: boolean;
  dryRun: boolean;
  window: string;
  limit: number;
}

function parseArgs(): CliArgs {
  const args: CliArgs = {
    fromGmail: false,
    manual: false,
    updateTracking: false,
    openOrders: false,
    dryRun: false,
    window: "7d",
    limit: 50,
  };

  for (const arg of Deno.args) {
    if (arg === "--from-gmail") args.fromGmail = true;
    else if (arg === "--manual") args.manual = true;
    else if (arg === "--update-tracking") args.updateTracking = true;
    else if (arg === "--open-orders") args.openOrders = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--window=")) args.window = arg.split("=")[1];
    else if (arg.startsWith("--limit=")) args.limit = parseInt(arg.split("=")[1], 10);
  }

  return args;
}

// ─── OAuth (reuses token.json from pull-gmail.ts) ───────────────────────────

interface OAuthCredentials {
  installed: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

async function loadCredentials(): Promise<OAuthCredentials> {
  const text = await Deno.readTextFile(CREDENTIALS_PATH);
  return JSON.parse(text);
}

async function loadToken(): Promise<TokenData | null> {
  try {
    const text = await Deno.readTextFile(TOKEN_PATH);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function saveToken(token: TokenData): Promise<void> {
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function refreshAccessToken(
  creds: OAuthCredentials,
  token: TokenData,
): Promise<TokenData> {
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
    access_token: data.access_token,
    refresh_token: token.refresh_token,
    token_type: data.token_type,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  await saveToken(updated);
  return updated;
}

async function getAccessToken(): Promise<string> {
  const creds = await loadCredentials();
  const token = await loadToken();
  if (!token) {
    console.error("No token.json found. Run pull-gmail.ts first to authorize.");
    Deno.exit(1);
  }
  if (Date.now() < token.expiry_date - 60_000) {
    return token.access_token;
  }
  const refreshed = await refreshAccessToken(creds, token);
  return refreshed.access_token;
}

// ─── Gmail Helpers ──────────────────────────────────────────────────────────

async function gmailFetch(accessToken: string, path: string): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error ${res.status}: ${body}`);
  }
  return res.json();
}

function windowToQuery(window: string): string {
  const now = new Date();
  let after: Date;
  switch (window) {
    case "24h": after = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
    case "7d": after = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case "30d": after = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
    case "90d": after = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); break;
    case "1y": after = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
    case "all": return "";
    default: console.error(`Unknown window: ${window}`); Deno.exit(1);
  }
  const y = after.getFullYear();
  const m = String(after.getMonth() + 1).padStart(2, "0");
  const d = String(after.getDate()).padStart(2, "0");
  return `after:${y}/${m}/${d}`;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4;
  const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

interface GmailMessagePart {
  mimeType: string;
  body: { data?: string; size: number };
  parts?: GmailMessagePart[];
  headers?: { name: string; value: string }[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  payload: GmailMessagePart;
  internalDate: string;
}

function extractTextFromParts(part: GmailMessagePart): { plain: string; html: string } {
  let plain = "";
  let html = "";
  if (part.mimeType === "text/plain" && part.body.data) plain += decodeBase64Url(part.body.data);
  else if (part.mimeType === "text/html" && part.body.data) html += decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const sub of part.parts) {
      const extracted = extractTextFromParts(sub);
      plain += extracted.plain;
      html += extracted.html;
    }
  }
  return { plain, html };
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getHeader(msg: GmailMessage, name: string): string {
  const headers = msg.payload.headers || [];
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// ─── Order Extraction via LLM ───────────────────────────────────────────────

interface ExtractedOrder {
  item_description: string;
  vendor: string;
  order_number: string | null;
  amount: number | null;
  currency: string;
  estimated_delivery: string | null;
  actual_delivery: string | null;
  tracking_number: string | null;
  tracking_carrier: string | null;
  tracking_url: string | null;
  category: string;
  project: string | null;
  items_list: string[];
  confidence: number;
  email_type: string;  // "order_confirmation", "shipping_notification", "delivery_confirmation", "return_confirmation"
  status: string;
}

async function extractOrderFromEmail(
  subject: string,
  from: string,
  body: string,
  date: string,
): Promise<ExtractedOrder | null> {
  const prompt = `Analyze this email and determine if it relates to a purchase, shipment, or delivery. This includes:
- Order confirmations from retailers (Amazon, Home Depot, etc.)
- Shipping notifications from retailers OR carriers (UPS, FedEx, USPS, DHL, OnTrac, LaserShip)
- Delivery confirmations from retailers OR carriers
- Return/refund confirmations

IMPORTANT: Emails directly from shipping carriers like UPS ("Your UPS Package was delivered"), FedEx ("FedEx Shipment Notification"), USPS ("Delivered"), and DHL ARE order-related. These are delivery/shipping status updates. Set is_order=true and confidence >= 0.8 for these.

If it's NOT related to any purchase/shipment activity, set confidence to 0.

Email details:
- Subject: ${subject}
- From: ${from}
- Date: ${date}
- Body: ${body.slice(0, 4000)}

Return JSON with:
- "is_order": boolean — is this related to a purchase, shipment, or delivery?
- "email_type": one of "order_confirmation", "shipping_notification", "delivery_confirmation", "return_confirmation", "carrier_shipping_update", "carrier_delivery_confirmation"
- "item_description": string — main item(s) if known from the email. For carrier-only emails where the item isn't mentioned, use "Package via [carrier]" (e.g. "Package via UPS")
- "items_list": array of individual items if listed (empty array if carrier email with no item details)
- "vendor": string — the RETAILER/STORE if known (e.g. "Amazon", "McMaster-Carr", "Adafruit", "Digikey", "Home Depot"). For carrier-only emails where the retailer isn't mentioned, use the carrier name (e.g. "UPS", "FedEx"). Normalize names: "Amazon" not "Amazon.com", "Home Depot" not "The Home Depot"
- "order_number": string or null — order/confirmation number if present. Strip prefixes like "Order #". For carrier emails, this may not be present — that's OK, we'll match on tracking number instead.
- "amount": number or null — total dollar amount (just the number, no $ sign). Only include if this email states the total.
- "currency": "USD" or appropriate currency code
- "estimated_delivery": "YYYY-MM-DD" or null — scheduled delivery date if mentioned
- "actual_delivery": "YYYY-MM-DD" or null — only if this confirms delivery already happened
- "tracking_number": string or null — CRITICAL: always extract this. UPS starts with "1Z", FedEx is usually 12-22 digits, USPS is 20-22 digits. Look for it in the body, subject, and any tracking links.
- "tracking_carrier": string or null — "UPS", "FedEx", "USPS", "DHL", "OnTrac", "LaserShip", etc.
- "tracking_url": string or null — full tracking URL if present in the email
- "status": the status THIS email represents: "ordered", "shipped", "in_transit", "out_for_delivery", or "delivered"
- "category": best fit from "personal", "project", "house", "workshop", "aviation", "rental_property". Default to "personal" if unclear.
- "project": string or null — if items seem related to a specific project, name it. null if unclear.
- "confidence": 0.0 to 1.0 — how confident this is a real order/shipment/delivery email

Confidence guide: carrier shipping/delivery emails = 0.9, retailer order confirmations = 0.9, retailer shipping notices = 0.85. Marketing, wishlists, abandoned carts, "recommended for you" = 0.`;

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
        { role: "system", content: "You extract order information from emails. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
    }),
  });

  const d = await res.json();
  try {
    const parsed = JSON.parse(d.choices[0].message.content);
    if (!parsed.is_order || parsed.confidence < 0.6) return null;
    return parsed as ExtractedOrder;
  } catch {
    return null;
  }
}

// ─── Supabase Operations ────────────────────────────────────────────────────

async function supabaseQuery(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(options.headers as Record<string, string> || {}),
  };
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...options, headers });
}

async function findExistingOrder(
  orderNumber: string | null,
  vendor: string | null,
  trackingNumber: string | null,
): Promise<{ id: string; thought_id: string | null; status: string } | null> {
  // First try exact match on order_number + vendor
  if (orderNumber && vendor) {
    const res = await supabaseQuery(
      `/orders?order_number=eq.${encodeURIComponent(orderNumber)}&vendor=ilike.${encodeURIComponent(vendor)}&select=id,thought_id,status`,
    );
    if (res.ok) {
      const rows = await res.json();
      if (rows.length > 0) return rows[0];
    }
  }

  // Fallback: match on order_number alone (vendor name might vary between emails)
  if (orderNumber) {
    const res = await supabaseQuery(
      `/orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=id,thought_id,status`,
    );
    if (res.ok) {
      const rows = await res.json();
      if (rows.length > 0) return rows[0];
    }
  }

  // Fallback: match on tracking_number (carrier emails like UPS/FedEx won't have order numbers)
  if (trackingNumber) {
    const res = await supabaseQuery(
      `/orders?tracking_number=eq.${encodeURIComponent(trackingNumber)}&select=id,thought_id,status`,
    );
    if (res.ok) {
      const rows = await res.json();
      if (rows.length > 0) return rows[0];
    }
  }

  return null;
}

async function upsertOrder(
  order: ExtractedOrder,
  emailDate: string,
  emailId: string,
): Promise<{ ok: boolean; id?: string; action?: string; error?: string }> {
  const existing = await findExistingOrder(order.order_number, order.vendor, order.tracking_number);

  if (existing) {
    // Update existing order with new info from this email
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    // Only upgrade status, never downgrade (delivered > in_transit > shipped > ordered)
    const statusRank: Record<string, number> = { ordered: 0, shipped: 1, in_transit: 2, out_for_delivery: 3, delivered: 4, returned: 5, cancelled: 6 };
    const newRank = statusRank[order.status] ?? 0;
    const existingRank = statusRank[existing.status] ?? 0;
    if (newRank > existingRank) {
      updates.status = order.status;
    }

    // Add tracking info if we didn't have it
    if (order.tracking_number) {
      updates.tracking_number = order.tracking_number;
      if (order.tracking_carrier) updates.tracking_carrier = order.tracking_carrier;
      if (order.tracking_url) updates.tracking_url = order.tracking_url;
    }

    // Add delivery date if this is a delivery confirmation (from retailer OR carrier)
    if (order.email_type === "delivery_confirmation" || order.email_type === "carrier_delivery_confirmation") {
      updates.actual_delivery = order.actual_delivery || emailDate.split("T")[0];
      updates.status = "delivered";
    }

    // Add estimated delivery if we didn't have it
    if (order.estimated_delivery) {
      updates.estimated_delivery = order.estimated_delivery;
    }

    // Add amount if we didn't have it (shipping emails sometimes don't include price)
    if (order.amount) {
      updates.amount = order.amount;
    }

    // Track which emails contributed to this order
    const metaRes = await supabaseQuery(`/orders?id=eq.${existing.id}&select=metadata`);
    let existingMeta: Record<string, unknown> = {};
    if (metaRes.ok) {
      const rows = await metaRes.json();
      if (rows.length > 0) existingMeta = rows[0].metadata || {};
    }
    const emailHistory = (existingMeta.email_history as string[] || []);
    emailHistory.push(`${order.email_type}:${emailId}:${emailDate.split("T")[0]}`);
    updates.metadata = { ...existingMeta, email_history: emailHistory, last_email_type: order.email_type };

    const res = await supabaseQuery(`/orders?id=eq.${existing.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const body = await res.text();
      return { ok: false, error: `Update failed: ${body}` };
    }

    return { ok: true, id: existing.id, action: "updated" };
  }

  // No existing order — insert new
  const orderRow: Record<string, unknown> = {
    item_description: order.item_description,
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
    source: "gmail",
    source_email_id: emailId,
    metadata: {
      items_list: order.items_list,
      email_history: [`${order.email_type}:${emailId}:${emailDate.split("T")[0]}`],
      last_email_type: order.email_type,
    },
  };

  const res = await supabaseQuery("/orders", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(orderRow),
  });

  if (res.status === 409) {
    return { ok: true, id: "duplicate", action: "skipped" };
  }

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${body}` };
  }

  const data = await res.json();
  return { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id, action: "created" };
}

// Keep simple insert for manual entry
async function insertOrder(order: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await supabaseQuery("/orders", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(order),
  });

  if (res.status === 409) {
    return { ok: true, id: "duplicate" };
  }

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${body}` };
  }

  const data = await res.json();
  return { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id };
}

async function insertThought(content: string, metadata: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> {
  // Get embedding
  const embRes = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: content.slice(0, 8000),
    }),
  });
  if (!embRes.ok) {
    const msg = await embRes.text().catch(() => "");
    return { ok: false, error: `Embedding failed: ${embRes.status} ${msg}` };
  }
  const embData = await embRes.json();
  const embedding = embData.data[0].embedding;

  const row = {
    content,
    embedding,
    metadata: { ...metadata, source: "order_tracker" },
  };

  const res = await supabaseQuery("/thoughts", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `HTTP ${res.status}: ${body}` };
  }

  const data = await res.json();
  return { ok: true, id: Array.isArray(data) ? data[0]?.id : data?.id };
}

async function getOpenOrders(): Promise<void> {
  const res = await supabaseQuery("/open_orders?select=*");
  if (!res.ok) {
    console.error("Failed to fetch open orders:", await res.text());
    return;
  }
  const orders = await res.json();

  if (orders.length === 0) {
    console.log("\nNo open orders.\n");
    return;
  }

  console.log(`\n${"─".repeat(80)}`);
  console.log(`  OPEN ORDERS (${orders.length})`);
  console.log(`${"─".repeat(80)}\n`);

  for (const o of orders) {
    const status = o.status.toUpperCase().padEnd(12);
    const amount = o.amount ? `$${Number(o.amount).toFixed(2)}` : "—";
    const project = o.project ? `[${o.project}]` : "";
    const delivery = o.estimated_delivery || "no ETA";
    const tracking = o.tracking_number ? `  📦 ${o.tracking_carrier || ""} ${o.tracking_number}` : "";

    console.log(`  ${status} ${o.item_description}`);
    console.log(`             ${o.vendor || "unknown vendor"} | ${amount} | ETA: ${delivery} ${project}`);
    if (tracking) console.log(`            ${tracking}`);
    console.log();
  }
}

// ─── Gmail Order Ingestion ──────────────────────────────────────────────────

async function pullOrdersFromGmail(args: CliArgs): Promise<void> {
  const accessToken = await getAccessToken();

  // Search for order-related emails
  const timeQuery = windowToQuery(args.window);
  const orderQuery = `(subject:order OR subject:confirmation OR subject:shipped OR subject:delivered OR subject:tracking OR subject:"your order" OR subject:"order confirmed" OR subject:"your package" OR subject:"package delivered" OR subject:"out for delivery" OR subject:"in transit" OR from:ship-confirm OR from:auto-confirm OR from:ups.com OR from:fedex.com OR from:usps.com OR from:dhl.com OR from:ontrac.com OR from:lasership.com OR from:amazon.com)`;
  const fullQuery = timeQuery ? `${orderQuery} ${timeQuery}` : orderQuery;

  console.log(`\nSearching Gmail for order emails...`);
  console.log(`  Window: ${args.window}`);
  console.log(`  Limit:  ${args.limit}`);
  console.log(`  Mode:   ${args.dryRun ? "DRY RUN" : "live"}\n`);

  // List messages
  let path = `/messages?maxResults=${Math.min(100, args.limit)}&q=${encodeURIComponent(fullQuery)}`;
  const data = (await gmailFetch(accessToken, path)) as { messages?: { id: string; threadId: string }[] };

  if (!data.messages || data.messages.length === 0) {
    console.log("No order-related emails found.\n");
    return;
  }

  const messages = data.messages.slice(0, args.limit);
  console.log(`Found ${messages.length} potential order emails.\n`);

  let extracted = 0;
  let skipped = 0;
  let created = 0;
  let updated = 0;
  let errors = 0;

  for (const ref of messages) {
    const msg = (await gmailFetch(accessToken, `/messages/${ref.id}?format=full`)) as GmailMessage;
    const subject = getHeader(msg, "Subject");
    const from = getHeader(msg, "From");
    const date = new Date(parseInt(msg.internalDate)).toISOString();
    const { plain, html } = extractTextFromParts(msg.payload);
    const body = plain || htmlToText(html);

    if (!body.trim()) {
      skipped++;
      continue;
    }

    console.log(`Analyzing: ${subject.slice(0, 70)}...`);

    const order = await extractOrderFromEmail(subject, from, body, date);

    if (!order) {
      console.log(`   -> Not an order (skipped)\n`);
      skipped++;
      continue;
    }

    extracted++;
    const emailType = order.email_type || "unknown";
    console.log(`   -> [${emailType}] ${order.vendor}: ${order.item_description}`);
    console.log(`      ${order.amount ? "$" + order.amount : "no amount"} | ${order.status || "ordered"} | order#: ${order.order_number || "none"} | confidence: ${order.confidence}`);
    if (order.project) console.log(`      Project: ${order.project}`);
    if (order.tracking_number) console.log(`      Tracking: ${order.tracking_carrier || ""} ${order.tracking_number}`);

    if (args.dryRun) {
      console.log();
      continue;
    }

    // Upsert: create new order or update existing one
    const orderResult = await upsertOrder(order, date, ref.id);

    if (orderResult.ok) {
      if (orderResult.action === "updated") {
        updated++;
        console.log(`   -> Updated existing order (status/tracking)`);
      } else if (orderResult.action === "skipped") {
        console.log(`   -> Duplicate email (skipped)`);
      } else {
        // New order — also create a thought for semantic search
        const thoughtContent = `[Order from ${order.vendor}] ${order.item_description}` +
          (order.amount ? ` — $${order.amount}` : "") +
          (order.project ? ` | Project: ${order.project}` : "") +
          (order.tracking_number ? ` | Tracking: ${order.tracking_carrier || ""} ${order.tracking_number}` : "") +
          `\n\nOrdered: ${date.split("T")[0]}` +
          (order.estimated_delivery ? ` | ETA: ${order.estimated_delivery}` : "") +
          (order.items_list?.length > 1 ? `\nItems: ${order.items_list.join(", ")}` : "");

        const thoughtMeta: Record<string, unknown> = {
          type: "order",
          vendor: order.vendor,
          order_number: order.order_number,
          amount: order.amount,
          project: order.project,
          category: order.category,
          topics: [order.vendor?.toLowerCase(), order.category, order.project].filter(Boolean),
          order_id: orderResult.id,
        };

        const thoughtResult = await insertThought(thoughtContent, thoughtMeta);

        if (thoughtResult.ok) {
          if (thoughtResult.id && orderResult.id) {
            await supabaseQuery(`/orders?id=eq.${orderResult.id}`, {
              method: "PATCH",
              body: JSON.stringify({ thought_id: thoughtResult.id }),
            });
          }
          created++;
          console.log(`   -> New order created (orders table + thoughts)`);
        } else {
          created++;
          console.log(`   -> New order created (thought failed: ${thoughtResult.error})`);
        }
      }
    } else {
      errors++;
      console.error(`   -> ERROR: ${orderResult.error}`);
    }

    console.log();
    await new Promise((r) => setTimeout(r, 300));
  }

  // Summary
  console.log("─".repeat(60));
  console.log("Summary:");
  console.log(`  Emails analyzed:  ${messages.length}`);
  console.log(`  Orders found:     ${extracted}`);
  console.log(`  Skipped:          ${skipped}`);
  if (!args.dryRun) {
    console.log(`  New orders:       ${created}`);
    console.log(`  Updated orders:   ${updated}`);
    console.log(`  Errors:           ${errors}`);
  }
}

// ─── Manual Entry ───────────────────────────────────────────────────────────

async function manualEntry(): Promise<void> {
  const prompt = (msg: string): string => {
    const buf = new Uint8Array(1024);
    Deno.stdout.writeSync(new TextEncoder().encode(msg));
    const n = Deno.stdin.readSync(buf);
    return new TextDecoder().decode(buf.subarray(0, n || 0)).trim();
  };

  console.log("\n─── Manual Order Entry ───\n");

  const item = prompt("Item description: ");
  if (!item) { console.log("Cancelled."); return; }

  const vendor = prompt("Vendor (e.g. Amazon, Home Depot): ");
  const orderNum = prompt("Order number (or Enter to skip): ");
  const amountStr = prompt("Amount in $ (or Enter to skip): ");
  const amount = amountStr ? parseFloat(amountStr) : null;
  const trackingNum = prompt("Tracking number (or Enter to skip): ");
  const carrier = trackingNum ? prompt("Carrier (UPS/FedEx/USPS/DHL): ") : "";
  const project = prompt("Project name (or Enter for none): ");
  const categoryInput = prompt("Category (personal/project/house/workshop/aviation/rental_property) [personal]: ");
  const category = categoryInput || "personal";

  const orderRow: Record<string, unknown> = {
    item_description: item,
    vendor: vendor || null,
    order_number: orderNum || null,
    order_date: new Date().toISOString().split("T")[0],
    amount,
    status: "ordered",
    tracking_number: trackingNum || null,
    tracking_carrier: carrier || null,
    category,
    project: project || null,
    source: "manual",
  };

  console.log("\nSaving...");

  const orderResult = await insertOrder(orderRow);
  if (!orderResult.ok) {
    console.error(`Failed to save order: ${orderResult.error}`);
    return;
  }

  // Also store as thought
  const thoughtContent = `[Order from ${vendor || "unknown"}] ${item}` +
    (amount ? ` — $${amount}` : "") +
    (project ? ` | Project: ${project}` : "") +
    (trackingNum ? ` | Tracking: ${carrier} ${trackingNum}` : "");

  const thoughtMeta: Record<string, unknown> = {
    type: "order",
    vendor,
    order_number: orderNum || null,
    amount,
    project: project || null,
    category,
    topics: [vendor?.toLowerCase(), category, project].filter(Boolean),
    order_id: orderResult.id,
  };

  const thoughtResult = await insertThought(thoughtContent, thoughtMeta);

  if (thoughtResult.ok && orderResult.id) {
    await supabaseQuery(`/orders?id=eq.${orderResult.id}`, {
      method: "PATCH",
      body: JSON.stringify({ thought_id: thoughtResult.id }),
    });
  }

  console.log(`\n✅ Order saved: ${item}`);
  if (orderResult.id) console.log(`   Order ID: ${orderResult.id}`);
  console.log();
}

// ─── Update Tracking ────────────────────────────────────────────────────────

async function updateTracking(): Promise<void> {
  // Show open orders first
  const res = await supabaseQuery("/open_orders?select=*");
  if (!res.ok) {
    console.error("Failed to fetch open orders:", await res.text());
    return;
  }
  const orders = await res.json();

  if (orders.length === 0) {
    console.log("\nNo open orders to update.\n");
    return;
  }

  console.log("\nOpen orders:\n");
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    console.log(`  ${i + 1}. [${o.status}] ${o.item_description} (${o.vendor || "?"})`);
  }

  const prompt = (msg: string): string => {
    const buf = new Uint8Array(1024);
    Deno.stdout.writeSync(new TextEncoder().encode(msg));
    const n = Deno.stdin.readSync(buf);
    return new TextDecoder().decode(buf.subarray(0, n || 0)).trim();
  };

  const choice = parseInt(prompt("\nWhich order to update? (number): "), 10);
  if (isNaN(choice) || choice < 1 || choice > orders.length) {
    console.log("Invalid selection.");
    return;
  }

  const order = orders[choice - 1];
  console.log(`\nUpdating: ${order.item_description}\n`);

  const newStatus = prompt("New status (ordered/shipped/in_transit/delivered/returned/cancelled): ");
  const trackingNum = prompt("Tracking number (Enter to keep current): ");
  const carrier = trackingNum ? prompt("Carrier (UPS/FedEx/USPS/DHL): ") : "";

  const updates: Record<string, unknown> = {};
  if (newStatus) updates.status = newStatus;
  if (trackingNum) updates.tracking_number = trackingNum;
  if (carrier) updates.tracking_carrier = carrier;
  if (newStatus === "delivered") updates.actual_delivery = new Date().toISOString().split("T")[0];

  if (Object.keys(updates).length === 0) {
    console.log("Nothing to update.");
    return;
  }

  const updateRes = await supabaseQuery(`/orders?id=eq.${order.id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });

  if (updateRes.ok) {
    console.log(`\n✅ Updated: ${order.item_description} -> ${newStatus || order.status}`);
  } else {
    console.error(`Failed: ${await updateRes.text()}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
    Deno.exit(1);
  }

  if (args.openOrders) {
    await getOpenOrders();
    return;
  }

  if (args.updateTracking) {
    await updateTracking();
    return;
  }

  if (args.manual) {
    await manualEntry();
    return;
  }

  if (args.fromGmail) {
    if (!OPENROUTER_API_KEY) {
      console.error("OPENROUTER_API_KEY is required for Gmail order extraction.");
      Deno.exit(1);
    }
    await pullOrdersFromGmail(args);
    return;
  }

  // No mode specified — show help
  console.log(`
Open Brain — Order Tracker

Usage:
  capture-orders.ts --from-gmail [--window=7d] [--limit=50] [--dry-run]
      Pull order confirmations from Gmail

  capture-orders.ts --manual
      Manually enter an order

  capture-orders.ts --open-orders
      Show all open (undelivered) orders

  capture-orders.ts --update-tracking
      Update tracking/status for an open order

Environment variables required:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY
  `);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});
