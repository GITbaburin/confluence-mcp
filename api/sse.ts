// api/sse.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  ATLASSIAN_SITE,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  MCP_BEARER,
} = process.env as Record<string, string>;

if (!ATLASSIAN_SITE || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN || !MCP_BEARER) {
  throw new Error("Missing required envs: ATLASSIAN_* and MCP_BEARER");
}

// Basic auth for Confluence REST
const basic = "Basic " + Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString("base64");

// ---- one MCP server instance with your tools ----
const server = new McpServer(
  { name: "confluence-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Search (CQL)
server.tool(
  "confluence.search",
  {
    title: "Search Confluence (CQL)",
    inputSchema: z.object({
      cql: z.string(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ cql, limit }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`;
    const r = await fetch(url, { headers: { Authorization: basic, Accept: "application/json" } });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Page HTML
server.tool(
  "confluence.pageHtml",
  { title: "Get Confluence Page (storage HTML)", inputSchema: z.object({ id: z.string() }) },
  async ({ id }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/content/${encodeURIComponent(id)}?expand=body.storage`;
    const r = await fetch(url, { headers: { Authorization: basic, Accept: "application/json" } });
    const data = await r.json();
    const html = data?.body?.storage?.value ?? "";
    return { content: [{ type: "text", text: html }] };
  }
);

// Attachments list
server.tool(
  "confluence.attachments",
  {
    title: "List page attachments",
    inputSchema: z.object({ id: z.string(), limit: z.number().int().min(1).max(50).default(20) }),
  },
  async ({ id, limit }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/content/${encodeURIComponent(id)}/child/attachment?limit=${limit}`;
    const r = await fetch(url, { headers: { Authorization: basic, Accept: "application/json" } });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Health is via /api/health (keep your current file). This handler is ONLY for SSE.
export default async function handler(req: any, res: any) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_BEARER}`) {
    res.status(401).send("unauthorized");
    return;
  }

  // Simple probe for non-SSE requests (curl sanity, Vercel checks, etc.)
  if (!String(req.headers.accept || "").includes("text/event-stream")) {
    res.status(200).send("mcp-ok");
    return;
  }

  // Minimal per-request transport — no generators or extras
  const transport = new StreamableHTTPServerTransport({ request: req, response: res });
  await server.connect(transport);
}