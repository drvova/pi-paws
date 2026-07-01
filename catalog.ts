/**
 * catalog.ts — Live model catalog from backend.
 *
 * Fetches the available model list from /api/models.
 * All values come directly from the API response — nothing is inferred or hardcoded.
 * Fields that the backend omits are left as undefined (not approximated).
 */

import { buildAuthHeaders, type AuthState } from "./auth.js";

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number | undefined;
  maxTokens: number | undefined;
  reasoning: boolean;
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

  // Pull directly from the API — top-level or openai nested object
  const contextWindow = raw.context_length ?? openai.context_length ?? undefined;
  const maxTokens = raw.max_tokens ?? openai.max_tokens ?? undefined;

  // Reasoning: check capabilities if present, else false
  const caps = raw.info?.meta?.capabilities || {};
  const reasoning = caps.reasoning === true;

  // Input types: check capabilities
  const vision = caps.vision === true;
  const input: ("text" | "image")[] = vision ? ["text", "image"] : ["text"];

  return { id, name, contextWindow, maxTokens, reasoning, input };
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
