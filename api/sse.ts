// api/sse.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
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

const basic = "Basic " + Buffer.from(`${ATLASSIAN_EMAIL}:${ATLASSIAN_API_TOKEN}`).toString("base64");

// ----- MCP server & tools -----
const server = new McpServer({ name: "confluence-mcp", version: "1.0.0" });

// NOTE: server.tool(name, paramsSchema, handler)
// Return content as text (not "json") to satisfy SDK types.
server.tool(
  "confluence.search",
  z.object({
    cql: z.string(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async ({ cql, limit }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/search?cql=${encodeURIComponent(
      cql
    )}&limit=${limit}`;
    const r = await fetch(url, {
      headers: { Authorization: basic, Accept: "application/json" },
    });
    const data = await r.json();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
  }
);

server.tool(
  "confluence.page",
  z.object({
    id: z.string(),
  }),
  async ({ id }) => {
    const url = `${ATLASSIAN_SITE}/wiki/api/v2/pages/${id}?body-format=storage`;
    const r = await fetch(url, {
      headers: { Authorization: basic, Accept: "application/json" },
    });
    const data = await r.json();
    const html = data?.body?.storage?.value ?? "";

    return {
      content: [{ type: "text", text: html }],
    };
  }
);

server.tool(
  "confluence.attachments",
  z.object({
    id: z.string(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async ({ id, limit }) => {
    const url = `${ATLASSIAN_SITE}/wiki/rest/api/content/${id}/child/attachment?limit=${limit}`;
    const r = await fetch(url, {
      headers: { Authorization: basic, Accept: "application/json" },
    });
    const data = await r.json();

    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
    };
  }
);

// ----- Transport: use JSON responses so requests finish quickly -----
const transport = new StreamableHTTPServerTransport({
  enableJsonResponse: true,
  sessionIdGenerator: () => crypto.randomUUID(),
});

// ----- Vercel handler -----
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Tiny auth
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${MCP_BEARER}`) {
    res.status(401).send("unauthorized");
    return;
  }

  if (req.method === "GET") {
    // Make liveness checks instant (prevents 5-minute 504s)
    res.status(200).send("mcp-ok");
    return;
  }

  // POST → MCP JSON transport (finishes promptly)
  await transport.handleRequest(req, res, server);
}