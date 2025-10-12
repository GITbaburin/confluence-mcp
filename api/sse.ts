// api/sse.ts
import { Server as MCPServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---- envs ----
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

// ---- Create a single MCP server instance with your tools ----
const server = new MCPServer(
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
    const r = await fetch(url, {
      headers: { Authorization: basic, Accept: "application/json" },
    });
    const data = await r.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Page HTML by id
server.tool(
  "confluence.pageHtml",
  {
    title: "Get Confluence Page (storage format HTML)",
    inputSchema: z.object({ id: z.string() }),
  },
  async ({ id }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/content/${encodeURIComponent(
      id
    )}?expand=body.storage`;
    const r = await fetch(url, {
      headers: { Authorization: basic, Accept: "application/json" },
    });
    const data = await r.json();
    const html = data?.body?.storage?.value ?? "";
    return { content: [{ type: "text", text: html }] };
  }
);

// Attachments list by page id
server.tool(
  "confluence.attachments",
  {
    title: "List page attachments",
    inputSchema: z.object({ id: z.string(), limit: z.number().int().min(1).max(50).default(20) }),
  },
  async ({ id, limit }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/content/${encodeURIComponent(
      id
    )}/child/attachment?limit=${limit}`;
    const r = await fetch(url, {
      headers: { Authorization: basic, Accept: "application/json" },
    });
    const data = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Simple health
export default async function handler(req: any, res: any) {
  // tiny auth for all requests
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_BEARER}`) {
    res.status(401).send("unauthorized");
    return;
  }

  // If the client isn’t asking for SSE, reply quick (useful for curl sanity checks)
  const wantsSSE = String(req.headers.accept || "").includes("text/event-stream");
  if (!wantsSSE) {
    res.status(200).send("mcp-ok");
    return;
  }

  // Per-request transport (this is the important bit for Agent Builder)
  const transport = new StreamableHTTPServerTransport({
    request: req,
    response: res,
    // unique id per connection; avoids optional typing complaints
    sessionIdGenerator: () =>
      // Node 18+/22 have crypto.randomUUID
      (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)),
  });

  // Hand the connection to the MCP server (this immediately sends the SSE handshake)
  await server.connect(transport);
}