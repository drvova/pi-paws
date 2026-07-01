/**
 * catalog.ts — Live model catalog from backend.
 *
 * Fetches the available model list from /api/models.
 * Probes each model for: reasoning, tools, and all compat flags.
 * Zero hardcoded values — everything comes from the backend.
 */

import { buildAuthHeaders, type AuthState } from "./auth";

export interface CatalogCompat {
  supportsStore: boolean;
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  supportsUsageInStreaming: boolean;
  requiresToolResultName: boolean;
  requiresAssistantAfterToolResult: boolean;
  requiresThinkingAsText: boolean;
  requiresReasoningContentOnAssistantMessages: boolean;
  thinkingFormat: "openai" | "deepseek" | "zai" | "qwen" | "qwen-chat-template";
  maxTokensField: "max_tokens" | "max_completion_tokens";
}

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  reasoning: boolean;
  tools: boolean;
  compat: CatalogCompat;
  input: ("text" | "image")[];
}

const CATALOG_CACHE_KEY = "paws.catalog";
const CACHE_TTL_MS = 30 * 60 * 1000;

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getCatalogCachePath(): string {
  const dir = path.join(os.homedir(), ".pi", "credentials");
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  return path.join(dir, "paws-catalog.json");
}

interface CatalogCache {
  models: CatalogModel[];
  fetchedAt: number;
}

const DEFAULT_COMPAT: CatalogCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  maxTokensField: "max_tokens",
};

function normalizeModel(raw: any): CatalogModel {
  const id = raw.id as string;
  const name = (raw.name as string) || id.split(".").pop() || id;
  const openai = raw.openai || {};
  const contextWindow = raw.context_length ?? openai.context_length ?? undefined;
  const maxTokens = raw.max_tokens ?? openai.max_tokens ?? undefined;
  const caps = raw.info?.meta?.capabilities || {};
  const input: ("text" | "image")[] = caps.vision ? ["text", "image"] : ["text"];

  return { id, name, contextWindow, maxTokens, reasoning: false, tools: false, compat: { ...DEFAULT_COMPAT }, input };
}

async function apiCall(baseUrl: string, auth: AuthState, body: any, proxyUrl?: string): Promise<any> {
  // When proxyUrl is set, route through it (proxy adds auth headers)
  const url = proxyUrl
    ? `${proxyUrl}/api/chat/completions`
    : `${baseUrl}/api/chat/completions`;
  const headers = proxyUrl ? {} : buildAuthHeaders(auth);
  const r = await fetch(url, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, data: JSON.parse(text) }; }
  catch { return { status: r.status, data: null, raw: text }; }
}

async function probeReasoning(baseUrl: string, auth: AuthState, modelId: string, proxyUrl?: string): Promise<boolean> {
  const { data } = await apiCall(baseUrl, auth, {
    model: modelId, messages: [{ role: "user", content: "Say OK" }],
    stream: false, max_tokens: 20,
  }, proxyUrl);
  const msg = data?.choices?.[0]?.message;
  // Check for reasoning_content field (deepseek-style)
  if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0) return true;
  // Check usage for reasoning tokens (gemini/claude-style)
  const usage = data?.usage;
  const reasonTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const totalTokens = usage?.completion_tokens ?? 0;
  if (totalTokens > 0 && reasonTokens >= totalTokens * 0.5) return true;
  return false;
}

async function probeTools(baseUrl: string, auth: AuthState, modelId: string, proxyUrl?: string): Promise<boolean> {
  const { status, data } = await apiCall(baseUrl, auth, {
    model: modelId,
    messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
    tool_choice: "auto", stream: false, max_tokens: 50,
  }, proxyUrl);
  if (status !== 200) return false;
  if (data?.detail) return false;
  return !!data?.choices?.[0]?.message?.tool_calls?.length;
}

async function probeDeveloperRole(baseUrl: string, auth: AuthState, modelId: string, proxyUrl?: string): Promise<boolean> {
  const { status } = await apiCall(baseUrl, auth, {
    model: modelId,
    messages: [{ role: "developer", content: "Be helpful" }, { role: "user", content: "Say OK" }],
    stream: false, max_tokens: 10,
  }, proxyUrl);
  return status === 200;
}

async function probeReasoningEffort(baseUrl: string, auth: AuthState, modelId: string, proxyUrl?: string): Promise<boolean> {
  const { status } = await apiCall(baseUrl, auth, {
    model: modelId, messages: [{ role: "user", content: "Say OK" }],
    reasoning_effort: "high", stream: false, max_tokens: 20,
  }, proxyUrl);
  return status === 200;
}

async function probeRequiresReasoningContent(baseUrl: string, auth: AuthState, modelId: string, proxyUrl?: string): Promise<boolean> {
  // Send tool call with reasoning_content, then tool result without reasoning_content
  const { status } = await apiCall(baseUrl, auth, {
    model: modelId,
    messages: [
      { role: "user", content: "What is the weather?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }] },
      { role: "tool", tool_call_id: "c1", content: '{"temp":22}' },
    ],
    stream: false, max_tokens: 20,
  }, proxyUrl);
  return status === 400;
}

async function probeStreamOptions(baseUrl: string, auth: AuthState, modelId: string, proxyUrl?: string): Promise<boolean> {
  const url = proxyUrl
    ? `${proxyUrl}/api/chat/completions`
    : `${baseUrl}/api/chat/completions`;
  const headers = proxyUrl ? {} : buildAuthHeaders(auth);
  const r = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      model: modelId, messages: [{ role: "user", content: "Say OK" }],
      stream: true, stream_options: { include_usage: true }, max_tokens: 10,
    }),
  });
  const reader = r.body?.getReader();
  if (!reader) return false;
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("[DONE]")) break;
    }
  } finally { reader.releaseLock(); }
  return buf.includes('"usage"');
}

async function probeCompat(
  baseUrl: string, auth: AuthState, modelId: string, hasReasoning: boolean, hasTools: boolean, proxyUrl?: string,
): Promise<CatalogCompat> {
  const compat = { ...DEFAULT_COMPAT };

  // Run probes in parallel
  const [devRole, reasoningEffort, streamOpts] = await Promise.all([
    probeDeveloperRole(baseUrl, auth, modelId, proxyUrl),
    probeReasoningEffort(baseUrl, auth, modelId, proxyUrl),
    probeStreamOptions(baseUrl, auth, modelId, proxyUrl),
  ]);

  compat.supportsDeveloperRole = devRole;
  compat.supportsReasoningEffort = reasoningEffort;
  compat.supportsUsageInStreaming = streamOpts;

  if (hasReasoning) {
    compat.requiresReasoningContentOnAssistantMessages = await probeRequiresReasoningContent(baseUrl, auth, modelId, proxyUrl);
    // Probe thinking format: check response field names
    const { data } = await apiCall(baseUrl, auth, {
      model: modelId, messages: [{ role: "user", content: "Say OK" }],
      stream: false, max_tokens: 20,
    }, proxyUrl);
    const msg = data?.choices?.[0]?.message || {};
    if (msg.reasoning_content !== undefined) compat.thinkingFormat = "deepseek";
    else if (msg.thinking !== undefined) compat.thinkingFormat = "zai";
    else compat.thinkingFormat = "openai";
  }

  return compat;
}

export async function fetchCatalog(baseUrl: string, auth: AuthState, proxyUrl?: string): Promise<CatalogModel[]> {
  const headers = proxyUrl ? {} : buildAuthHeaders(auth);
  const url = proxyUrl ? `${proxyUrl}/v1/models` : `${baseUrl}/api/models`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Catalog fetch failed (${resp.status})`);
  const data = await resp.json();
  const models: CatalogModel[] = (data.data || []).map(normalizeModel);

  // Probe each model (serial to avoid rate limits)
  for (const m of models) {
    m.reasoning = await probeReasoning(baseUrl, auth, m.id, proxyUrl);
    m.tools = await probeTools(baseUrl, auth, m.id, proxyUrl);
    m.compat = await probeCompat(baseUrl, auth, m.id, m.reasoning, m.tools, proxyUrl);
  }

  const cache: CatalogCache = { models, fetchedAt: Date.now() };
  // File storage (Node.js)
  try { fs.writeFileSync(getCatalogCachePath(), JSON.stringify(cache), { mode: 0o600 }); } catch {}
  // localStorage (browser)
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(cache));
  }
  return models;
}

export function getCachedCatalog(): CatalogModel[] | null {
  // Try file storage (Node.js)
  try {
    const raw = fs.readFileSync(getCatalogCachePath(), "utf8");
    const cache: CatalogCache = JSON.parse(raw);
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;
    return cache.models;
  } catch {}
  // Fallback to localStorage (browser)
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CATALOG_CACHE_KEY);
  if (!raw) return null;
  try {
    const cache: CatalogCache = JSON.parse(raw);
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;
    return cache.models;
  } catch { return null; }
}

export async function getCatalog(baseUrl: string, auth: AuthState, proxyUrl?: string): Promise<CatalogModel[]> {
  const cached = getCachedCatalog();
  if (cached && cached.length > 0) return cached;
  return fetchCatalog(baseUrl, auth, proxyUrl);
}
