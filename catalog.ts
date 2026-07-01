/**
 * catalog.ts — Live model catalog from backend.
 *
 * Fetches the available model list from /api/models.
 * All values come directly from the API response.
 * Probes each model for reasoning support on first catalog fetch.
 */

import { buildAuthHeaders, type AuthState } from "./auth.js";

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  reasoning: boolean;
  tools: boolean;
  input: ("text" | "image")[];
}

const CATALOG_CACHE_KEY = "paws.catalog";
const CACHE_TTL_MS = 30 * 60 * 1000;

interface CatalogCache {
  models: CatalogModel[];
  fetchedAt: number;
}

function normalizeModel(raw: any): CatalogModel {
  const id = raw.id as string;
  const name = (raw.name as string) || id.split(".").pop() || id;
  const openai = raw.openai || {};

  const contextWindow = raw.context_length ?? openai.context_length ?? undefined;
  const maxTokens = raw.max_tokens ?? openai.max_tokens ?? undefined;

  const caps = raw.info?.meta?.capabilities || {};
  const vision = caps.vision === true;
  const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];

  return { id, name, contextWindow, maxTokens, reasoning: false, tools: false, input };
}

/**
 * Probe a model for reasoning support.
 */
async function probeReasoning(
  baseUrl: string,
  auth: AuthState,
  modelId: string,
): Promise<boolean> {
  try {
    const headers = buildAuthHeaders(auth);
    const resp = await fetch(`${baseUrl}/api/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say OK" }],
        stream: false,
        max_tokens: 20,
      }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    const msg = data.choices?.[0]?.message;
    const reasoning = msg?.reasoning_content;
    return typeof reasoning === "string" && reasoning.length > 0;
  } catch {
    return false;
  }
}

/**
 * Probe a model for tool call support.
 */
async function probeTools(
  baseUrl: string,
  auth: AuthState,
  modelId: string,
): Promise<boolean> {
  try {
    const headers = buildAuthHeaders(auth);
    const resp = await fetch(`${baseUrl}/api/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "What is the weather in Tokyo?" }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
        tool_choice: "auto",
        stream: false,
        max_tokens: 50,
      }),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    // Backend returns error in detail field if tools aren't supported
    if (data.detail) return false;
    return !!data.choices?.[0]?.message?.tool_calls?.length;
  } catch {
    return false;
  }
}

export async function fetchCatalog(baseUrl: string, auth: AuthState): Promise<CatalogModel[]> {
  const headers = buildAuthHeaders(auth);
  const resp = await fetch(`${baseUrl}/api/models`, { headers });
  if (!resp.ok) throw new Error(`Catalog fetch failed (${resp.status})`);
  const data = await resp.json();
  const models: CatalogModel[] = (data.data || []).map(normalizeModel);

  // Probe each model for reasoning + tool support (parallel batches)
  const CONCURRENCY = 3;
  for (let i = 0; i < models.length; i += CONCURRENCY) {
    const batch = models.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (m) => ({
        reasoning: await probeReasoning(baseUrl, auth, m.id),
        tools: await probeTools(baseUrl, auth, m.id),
      })),
    );
    results.forEach((r, j) => {
      models[i + j].reasoning = r.reasoning;
      models[i + j].tools = r.tools;
    });
  }

  const cache: CatalogCache = { models, fetchedAt: Date.now() };
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(cache));
  }

  return models;
}

export function getCachedCatalog(): CatalogModel[] | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CATALOG_CACHE_KEY);
  if (!raw) return null;
  try {
    const cache: CatalogCache = JSON.parse(raw);
    if (Date.now() - cache.fetchedAt > CACHE_TTL_MS) return null;
    return cache.models;
  } catch {
    return null;
  }
}

export async function getCatalog(baseUrl: string, auth: AuthState): Promise<CatalogModel[]> {
  const cached = getCachedCatalog();
  if (cached && cached.length > 0) return cached;
  return fetchCatalog(baseUrl, auth);
}
