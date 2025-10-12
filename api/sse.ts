// api/sse.ts
import express from "express";
import serverless from "serverless-http";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const {
  ATLASSIAN_SITE,
  ATLASSIAN_EMAIL,
  ATLASSIAN_API_TOKEN,
  MCP_BEARER,
} = process.env as Record<string, string>;

if (!ATLASSIAN_SITE || !ATLASSIAN_EMAIL || !ATLASSIAN_API_TOKEN || !MCP_BEARER) {
  throw new Error("Missing required envs: ATLASSIAN_* and MCP_BEARER");
}

// basic auth for Atlassian REST
const basic = "Basic " + Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString("base64");

const app = express();

// IMPORTANT: parse JSON so the transport receives req.body
app.use(express.json({ limit: "5mb" }));

// public health
app.get("/health", (_req, res) => res.status(200).send("ok"));

// auth for everything else
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_BEARER}`) return res.status(401).send("unauthorized");
  next();
});

// --- MCP server & tools ---
const server = new McpServer({ name: "confluence-mcp", version: "1.0.0" });

// 1) search
server.tool(
  "confluence.search",
  {
    description: "Search Confluence with CQL",
    inputSchema: z.object({
      cql: z.string(),
      limit: z.number().int().positive().max(50).default(10),
    }),
  },
  async ({ cql, limit }) => {
    const url = new URL(`${ATLASSIAN_SITE}/wiki/rest/api/search`);
    url.searchParams.set("cql", cql);
    url.searchParams.set("limit", String(limit));
    const r = await fetch(url.toString(), { headers: { Authorization: basic } });
    const json = await r.json();
    const results = (json?.results || []).map((it: any) => ({
      id: it.content?.id,
      title: it.title,
      url: `${ATLASSIAN_SITE}/wiki${it.url}`,
    }));
    return { content: [{ type: "json", json: results }] };
  }
);

// 2) page
server.tool(
  "confluence.page",
  {
    description: "Get a page storage HTML by id",
    inputSchema: z.object({ id: z.string() }),
  },
  async ({ id }) => {
    const r = await fetch(
      `${ATLASSIAN_SITE}/wiki/api/v2/pages/${id}?body-format=storage`,
      { headers: { Authorization: basic } }
    );
    const json = await r.json();
    const html = json?.body?.storage?.value ?? "";
    return { content: [{ type: "text", text: html }] };
  }
);

// 3) attachments
server.tool(
  "confluence.attachments",
  {
    description: "List attachments for a page id",
    inputSchema: z.object({
      id: z.string(),
      limit: z.number().int().positive().max(50).default(10),
    }),
  },
  async ({ id, limit }) => {
    const r = await fetch(
      `${ATLASSIAN_SITE}/wiki/api/v2/pages/${id}/attachments?limit=${limit}`,
      { headers: { Authorization: basic } }
    );
    const json = await r.json();
    const items = (json?.results || []).map((a: any) => ({
      title: a.title,
      download_url: a._links?.download ? `${ATLASSIAN_SITE}${a._links.download}` : null,
    }));
    return { content: [{ type: "json", json: items }] };
  }
);

// MCP over HTTP (JSON response — no long SSE needed)
app.post("/api/sse", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);
  await transport.handleRequest(req as any, res as any, req.body);
});

// (Optional) quick GET to verify auth header manually
app.get("/api/sse", (_req, res) => res.status(200).send("mcp-ok"));

export default serverless(app);