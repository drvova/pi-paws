/**
 * models.ts — Minimal pass-through (catalog is single source of truth).
 *
 * Converts CatalogModel entries into Pi's ProviderModelConfig[] format.
 * No business logic lives here — all intelligence is in catalog.ts.
 */

import type { CatalogModel } from "./catalog.js";

export interface PiModelConfig {
  id: string;
  name: string;
  api: "openai-completions";
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function catalogToPiModels(
  catalog: CatalogModel[],
  baseUrl: string,
  extraHeaders?: Record<string, string>,
): PiModelConfig[] {
  return catalog.map((m) => ({
    id: m.id,
    name: m.name,
    api: "openai-completions" as const,
    baseUrl,
    reasoning: m.reasoning,
    thinkingLevelMap: m.reasoning
      ? { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" }
      : undefined,
    input: m.input,
    cost: ZERO_COST,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
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
