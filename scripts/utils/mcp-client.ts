interface McpToolContent {
  type: string;
  text?: string;
}

interface McpToolResult<T> {
  content?: McpToolContent[];
  isError?: boolean;
  structuredContent?: T;
}

const DEFAULT_OPEN_BRAIN_MCP_URL = "https://zujvqteqcusephuwuqhe.supabase.co/functions/v1/open-brain-mcp";

export class McpClient {
  private nextId = 1;

  constructor(
    private readonly endpoint: string,
    private readonly accessKey: string,
  ) {}

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.request<McpToolResult<T>>("tools/call", {
      name,
      arguments: args,
    });

    if (result.isError) {
      const text = result.content?.map((c) => c.text).filter(Boolean).join("\n") || "Unknown MCP tool error";
      throw new Error(text);
    }

    if (result.structuredContent !== undefined) return result.structuredContent;

    const text = result.content?.find((c) => c.type === "text")?.text;
    if (!text) throw new Error(`MCP tool ${name} returned no text content`);

    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${this.accessKey}`,
        "x-api-key": this.accessKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      }),
    });

    const body = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${body}`);

    const jsonText = body.startsWith("event:")
      ? body.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
      : body;
    if (!jsonText) throw new Error(`MCP returned empty response for ${method}`);

    const payload = JSON.parse(jsonText);
    if (payload.error) {
      throw new Error(payload.error.message || JSON.stringify(payload.error));
    }
    return payload.result as T;
  }
}

export function createOpenBrainMcpClient(): McpClient {
  const endpoint = Deno.env.get("OPEN_BRAIN_MCP_URL") || DEFAULT_OPEN_BRAIN_MCP_URL;
  const accessKey = Deno.env.get("OPEN_BRAIN_MCP_KEY") || Deno.env.get("MCP_ACCESS_KEY") || "";
  if (!accessKey) throw new Error("OPEN_BRAIN_MCP_KEY is required.");
  return new McpClient(endpoint, accessKey);
}
