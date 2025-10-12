// api/sse.ts
import express from "express";
import { randomUUID } from "node:crypto";
import serverless from "serverless-http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const {
  ATLASSIAN_SITE,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  MCP_BEARER
} = process.env as Record<string, string>;

if (!ATLASSIAN_SITE || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN || !MCP_BEARER) {
  throw new Error("Missing required envs: ATLASSIAN_* and MCP_BEARER");
}

const basic = "Basic " + Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString("base64");

const app = express();
app.use(express.json());

// Tiny auth – require Authorization: Bearer <MCP_BEARER>
app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_BEARER}`) return res.status(401).send("unauthorized");
  next();
});

// Health (not protected so Vercel checks work)
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ---------------- MCP server ----------------
const server = new McpServer({ name: "confluence-mcp", version: "0.1.0" });

// Register tools (newer SDK uses registerTool with schemas)
server.registerTool(
  "confluence.search",
  {
    title: "Search Confluence with CQL",
    description: "Return pages that match a CQL query",
    inputSchema: { cql: z.string(), limit: z.number().default(5) }
  },
  async ({ cql, limit }) => {
    const url = new URL(`${ATLASSIAN_SITE}/wiki/rest/api/search`);
    url.searchParams.set("cql", cql);
    url.searchParams.set("limit", String(limit));
    const r = await fetch(url.toString(), { headers: { Authorization: basic } });
    if (!r.ok) throw new Error(`search failed: ${r.status} ${await r.text()}`);
    const data: any = await r.json();
    const out = (data.results || [])
      .filter((h: any) => h.content?.type === "page")
      .map((h: any) => ({
        id: h.content.id,
        title: h.content.title,
        url: `${ATLASSIAN_SITE}/wiki${h.content._links.webui}`
      }));
    // Return TEXT (stringified JSON) to satisfy content types
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }
);

server.registerTool(
  "confluence.page",
  {
    title: "Get Confluence page (storage HTML)",
    description: "Fetch a page by ID with storage HTML body",
    inputSchema: { id: z.string() }
  },
  async ({ id }) => {
    const url = new URL(`${ATLASSIAN_SITE}/wiki/api/v2/pages/${id}`);
    url.searchParams.set("body-format", "storage");
    const r = await fetch(url.toString(), { headers: { Authorization: basic } });
    if (!r.ok) throw new Error(`page fetch failed: ${r.status} ${await r.text()}`);
    const data: any = await r.json();
    const html = data?.body?.storage?.value || "";
    return { content: [{ type: "text", text: html }] };
  }
);

server.registerTool(
  "confluence.attachments",
  {
    title: "List page attachments",
    description: "List attachments and download paths for a page",
    inputSchema: { id: z.string(), limit: z.number().default(20) }
  },
  async ({ id, limit }) => {
    const url = new URL(`${ATLASSIAN_SITE}/wiki/rest/api/content/${id}/child/attachment`);
    url.searchParams.set("limit", String(limit));
    const r = await fetch(url.toString(), { headers: { Authorization: basic } });
    if (!r.ok) throw new Error(`attachments failed: ${r.status} ${await r.text()}`);
    const data: any = await r.json();
    const out = (data.results || []).map((a: any) => ({
      title: a.title,
      download_url: `/wiki${a._links.download}`
    }));
    return { content: [{ type: "text", text: JSON.stringify(out) }] };
  }
);

// Streamable HTTP endpoint (per SDK docs):
// Create a transport per request and hand it the Express req/res.
app.post("/api/sse", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      // required in current SDK:
      sessionIdGenerator: () => randomUUID(),
      // optional but handy for serverless:
      enableJsonResponse: true
    });
  
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  });

// Export for Vercel
export default serverless(app);