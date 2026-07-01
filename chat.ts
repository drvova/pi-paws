/**
 * chat.ts — Connect-RPC streaming (proto encode/decode).
 *
 * Handles the streaming chat completions flow: encodes request to wire format,
 * decodes streaming response chunks, and normalizes into OpenAI SSE events.
 */

import type { AuthState } from "./auth";
import { buildPlainHeaders } from "./metadata";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: any[];
  tool_choice?: any;
  reasoning_effort?: string;
}

export interface ChatChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** Strip system messages — backend handles its own system prompt. */
export function stripSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.role !== "system");
}

/**
 * Apply model's maxTokens from catalog.
 * Only caps if the catalog provided a real value — otherwise passes through as-is.
 */
export function applyMaxTokens(
  request: ChatRequest,
  modelMaxTokens: number | undefined,
): ChatRequest {
  if (modelMaxTokens == null) return request;
  if (!request.max_tokens || request.max_tokens > modelMaxTokens) {
    return { ...request, max_tokens: modelMaxTokens };
  }
  return request;
}

/** Prepare request: strip system msgs + enforce model maxTokens. */
export function prepareRequest(
  request: ChatRequest,
  modelMaxTokens: number | undefined,
): ChatRequest {
  return applyMaxTokens(
    { ...request, messages: stripSystemMessages(request.messages) },
    modelMaxTokens,
  );
}

function parseSSEChunk(buffer: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() || "";
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) events.push(trimmed);
  }
  return { events, remainder };
}

function extractSSEData(event: string): string | null {
  for (const line of event.split("\n")) {
    if (line.startsWith("data: ")) return line.slice(6);
  }
  return null;
}

export async function* streamChat(
  baseUrl: string,
  auth: AuthState,
  request: ChatRequest,
): AsyncGenerator<ChatChunk, void, unknown> {
  const url = `${baseUrl}/api/chat/completions`;
  const headers = buildPlainHeaders(auth);
  const body = JSON.stringify({ ...request, stream: true });

  const resp = await fetch(url, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Chat stream failed (${resp.status}): ${text}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSSEChunk(buffer);
      buffer = remainder;

      for (const event of events) {
        const data = extractSSEData(event);
        if (!data || data === "[DONE]") return;
        try {
          yield JSON.parse(data) as ChatChunk;
        } catch (e: any) {
          console.error("[paws-chat] failed to parse SSE chunk:", e.message);
        }
      }
    }

    if (buffer.trim()) {
      const data = extractSSEData(buffer);
      if (data && data !== "[DONE]") {
        try {
          yield JSON.parse(data) as ChatChunk;
        } catch (e: any) {
          console.error("[paws-chat] failed to parse final SSE chunk:", e.message);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function chatCompletion(
  baseUrl: string,
  auth: AuthState,
  request: ChatRequest,
): Promise<any> {
  const url = `${baseUrl}/api/chat/completions`;
  const headers = buildPlainHeaders(auth);
  const body = JSON.stringify({ ...request, stream: false });

  const resp = await fetch(url, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Chat completion failed (${resp.status}): ${text}`);
  }
  return resp.json();
}
