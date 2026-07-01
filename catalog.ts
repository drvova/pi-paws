/**
 * catalog.ts — Live model catalog from three Cognition endpoints.
 *
 * Fetches the available model list from /api/models, normalizes entries
 * into a shape Pi can consume, and caches until explicitly refreshed.
 */

import { buildAuthHeaders, type AuthState } from "./auth.js";

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ("text" | "image")[];
}

const CATALOG_CACHE_KEY = "paws.catalog";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

interface CatalogCache {
  models: CatalogModel[];
  fetchedAt: number;
}

// Known reasoning models (output reasoning_content)
const REASONING_PATTERNS = [
  /deepseek/i,
  /claude/i,
  /gpt-5/i,
  /mimo.*pro/i,
  /kimi/i,
  /gemini/i,
];

// Known image-capable models
const IMAGE_PATTERNS = [
  /claude/i,
  /gemini/i,
  /gpt/i,
];

function inferReasoning(id: string, name: string): boolean {
  const probe = `${id} ${name}`;
  return REASONING_PATTERNS.some((p) => p.test(probe));
}

function inferImageSupport(id: string, name: string): ("text" | "image")[] {
  const probe = `${id} ${name}`;
  const hasImage = IMAGE_PATTERNS.some((p) => p.test(probe));
  return hasImage ? ["text", "image"] : ["text"];
}

function inferContextWindow(id: string): number {
  if (/gemini/i.test(id)) return 1_048_576;
  if (/claude/i.test(id)) return 200_000;
  if (/deepseek/i.test(id)) return 131_072;
  if (/mimo/i.test(id)) return 1_048_576;
  if (/kimi/i.test(id)) return 131_072;
  if (/gpt-5/i.test(id)) return 256_000;
  return 128_000;
}

function inferMaxTokens(id: string): number {
  if (/claude/i.test(id)) return 16_384;
  if (/deepseek/i.test(id)) return 8_192;
  if (/gemini/i.test(id)) return 65_536;
  if (/mimo/i.test(id)) return 131_072;
  if (/kimi/i.test(id)) return 8_192;
  return 4_096;
}

function normalizeModel(raw: any): CatalogModel {
  const id = raw.id as string;
  const name = (raw.name as string) || id.split(".").pop() || id;
  return {
    id,
    name,
    contextWindow: raw.context_length || inferContextWindow(id),
    maxTokens: raw.max_tokens || inferMaxTokens(id),
    reasoning: inferReasoning(id, name),
    input: inferImageSupport(id, name),
  };
}

export async function fetchCatalog(baseUrl: string, auth: AuthState): Promise<CatalogModel[]> {
  const headers = buildAuthHeaders(auth);
  const resp = await fetch(`${baseUrl}/api/models`, { headers });
  if (!resp.ok) throw new Error(`Catalog fetch failed (${resp.status})`);
  const data = await resp.json();
  const models = (data.data || []).map(normalizeModel);

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
