/**
 * Resolves the API key and options from several places, so the server works whether it was configured
 * through the Claude Code plugin dialog (userConfig), plain environment variables, or a config file.
 *
 * Precedence for the API key (first usable value wins):
 *   1. per-request header X-NewsAPI-Key (HTTP mode only)
 *   2. NEWSAPI_AI_KEY_UI          – filled by the Claude Code plugin dialog (${user_config.api_key})
 *   3. NEWSAPI_AI_KEY / NEWSAPI_KEY – environment
 *   4. config file "apiKey"        – $NEWSAPI_AI_CONFIG or ~/.config/newsapi-ai-mcp/config.json
 *
 * Values that are empty or still contain an unexpanded "${…}" placeholder are ignored – hosts pass
 * placeholders through literally when a variable or plugin option is not set.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH = process.env.NEWSAPI_AI_CONFIG || join(homedir(), ".config", "newsapi-ai-mcp", "config.json");

export function usable(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s || s.includes("${")) return undefined;
  return s;
}

interface FileConfig {
  apiKey?: string;
  maxDays?: number | string;
  host?: string;
}

let fileCache: { cfg: FileConfig; error?: string } | undefined;

export function readConfigFile(): { cfg: FileConfig; error?: string } {
  if (fileCache) return fileCache;
  try {
    fileCache = { cfg: JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FileConfig };
  } catch (err: any) {
    fileCache = { cfg: {}, error: err?.code === "ENOENT" ? undefined : `could not read ${CONFIG_PATH}: ${err?.message ?? err}` };
  }
  return fileCache;
}

export interface Resolved {
  apiKey?: string;
  keySource?: string;
  maxDays?: 7 | 31;
  host?: string;
  warnings: string[];
}

export function resolveConfig(headerKey?: string): Resolved {
  const warnings: string[] = [];
  const { cfg, error } = readConfigFile();
  if (error) warnings.push(error);

  const candidates: [string, unknown][] = [
    ["X-NewsAPI-Key header", headerKey],
    ["plugin settings", process.env.NEWSAPI_AI_KEY_UI],
    ["NEWSAPI_AI_KEY", process.env.NEWSAPI_AI_KEY],
    ["NEWSAPI_KEY", process.env.NEWSAPI_KEY],
    [CONFIG_PATH, cfg.apiKey],
  ];
  let apiKey: string | undefined;
  let keySource: string | undefined;
  for (const [src, v] of candidates) {
    const u = usable(v);
    if (u) {
      apiKey = u;
      keySource = src;
      break;
    }
  }

  // max days: plugin option ("off" | "31" | "7") > env > file
  let maxDays: 7 | 31 | undefined;
  for (const v of [process.env.NEWSAPI_AI_MAX_DAYS_UI, process.env.NEWSAPI_AI_MAX_DAYS, cfg.maxDays]) {
    const u = usable(v);
    if (!u) continue;
    if (u === "off" || u === "0") break;
    const n = Number(u);
    if (n === 7 || n === 31) maxDays = n;
    else warnings.push(`ignoring max days value "${u}" – must be 7, 31 or off`);
    break;
  }

  const host = usable(process.env.NEWSAPI_AI_HOST) ?? usable(cfg.host);
  return { apiKey, keySource, maxDays, host, warnings };
}

export const MISSING_KEY_HELP = `No newsapi.ai API key configured. Set it in one of these ways:
  • Claude Code plugin: run /plugin configure newsapi-ai@elcamino (or /plugin → Installed → newsapi-ai → Configure) and enter the key
  • environment variable NEWSAPI_AI_KEY in the MCP server config of your client
  • config file ${CONFIG_PATH} containing {"apiKey": "…"} (works everywhere, including Claude Cowork)
Get a key at https://newsapi.ai/dashboard`;
