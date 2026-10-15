// End-to-end test: spins up a mock newsapi.ai, then drives the MCP server over stdio and HTTP
// with the official MCP client and checks the request bodies the server sends.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const calls = [];
let fail429 = 1;

const article = (i) => ({
  uri: `${9000 + i}`,
  lang: "eng",
  isDuplicate: false,
  dateTimePub: "2026-10-14T08:00:00Z",
  dataType: "news",
  url: `https://example.com/a${i}`,
  title: `Article ${i}`,
  body: "Lorem ipsum dolor sit amet ".repeat(40),
  source: { uri: "example.com", title: "Example News" },
  authors: [{ name: "Jane Doe" }],
  sentiment: 0.31415,
  concepts: [{ uri: "http://en.wikipedia.org/wiki/OpenAI", type: "org", label: { eng: "OpenAI", deu: "OpenAI" } }],
});

const mock = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  calls.push({ path: req.url, body });
  const send = (o, s = 200) => res.writeHead(s, { "Content-Type": "application/json" }).end(JSON.stringify(o));
  if (body.apiKey === "revoked-key") return send({ error: "The apiKey that was provided is not recognized" }, 401);
  if (!["test-key", "header-key", "ui-key", "file-key"].includes(body.apiKey)) return send({ error: "Invalid api key test-key-leak" });
  switch (req.url) {
    case "/api/v1/article/getArticles":
      if (fail429-- > 0) return send({ error: "busy" }, 429);
      return send({ articles: { results: [article(1), article(2)], totalResults: 2, page: 1, count: 2, pages: 1 } });
    case "/api/v1/article/getArticle":
      return send(Object.fromEntries(body.articleUri.map((u) => [u, { info: { ...article(1), uri: u } }])));
    case "/api/v1/articleMapper":
      return send({ [body.articleUrl]: body.articleUrl.includes("unknown") ? null : "777" });
    case "/api/v1/event/getEvents":
      return send({
        events: {
          results: [{ uri: "eng-1", eventDate: "2026-10-13", totalArticleCount: 42, title: { eng: "Big thing", deu: "Großes Ding" }, summary: { eng: "Summary" }, location: { label: { eng: "Berlin" }, country: { label: { eng: "Germany" } } } }],
          totalResults: 1, page: 1, pages: 1,
        },
      });
    case "/api/v1/event/getEvent":
      if (body.resultType === "info") return send({ "eng-1": { info: { uri: "eng-1", title: { eng: "Big thing" }, summary: { eng: "Full summary" } } } });
      return send({ "eng-1": { articles: { results: [article(3)], totalResults: 42 } } });
    case "/api/v1/suggestConceptsFast":
      return send([{ uri: "http://en.wikipedia.org/wiki/Siemens", type: "org", label: { eng: "Siemens" } }]);
    case "/api/v1/suggestSourcesFast":
      return send([{ uri: "heise.de", title: "heise online", dataType: "news" }]);
    case "/api/v1/usage":
      return send({ availableTokens: 5000, usedTokens: 123 });
    default:
      return send({ ok: true, echo: body });
  }
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const apiHost = `http://127.0.0.1:${mock.address().port}`;

const json = (r) => JSON.parse(r.content[0].text);
const last = (path) => [...calls].reverse().find((c) => c.path === path).body;

async function exercise(client, label) {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "newsapi_get_articles", "newsapi_get_event", "newsapi_raw_request", "newsapi_search_articles",
    "newsapi_search_events", "newsapi_suggest", "newsapi_usage",
  ]);

  // search_articles: simple filters → flat API params, retry on 429, compact output
  let r = await client.callTool({
    name: "newsapi_search_articles",
    arguments: { keywords: ["AI", "LLM"], keyword_operator: "or", lang: "deu", source_uris: ["heise.de", "golem.de"], date_start: "2026-10-01", count: 5, include_concepts: true },
  });
  assert.ok(!r.isError, r.content[0].text);
  let out = json(r);
  assert.equal(out.totalResults, 2);
  assert.equal(out.articles[0].source, "Example News");
  assert.equal(out.articles[0].sentiment, 0.31);
  assert.ok(out.articles[0].body.length < 320 && out.articles[0].body.endsWith("…"));
  assert.equal(out.articles[0].concepts[0].label, "OpenAI");
  let b = last("/api/v1/article/getArticles");
  assert.deepEqual(b.keyword, ["AI", "LLM"]);
  assert.equal(b.keywordOper, "or");
  assert.deepEqual(b.lang, ["deu"]);
  assert.deepEqual(b.sourceUri, ["heise.de", "golem.de"]);
  assert.equal(b.dateStart, "2026-10-01");
  assert.equal(b.articlesCount, 5);
  assert.equal(b.resultType, "articles");
  assert.equal(b.isDuplicateFilter, "skipDuplicates");
  assert.equal(b.forceMaxDataTimeWindow, 31, "NEWSAPI_AI_MAX_DAYS applied");

  // advanced query replaces filters
  await client.callTool({ name: "newsapi_search_articles", arguments: { advanced_query: { $query: { keyword: "x" } }, keywords: "ignored", body_chars: 0 } });
  b = last("/api/v1/article/getArticles");
  assert.deepEqual(b.query, { $query: { keyword: "x" } });
  assert.equal(b.keyword, undefined);
  assert.equal(b.includeArticleBody, false);

  // days_back
  await client.callTool({ name: "newsapi_search_articles", arguments: { keywords: "x", days_back: 3 } });
  b = last("/api/v1/article/getArticles");
  assert.match(b.dateStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(b.keywordOper, undefined, "no operator for single keyword");

  // validation error surfaces as tool error, not crash
  r = await client.callTool({ name: "newsapi_search_articles", arguments: { date_start: "14.10.2026" } });
  assert.ok(r.isError);

  // get_articles via url + uri
  r = await client.callTool({ name: "newsapi_get_articles", arguments: { uris: ["1"], urls: ["https://x.com/a", "https://unknown.com/b"] } });
  out = json(r);
  assert.deepEqual(last("/api/v1/article/getArticle").articleUri, ["1", "777"]);
  assert.equal(out.articles.length, 2);
  assert.ok(out.articles[0].body.length > 500, "full body");
  assert.deepEqual(out.unmappedUrls, ["https://unknown.com/b"]);

  // events
  out = json(await client.callTool({ name: "newsapi_search_events", arguments: { keywords: "x", min_articles: 10, result_lang: "deu" } }));
  assert.equal(out.events[0].title, "Großes Ding");
  assert.equal(out.events[0].location, "Berlin, Germany");
  assert.equal(last("/api/v1/event/getEvents").minArticlesInEvent, 10);

  out = json(await client.callTool({ name: "newsapi_get_event", arguments: { event_uri: "eng-1", articles_count: 3 } }));
  assert.equal(out.event.summary, "Full summary");
  assert.equal(out.totalArticles, 42);
  assert.equal(out.articles[0].title, "Article 3");

  // suggest
  out = json(await client.callTool({ name: "newsapi_suggest", arguments: { kind: "concepts", prefix: "Siem" } }));
  assert.equal(out.results[0].uri, "http://en.wikipedia.org/wiki/Siemens");
  assert.equal(out.results[0].label, "Siemens");
  out = json(await client.callTool({ name: "newsapi_suggest", arguments: { kind: "sources", prefix: "heise" } }));
  assert.equal(out.results[0].uri, "heise.de");

  // usage + raw (apiKey in params must be overridden)
  assert.equal(json(await client.callTool({ name: "newsapi_usage", arguments: {} })).availableTokens, 5000);
  out = json(await client.callTool({ name: "newsapi_raw_request", arguments: { path: "/api/v1/trends", params: { source: "news", apiKey: "evil" } } }));
  assert.equal(out.echo.source, "news");
  r = await client.callTool({ name: "newsapi_raw_request", arguments: { path: "https://evil.com/x", params: {} } });
  assert.ok(r.isError);

  console.log(`✔ ${label}: all assertions passed`);
}

const env = { ...process.env, NEWSAPI_AI_KEY: "test-key", NEWSAPI_AI_HOST: apiHost, NEWSAPI_AI_MAX_DAYS: "31" };

// ---- stdio
{
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env }));
  await exercise(client, "stdio");
  await client.close();
}

// ---- HTTP (+ auth, + per-request key header)
{
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = spawn("node", ["dist/index.js", "--http", "--port", String(port)], { env: { ...env, MCP_AUTH_TOKEN: "s3cret" }, stdio: ["ignore", "ignore", "pipe"] });
  await new Promise((r) => proc.stderr.on("data", (d) => d.toString().includes("streamable HTTP") && r()));
  const url = new URL(`http://127.0.0.1:${port}/mcp`);

  const unauth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauth.status, 401);

  fail429 = 1;
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer s3cret" } } }));
  await exercise(client, "http (bearer)");
  await client.close();

  // token via query string + per-request API key header
  const c2 = new Client({ name: "test", version: "0" });
  await c2.connect(new StreamableHTTPClientTransport(new URL(url + "?token=s3cret"), { requestInit: { headers: { "X-NewsAPI-Key": "header-key" } } }));
  await c2.callTool({ name: "newsapi_usage", arguments: {} });
  assert.equal(last("/api/v1/usage").apiKey, "header-key");
  console.log("✔ http (?token= + X-NewsAPI-Key)");
  await c2.close();
  proc.kill();
}

// ---- bad key: error message must not leak the key
{
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...env, NEWSAPI_AI_KEY: "test-key-leak" } }));
  const r = await client.callTool({ name: "newsapi_usage", arguments: {} });
  assert.ok(r.isError);
  assert.ok(!r.content[0].text.includes("test-key-leak"), r.content[0].text);
  console.log("✔ errors redact API key:", r.content[0].text);
  await client.close();
}

// ---- config resolution: plugin UI value, placeholders, config file, missing key
{
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "newsapi-cfg-"));
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ apiKey: "file-key", maxDays: 7 }));
  const base = { PATH: process.env.PATH, HOME: dir, NEWSAPI_AI_HOST: apiHost, NEWSAPI_AI_CONFIG: join(dir, "none.json") };

  async function run(extraEnv, fn) {
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...base, ...extraEnv }, stderr: "ignore" }));
    try { return await fn(c); } finally { await c.close(); }
  }
  const usage = (c) => c.callTool({ name: "newsapi_usage", arguments: {} });
  const search = (c) => c.callTool({ name: "newsapi_search_articles", arguments: { keywords: "x" } });

  // plugin dialog value wins over env; unexpanded placeholders are ignored
  await run({ NEWSAPI_AI_KEY_UI: "ui-key", NEWSAPI_AI_KEY: "test-key", NEWSAPI_AI_MAX_DAYS_UI: "7" }, async (c) => {
    await search(c);
    const b = last("/api/v1/article/getArticles");
    assert.equal(b.apiKey, "ui-key");
    assert.equal(b.forceMaxDataTimeWindow, 7);
  });
  // Cowork / empty dialog: UI value empty, env is a literal placeholder → falls back to config file (incl. maxDays)
  await run({ NEWSAPI_AI_KEY_UI: "", NEWSAPI_AI_KEY: "${NEWSAPI_AI_KEY}", NEWSAPI_AI_MAX_DAYS_UI: "${user_config.max_days}", NEWSAPI_AI_CONFIG: cfgFile }, async (c) => {
    await search(c);
    const b = last("/api/v1/article/getArticles");
    assert.equal(b.apiKey, "file-key");
    assert.equal(b.forceMaxDataTimeWindow, 7);
  });
  // max_days "off" in the dialog overrides env/file limits
  await run({ NEWSAPI_AI_KEY_UI: "ui-key", NEWSAPI_AI_MAX_DAYS_UI: "off", NEWSAPI_AI_MAX_DAYS: "31", NEWSAPI_AI_CONFIG: cfgFile }, async (c) => {
    await search(c);
    assert.equal(last("/api/v1/article/getArticles").forceMaxDataTimeWindow, undefined);
  });
  // no key anywhere → actionable tool error, server still starts
  await run({ NEWSAPI_AI_KEY: "${NEWSAPI_AI_KEY}" }, async (c) => {
    const r = await usage(c);
    assert.ok(r.isError);
    assert.match(r.content[0].text, /plugin configure newsapi-ai@elcamino/);
    assert.match(r.content[0].text, /config file .*apiKey/);
  });
  // rejected key → names where it came from, no retry
  await run({ NEWSAPI_AI_KEY_UI: "revoked-key" }, async (c) => {
    const n = calls.length;
    const r = await usage(c);
    assert.ok(r.isError);
    assert.match(r.content[0].text, /rejected the API key \(taken from plugin settings\)/);
    assert.equal(calls.length, n + 1, "401 is not retried");
  });
  console.log("✔ config resolution (plugin settings, placeholders, config file, missing/rejected key)");
}

mock.close();
console.log("\nAll tests passed.");
process.exit(0);
