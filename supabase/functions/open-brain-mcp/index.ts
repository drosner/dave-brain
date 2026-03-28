import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ─── Shared Helpers ───────────────────────────────────────────────────────────

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!r.ok) throw new Error(`Embeddings failed: ${r.status} ${await r.text().catch(() => "")}`);
  const d = await r.json();
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of flat strings like "Name <email>" or just "Name" (never objects)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 specific topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly present.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try { return JSON.parse(d.choices[0].message.content); }
  catch { return { topics: ["uncategorized"], type: "observation" }; }
}

function errResponse(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "open-brain", version: "2.0.0" });

// ══════════════════════════════════════════════════════════════════════════════
// THOUGHTS
// ══════════════════════════════════════════════════════════════════════════════

// Tool 1: search_thoughts
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description: "Semantic search across all captured thoughts. Use for questions about past decisions, conversations, notes, or anything previously saved to the brain.",
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
  },
  async ({ query, limit, threshold }) => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });
      if (error) return errResponse(`Search error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: `No thoughts found for "${query}".` }] };

      const results = data.map((t: { content: string; metadata: Record<string, unknown>; similarity: number; created_at: string }, i: number) => {
        const m = t.metadata || {};
        const parts = [
          `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
          `Captured: ${new Date(t.created_at).toLocaleDateString()}`,
          `Type: ${m.type || "unknown"}`,
        ];
        if (Array.isArray(m.topics) && m.topics.length) parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
        if (Array.isArray(m.people) && m.people.length) parts.push(`People: ${(m.people as string[]).join(", ")}`);
        if (Array.isArray(m.action_items) && m.action_items.length) parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
        parts.push(`\n${t.content}`);
        return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `Found ${data.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// Tool 2: list_thoughts
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description: "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe("observation | task | idea | reference | person_note"),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe("Only thoughts from the last N days"),
    },
  },
  async ({ limit, type, topic, person, days }) => {
    try {
      let q = supabase.from("thoughts").select("content, metadata, created_at")
        .order("created_at", { ascending: false }).limit(limit);
      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }
      const { data, error } = await q;
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No thoughts found." }] };

      const results = data.map((t: { content: string; metadata: Record<string, unknown>; created_at: string }, i: number) => {
        const m = t.metadata || {};
        const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
        return `${i + 1}. [${new Date(t.created_at).toLocaleDateString()}] (${m.type || "??"}${tags ? " — " + tags : ""})\n   ${t.content.slice(0, 200)}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} thought(s):\n\n${results.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// Tool 3: thought_stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description: "Summary of all captured thoughts: totals, types, top topics, and people.",
    inputSchema: {},
  },
  async () => {
    try {
      const { count } = await supabase.from("thoughts").select("*", { count: "exact", head: true });
      const { data } = await supabase.from("thoughts").select("metadata, created_at").order("created_at", { ascending: false });

      const types: Record<string, number> = {};
      const topics: Record<string, number> = {};
      const people: Record<string, number> = {};

      for (const r of data || []) {
        const m = (r.metadata || {}) as Record<string, unknown>;
        if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
        if (Array.isArray(m.topics)) for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
        if (Array.isArray(m.people)) for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
      }

      const sort = (o: Record<string, number>): [string, number][] =>
        Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10);

      const lines = [
        `Total thoughts: ${count}`,
        data?.length ? `Date range: ${new Date(data[data.length - 1].created_at).toLocaleDateString()} → ${new Date(data[0].created_at).toLocaleDateString()}` : "",
        "", "Types:", ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
      ];
      if (Object.keys(topics).length) { lines.push("", "Top topics:"); sort(topics).forEach(([k, v]) => lines.push(`  ${k}: ${v}`)); }
      if (Object.keys(people).length) { lines.push("", "People mentioned:"); sort(people).forEach(([k, v]) => lines.push(`  ${k}: ${v}`)); }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// Tool 4: capture_thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a new thought to the Open Brain. Generates embedding + metadata automatically.",
    inputSchema: {
      content: z.string().describe("A clear standalone statement that will make sense when retrieved later by any AI"),
    },
  },
  async ({ content }) => {
    try {
      const [embedding, metadata] = await Promise.all([getEmbedding(content), extractMetadata(content)]);
      const { error } = await supabase.from("thoughts").insert({ content, embedding, metadata: { ...metadata, source: "mcp" } });
      if (error) return errResponse(`Failed to capture: ${error.message}`);

      const meta = metadata as Record<string, unknown>;
      let confirmation = `Captured as ${meta.type || "thought"}`;
      if (Array.isArray(meta.topics) && meta.topics.length) confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
      if (Array.isArray(meta.people) && meta.people.length) confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
      if (Array.isArray(meta.action_items) && meta.action_items.length) confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;

      return { content: [{ type: "text" as const, text: confirmation }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// ORDERS  (new)
// ══════════════════════════════════════════════════════════════════════════════

// Tool 5: list_orders
server.registerTool(
  "list_orders",
  {
    title: "List Orders",
    description: "List orders with optional filters. Use for 'what am I waiting on?', 'show open orders', 'what did I order from Amazon?', 'orders for the pool house project', etc.",
    inputSchema: {
      status: z.string().optional().describe("ordered | shipped | in_transit | out_for_delivery | delivered | returned | cancelled. Omit for all."),
      vendor: z.string().optional().describe("Filter by vendor name (partial match)"),
      project: z.string().optional().describe("Filter by project name (partial match on text field)"),
      category: z.string().optional().describe("personal | project | house | workshop | aviation | rental_property"),
      limit: z.number().optional().default(20),
      open_only: z.boolean().optional().default(false).describe("If true, only show undelivered orders (uses open_orders view)"),
    },
  },
  async ({ status, vendor, project, category, limit, open_only }) => {
    try {
      let q;
      if (open_only) {
        // Uses the open_orders view you already have
        q = supabase.from("open_orders").select("*").limit(limit);
      } else {
        q = supabase.from("orders")
          .select("id, item_description, vendor, order_number, order_date, estimated_delivery, actual_delivery, amount, currency, status, tracking_number, tracking_carrier, category, project, project_id")
          .order("order_date", { ascending: false })
          .limit(limit);
        if (status) q = q.eq("status", status);
        if (vendor) q = q.ilike("vendor", `%${vendor}%`);
        if (project) q = q.ilike("project", `%${project}%`);
        if (category) q = q.eq("category", category);
      }

      const { data, error } = await q;
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No orders found." }] };

      const lines = data.map((o: Record<string, unknown>) => {
        const status = String(o.status || "?").toUpperCase().padEnd(14);
        const amount = o.amount ? `$${Number(o.amount).toFixed(2)}` : "—";
        const eta = o.estimated_delivery || o.actual_delivery || "no ETA";
        const project = o.project ? ` [${o.project}]` : "";
        const tracking = o.tracking_number ? `\n     📦 ${o.tracking_carrier || ""} ${o.tracking_number}` : "";
        return `${status} ${o.item_description}\n     ${o.vendor || "?"} | ${amount} | ${eta}${project}${tracking}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} order(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// Tool 6: search_orders
server.registerTool(
  "search_orders",
  {
    title: "Search Orders",
    description: "Search orders by item description, vendor, or order number. Use for 'did I order X?', 'find the McMaster order', 'what was that Adafruit order?'",
    inputSchema: {
      query: z.string().describe("Search term — matched against item_description, vendor, and order_number"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, limit }) => {
    try {
      // Search item_description and vendor with ilike
      const { data, error } = await supabase
        .from("orders")
        .select("id, item_description, vendor, order_number, order_date, amount, status, tracking_number, tracking_carrier, estimated_delivery, project, category")
        .or(`item_description.ilike.%${query}%,vendor.ilike.%${query}%,order_number.ilike.%${query}%`)
        .order("order_date", { ascending: false })
        .limit(limit);

      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: `No orders found matching "${query}".` }] };

      const lines = data.map((o: Record<string, unknown>, i: number) => {
        const amount = o.amount ? `$${Number(o.amount).toFixed(2)}` : "—";
        const project = o.project ? ` [${o.project}]` : "";
        const tracking = o.tracking_number ? ` | ${o.tracking_carrier || ""} ${o.tracking_number}` : "";
        return `${i + 1}. [${o.status}] ${o.item_description}\n   ${o.vendor || "?"} | ${amount} | ${o.order_date}${project}${tracking}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} order(s) matching "${query}":\n\n${lines.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// PROJECTS  (new)
// ══════════════════════════════════════════════════════════════════════════════

// Tool 7: list_projects
server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List all projects with status, budget, and spend. Use for 'what projects are active?', 'what's the pool house budget?', 'show me all workshop projects'.",
    inputSchema: {
      status: z.string().optional().describe("active | backlog | complete | on_hold. Omit for all."),
      category: z.string().optional().describe("house | workshop | aviation | tech | wine | rental_property"),
    },
  },
  async ({ status, category }) => {
    try {
      // Join against project_spend view if available, else fallback to projects table
      let q = supabase
        .from("projects")
        .select("id, name, status, category, description, location, budget, started_at, target_date, notes")
        .order("status", { ascending: true })
        .order("name", { ascending: true });

      if (status) q = q.eq("status", status);
      if (category) q = q.eq("category", category);

      const { data, error } = await q;
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No projects found." }] };

      // Fetch spend per project from project_spend view
      const { data: spendData } = await supabase.from("project_spend").select("project, total_spend, order_count");
      const spendMap: Record<string, { total_spend: number; order_count: number }> = {};
      for (const s of spendData || []) spendMap[s.project] = s;

      const lines = data.map((p: Record<string, unknown>) => {
        const budget = p.budget ? `Budget: $${Number(p.budget).toFixed(0)}` : "No budget set";
        const spend = spendMap[p.name as string];
        const spendStr = spend ? `  Spent: $${Number(spend.total_spend).toFixed(0)} (${spend.order_count} orders)` : "";
        const loc = p.location ? `  Location: ${p.location}` : "";
        const eta = p.target_date ? `  Target: ${p.target_date}` : "";
        const desc = p.description ? `\n  ${p.description}` : "";
        return `▸ [${String(p.status).toUpperCase()}] ${p.name}${p.category ? ` (${p.category})` : ""}\n  ${budget}${spendStr}${loc}${eta}${desc}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} project(s):\n\n${lines.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// Tool 8: get_project
server.registerTool(
  "get_project",
  {
    title: "Get Project Detail",
    description: "Full details for a single project including its orders and related thoughts. Use for 'tell me everything about the pool house project'.",
    inputSchema: {
      name: z.string().describe("Project name (partial match ok)"),
    },
  },
  async ({ name }) => {
    try {
      // Find project
      const { data: projects, error: pErr } = await supabase
        .from("projects")
        .select("*")
        .ilike("name", `%${name}%`)
        .limit(1);

      if (pErr) return errResponse(`Error: ${pErr.message}`);
      if (!projects?.length) return { content: [{ type: "text" as const, text: `No project found matching "${name}".` }] };

      const p = projects[0];
      const lines: string[] = [
        `Project: ${p.name}`,
        `Status:  ${p.status}`,
        p.category ? `Category: ${p.category}` : "",
        p.location ? `Location: ${p.location}` : "",
        p.description ? `\n${p.description}` : "",
        p.budget ? `Budget: $${Number(p.budget).toFixed(0)}` : "",
        p.started_at ? `Started: ${p.started_at}` : "",
        p.target_date ? `Target:  ${p.target_date}` : "",
        p.notes ? `\nNotes: ${p.notes}` : "",
      ].filter(Boolean);

      // Fetch orders for this project (by project_id FK or legacy text field)
      const { data: orders } = await supabase
        .from("orders")
        .select("item_description, vendor, amount, status, order_date, estimated_delivery")
        .or(`project_id.eq.${p.id},project.ilike.%${p.name}%`)
        .order("order_date", { ascending: false })
        .limit(20);

      if (orders?.length) {
        lines.push(`\nOrders (${orders.length}):`);
        for (const o of orders) {
          const amt = o.amount ? `$${Number(o.amount).toFixed(2)}` : "—";
          lines.push(`  [${o.status}] ${o.item_description} — ${o.vendor || "?"} ${amt}`);
        }
        const totalSpend = orders.reduce((sum: number, o: Record<string, unknown>) => sum + (Number(o.amount) || 0), 0);
        lines.push(`  Total spend: $${totalSpend.toFixed(2)}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// TODOS  (new — requires migration 003)
// ══════════════════════════════════════════════════════════════════════════════

// Tool 9: list_todos
server.registerTool(
  "list_todos",
  {
    title: "List Todos",
    description: "List open todos/tasks. Use for 'what do I need to do?', 'show my aviation tasks', 'what's due this week?'",
    inputSchema: {
      area: z.string().optional().describe("Filter by area: house | workshop | aviation | personal | work | rental_property"),
      project: z.string().optional().describe("Filter by project name (partial match)"),
      due_before: z.string().optional().describe("YYYY-MM-DD — only tasks due on or before this date"),
      include_done: z.boolean().optional().default(false),
      limit: z.number().optional().default(25),
    },
  },
  async ({ area, project, due_before, include_done, limit }) => {
    try {
      let q = supabase
        .from("todos")
        .select("id, title, notes, area, status, priority, due_date, created_at, project_id")
        .order("due_date", { ascending: true })
        .order("priority", { ascending: false })
        .limit(limit);

      if (!include_done) q = q.neq("status", "done");
      if (area) q = q.eq("area", area);
      if (due_before) q = q.lte("due_date", due_before);

      // project filter: look up project_id first
      if (project) {
        const { data: pRows } = await supabase.from("projects").select("id").ilike("name", `%${project}%`).limit(1);
        if (pRows?.[0]) q = q.eq("project_id", pRows[0].id);
      }

      const { data, error } = await q;
      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: "No todos found." }] };

      const lines = data.map((t: Record<string, unknown>, i: number) => {
        const due = t.due_date ? ` | Due: ${t.due_date}` : "";
        const area = t.area ? ` [${t.area}]` : "";
        const prio = t.priority ? ` (${t.priority})` : "";
        const note = t.notes ? `\n     ${String(t.notes).slice(0, 100)}` : "";
        return `${i + 1}. [${t.status}] ${t.title}${area}${prio}${due}${note}`;
      });

      return { content: [{ type: "text" as const, text: `${data.length} todo(s):\n\n${lines.join("\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// Tool 10: add_todo
server.registerTool(
  "add_todo",
  {
    title: "Add Todo",
    description: "Add a new task/todo to the brain. Use when the user says 'remind me to X', 'add a task for Y', 'I need to do Z'.",
    inputSchema: {
      title: z.string().describe("Task title"),
      area: z.string().optional().describe("house | workshop | aviation | personal | work | rental_property"),
      project: z.string().optional().describe("Project name to link this task to"),
      due_date: z.string().optional().describe("YYYY-MM-DD"),
      priority: z.string().optional().describe("high | medium | low"),
      notes: z.string().optional(),
    },
  },
  async ({ title, area, project, due_date, priority, notes }) => {
    try {
      let project_id: string | null = null;
      if (project) {
        const { data: pRows } = await supabase.from("projects").select("id").ilike("name", `%${project}%`).limit(1);
        project_id = pRows?.[0]?.id || null;
      }

      const row: Record<string, unknown> = {
        title,
        status: "open",
        area: area || null,
        due_date: due_date || null,
        priority: priority || "medium",
        notes: notes || null,
        project_id,
      };

      const { data, error } = await supabase.from("todos").insert(row).select("id").single();
      if (error) return errResponse(`Failed to add todo: ${error.message}`);

      return { content: [{ type: "text" as const, text: `Todo added: "${title}"${project_id ? ` (linked to project)` : ""}${due_date ? ` | Due: ${due_date}` : ""} [id: ${data.id}]` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// PEOPLE  (new — requires migration 002)
// ══════════════════════════════════════════════════════════════════════════════

// Tool 11: search_people
server.registerTool(
  "search_people",
  {
    title: "Search People",
    description: "Look up people in the brain — contacts, collaborators, vendors. Use for 'who is X?', 'find the contractor for the pool house', 'what do I know about Jane?'",
    inputSchema: {
      query: z.string().describe("Name, email, company, or role to search for"),
      limit: z.number().optional().default(10),
    },
  },
  async ({ query, limit }) => {
    try {
      const { data, error } = await supabase
        .from("people")
        .select("id, name, email, phone, company, role, notes, metadata")
        .or(`name.ilike.%${query}%,email.ilike.%${query}%,company.ilike.%${query}%,role.ilike.%${query}%`)
        .limit(limit);

      if (error) return errResponse(`Error: ${error.message}`);
      if (!data?.length) return { content: [{ type: "text" as const, text: `No people found matching "${query}".` }] };

      const lines = data.map((p: Record<string, unknown>, i: number) => {
        const parts = [`${i + 1}. ${p.name}`];
        if (p.email) parts.push(`   Email: ${p.email}`);
        if (p.phone) parts.push(`   Phone: ${p.phone}`);
        if (p.company) parts.push(`   Company: ${p.company}`);
        if (p.role) parts.push(`   Role: ${p.role}`);
        if (p.notes) parts.push(`   Notes: ${String(p.notes).slice(0, 150)}`);
        return parts.join("\n");
      });

      return { content: [{ type: "text" as const, text: `${data.length} person/people found:\n\n${lines.join("\n\n")}` }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-TABLE  (new)
// ══════════════════════════════════════════════════════════════════════════════

// Tool 12: brain_summary
server.registerTool(
  "brain_summary",
  {
    title: "Brain Summary",
    description: "Full snapshot of the brain: thought count, open orders, active projects, open todos. Use for 'what's in my brain?', 'give me a status update', 'morning briefing'.",
    inputSchema: {},
  },
  async () => {
    try {
      const [
        { count: thoughtCount },
        { data: openOrders },
        { data: activeProjects },
        { data: openTodos },
      ] = await Promise.all([
        supabase.from("thoughts").select("*", { count: "exact", head: true }),
        supabase.from("open_orders").select("id, item_description, vendor, status, estimated_delivery").limit(10),
        supabase.from("projects").select("id, name, status, category").eq("status", "active"),
        supabase.from("todos").select("id, title, area, due_date, priority").neq("status", "done").order("due_date", { ascending: true }).limit(10),
      ]);

      const lines: string[] = [
        "═══ Brain Summary ═══",
        `📚 Thoughts: ${thoughtCount}`,
        "",
      ];

      if (activeProjects?.length) {
        lines.push(`🔨 Active Projects (${activeProjects.length}):`);
        for (const p of activeProjects) lines.push(`  • ${p.name}${p.category ? ` (${p.category})` : ""}`);
        lines.push("");
      }

      if (openOrders?.length) {
        lines.push(`📦 Open Orders (${openOrders.length}):`);
        for (const o of openOrders) {
          const eta = o.estimated_delivery ? ` | ETA: ${o.estimated_delivery}` : "";
          lines.push(`  • [${o.status}] ${o.item_description} — ${o.vendor || "?"}${eta}`);
        }
        lines.push("");
      }

      if (openTodos?.length) {
        lines.push(`✅ Open Todos (${openTodos.length}):`);
        for (const t of openTodos) {
          const due = t.due_date ? ` | Due: ${t.due_date}` : "";
          lines.push(`  • ${t.title}${t.area ? ` [${t.area}]` : ""}${due}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err: unknown) {
      return errResponse(`Error: ${(err as Error).message}`);
    }
  }
);

// ─── Hono App + Auth ─────────────────────────────────────────────────────────

const app = new Hono();

app.all("*", async (c) => {
  const provided = c.req.header("x-brain-key") || new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);