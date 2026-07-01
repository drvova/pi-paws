/**
 * models.ts — Minimal pass-through (catalog is single source of truth).
 *
 * Converts CatalogModel entries into Pi's ProviderModelConfig[] format.
 * Only values the backend actually provides are set — no fallbacks, no inference.
 */

import type { CatalogModel } from "./catalog.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function catalogToPiModels(
  catalog: CatalogModel[],
  baseUrl: string,
  extraHeaders?: Record<string, string>,
) {
  return catalog.map((m) => ({
    id: m.id,
    name: m.name,
    api: "openai-completions" as const,
    baseUrl,
    reasoning: m.reasoning,
    input: m.input,
    cost: ZERO_COST,
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? 0,
    headers: extraHeaders,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      thinkingFormat: "deepseek",
    },
  }));
}
