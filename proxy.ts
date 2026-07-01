/**
 * proxy.ts — HTTP server (OpenAI API -> gRPC translation).
 *
 * Local HTTP proxy that translates incoming OpenAI-compatible requests
 * into the format expected by ai.paws.best, handling auth, streaming,
 * and response normalization.
 */

import type { AuthState } from "./auth";
import { buildAuthHeaders } from "./auth";
import { getCatalog, type CatalogModel } from "./catalog";
import { streamChat, chatCompletion, prepareRequest, type ChatRequest, type ChatMessage } from "./chat";

export interface ProxyConfig {
  baseUrl: string;
  port: number;
}

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
}

function normalizeMessages(messages: any[]): ChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));
}

function normalizeRequest(
  body: any,
  modelMaxTokens: number | undefined,
  modelSupportsTools: boolean,
): ChatRequest {
  const raw: ChatRequest = {
    model: body.model,
    messages: normalizeMessages(body.messages || []),
    stream: body.stream !== false,
    max_tokens: body.max_tokens || body.max_completion_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop,
    // Strip tools if model doesn't support them (e.g. Kimi)
    tools: modelSupportsTools ? body.tools : undefined,
    tool_choice: modelSupportsTools ? body.tool_choice : undefined,
    reasoning_effort: body.reasoning_effort,
  };
  return prepareRequest(raw, modelMaxTokens);
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export function createProxy(config: ProxyConfig, getAuth: () => Promise<AuthState | null>): ProxyServer {
  const { createServer } = require("http");
  const server = createServer(async (req: any, res: any) => {
    console.error(`[paws-proxy] ${req.method} ${req.url}`);
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Chat completions
    console.error(`[paws-proxy] ${req.method} ${req.url}`);
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
      const auth = await getAuth();
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not authenticated" }));
        return;
      }

      let rawBody = "";
      for await (const chunk of req) rawBody += chunk;

      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Look up model's catalog entry
      let modelMaxTokens: number | undefined;
      let modelSupportsTools = true;
      try {
        const catalog = await getCatalog(config.baseUrl, auth);
        const found = catalog.find((m) => m.id === body.model);
        modelMaxTokens = found?.maxTokens;
        modelSupportsTools = found?.tools ?? true;
      } catch {}

      const request = normalizeRequest(body, modelMaxTokens, modelSupportsTools);

      try {
        if (request.stream) {
          res.writeHead(200, sseHeaders());
          for await (const chunk of streamChat(config.baseUrl, auth, request)) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          const result = await chatCompletion(config.baseUrl, auth, request);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (err: any) {
        console.error("Proxy error:", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.end();
        }
      }
      return;
    }

    // Models list
    if (req.method === "GET" && req.url === "/v1/models") {
      const auth = await getAuth();
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not authenticated" }));
        return;
      }
      try {
        const resp = await fetch(`${config.baseUrl}/api/models`, {
          headers: buildAuthHeaders(auth),
        });
        const data = await resp.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err: any) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    console.error(`[paws-proxy] 404: ${req.method} ${req.url}`);
    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(config.port);
  console.log(`Paws proxy listening on http://localhost:${config.port}`);

  return {
    port: config.port,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}
