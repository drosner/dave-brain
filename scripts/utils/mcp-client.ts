/**
 * Shared MCP tool caller for Node.js scripts.
 * All data reads and writes go through MCP — never directly to Supabase.
 *
 * Usage:
 *   const result = await mcpCall(
 *     process.env.WINE_BRAIN_MCP_URL,
 *     process.env.WINE_BRAIN_MCP_KEY,
 *     'upsert_bottles_batch',
 *     { bottles: [...] }
 *   );
 */

let _callId = 0;

export async function mcpCall(
  url: string | undefined,
  key: string | undefined,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  if (!url) throw new Error(`MCP URL is not set (tool: ${tool})`);
  if (!key) throw new Error(`MCP key is not set (tool: ${tool})`);

  const id = ++_callId;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MCP HTTP ${res.status} calling ${tool}: ${body}`);
  }

  const json = await res.json() as {
    result?: { content?: { type: string; text: string }[] };
    error?: { message: string };
  };

  if (json.error) throw new Error(`MCP error calling ${tool}: ${json.error.message}`);

  const text = json.result?.content?.[0]?.text;
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
