#!/usr/bin/env node
/**
 * newsapi-ai-mcp — MCP server for newsapi.ai (Event Registry).
 *
 *   stdio (default, for Claude Code / Desktop, Codex, OpenCode, Cursor …):
 *     NEWSAPI_AI_KEY=... npx -y newsapi-ai-mcp
 *
 *   Streamable HTTP (remote connector, e.g. claude.ai custom connector):
 *     NEWSAPI_AI_KEY=... MCP_AUTH_TOKEN=... npx -y newsapi-ai-mcp --http --port 8787
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { NewsApiClient } from "./client.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `newsapi.ai gives access to news articles and events from ~150k sources worldwide.
Workflow: 1) resolve entities/sources/categories to URIs with newsapi_suggest, 2) search with newsapi_search_articles (or newsapi_search_events for clustered stories), 3) fetch full text only for the articles you need with newsapi_get_articles.
Languages use ISO 639-2 codes (eng, deu, fra …). Every request costs API tokens; searches reaching back more than 31 days cost more — set force_max_data_time_window or date_start when recency is enough.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

if (has("--help") || has("-h")) {
  console.log(`newsapi-ai-mcp ${VERSION}

Usage: newsapi-ai-mcp [--http] [--port 8787] [--host 127.0.0.1]

Environment:
  NEWSAPI_AI_KEY               newsapi.ai API key (required; in HTTP mode optional if clients send X-NewsAPI-Key)
  NEWSAPI_AI_HOST              API host (default https://eventregistry.org)
  NEWSAPI_AI_MAX_DAYS          7 or 31: never query older data (saves archive tokens)
  MCP_AUTH_TOKEN               HTTP mode: required bearer token (Authorization: Bearer … or ?token=…)
  MCP_ALLOW_UNAUTHENTICATED=1  HTTP mode: run without MCP_AUTH_TOKEN (only behind your own auth proxy!)
`);
  process.exit(0);
}
if (has("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const maxDays = process.env.NEWSAPI_AI_MAX_DAYS ? Number(process.env.NEWSAPI_AI_MAX_DAYS) : undefined;
if (maxDays !== undefined && maxDays !== 7 && maxDays !== 31) {
  console.error("NEWSAPI_AI_MAX_DAYS must be 7 or 31");
  process.exit(1);
}

function makeClient(apiKey?: string) {
  return new NewsApiClient({
    apiKey: apiKey || process.env.NEWSAPI_AI_KEY || process.env.NEWSAPI_KEY || "",
    host: process.env.NEWSAPI_AI_HOST,
    maxDataTimeWindow: maxDays,
  });
}

function buildServer(apiKey?: string) {
  const server = new McpServer({ name: "newsapi-ai", version: VERSION }, { instructions: INSTRUCTIONS });
  // client is created lazily so a missing key surfaces as a tool error, not a crash on startup
  registerTools(server, () => makeClient(apiKey));
  return server;
}

async function runStdio() {
  if (!process.env.NEWSAPI_AI_KEY && !process.env.NEWSAPI_KEY) {
    console.error("[newsapi-ai-mcp] warning: NEWSAPI_AI_KEY is not set – tool calls will fail.");
  }
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function runHttp() {
  const port = Number(arg("--port") ?? process.env.PORT ?? 8787);
  const host = arg("--host") ?? process.env.HOST ?? "127.0.0.1";
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token && process.env.MCP_ALLOW_UNAUTHENTICATED !== "1") {
    console.error("HTTP mode needs MCP_AUTH_TOKEN (or MCP_ALLOW_UNAUTHENTICATED=1 behind your own auth proxy).");
    process.exit(1);
  }

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true, version: VERSION });
    if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found – MCP endpoint is /mcp" });

    if (token) {
      const auth = req.headers.authorization ?? "";
      const given = auth.startsWith("Bearer ") ? auth.slice(7) : url.searchParams.get("token") ?? "";
      if (!safeEqual(given, token)) return sendJson(res, 401, { error: "unauthorized" });
    }
    if (req.method !== "POST") {
      // stateless server: no SSE stream / session to resume
      return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server, use POST)" }, id: null });
    }

    const perRequestKey = (req.headers["x-newsapi-key"] as string | undefined) || undefined;
    try {
      const body = await readBody(req);
      const server = buildServer(perRequestKey);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: (err as Error).message }, id: null });
    }
  });

  http.listen(port, host, () => {
    console.error(`[newsapi-ai-mcp] streamable HTTP on http://${host}:${port}/mcp${token ? " (bearer auth)" : " (NO AUTH)"}`);
  });
}

(has("--http") || process.env.MCP_TRANSPORT === "http" ? runHttp() : runStdio()).catch((err) => {
  console.error(err);
  process.exit(1);
});
