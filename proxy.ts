/**
 * proxy.ts — Transparent OpenAI-compatible proxy.
 *
 * Receives requests from Pi on localhost, forwards to ai.paws.best
 * with auth headers. Passes SSE stream through unmodified.
 */

import { createServer } from "http";
import { execSync } from "child_process";
import type { AuthState } from "./auth";
import { buildAuthHeaders } from "./auth";
import { getCatalog, type CatalogModel } from "./catalog";

export interface ProxyConfig {
  baseUrl: string;
  port: number;
}

export interface ProxyServer {
  port: number;
  close(): Promise<void>;
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
  // Per-model catalog lookup — avoids re-probing on every request
  let catalogPromise: Promise<CatalogModel[]> | null = null;
  async function getModelInfo(modelId: string, auth: AuthState): Promise<CatalogModel | undefined> {
    try {
      if (!catalogPromise) {
        catalogPromise = getCatalog(config.baseUrl, auth);
        catalogPromise.catch(() => { catalogPromise = null; }); // reset on failure so next request retries
      }
      const catalog = await catalogPromise;
      return catalog.find((m) => m.id === modelId);
    } catch (e: any) {
      console.error("[paws-proxy] catalog lookup failed:", e.message);
      return undefined;
    }
  }

  const server = createServer(async (req: any, res: any) => {

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

    // Chat completions — transparent pass-through with per-model adjustments
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions" || req.url === "/api/chat/completions")) {
      const auth = await getAuth();
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not authenticated" }));
        return;
      }

      let rawBody = "";
      for await (const chunk of req) rawBody += chunk;

      const body = JSON.parse(rawBody);
      const isStream = body.stream === true;

      // Backend rejects "developer" role — rewrite to "system" (Open WebUI v0.9.6)
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (m.role === "developer") m.role = "system";
        }
      }

      // DeepSeek reasoning models require reasoning_content on assistant messages
      // that have tool_calls (tool round-trip). Pi's SDK strips it because it's
      // non-standard. Inject a placeholder so the backend accepts the request.
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) {
          if (m.role === "assistant" && m.tool_calls && !m.reasoning_content) {
            m.reasoning_content = "";
          }
        }
      }

      rawBody = JSON.stringify(body);

      // Reasoning models split max_tokens between thinking + output.
      // Formula: max_tokens = min(modelCap, max(piSent * scale, floor))
      // where scale and floor come from per-model catalog data.
      const piSent = body.max_tokens;
      if (piSent) {
        const model = await getModelInfo(body.model, auth);
        const isReasoning = body.thinking || body.reasoning_effort || model?.reasoning;
        if (isReasoning) {
          if (model?.maxTokens) {
            body.max_tokens = Math.max(piSent, Math.min(model.maxTokens, 32000));
          } else {
            body.max_tokens = Math.max(piSent * 4, 16384);
          }
          rawBody = JSON.stringify(body);
        }
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120_000);
        const upstreamResp = await fetch(`${config.baseUrl}/api/chat/completions`, {
          method: "POST",
          headers: {
            ...buildAuthHeaders(auth),
            "Content-Type": "application/json",
          },
          body: rawBody,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (isStream) {
          res.writeHead(upstreamResp.status, sseHeaders());
          const reader = upstreamResp.body?.getReader();
          if (reader) {
            const decoder = new TextDecoder();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
            } finally {
              reader.releaseLock();
            }
          }
          res.end();
        } else {
          const data = await upstreamResp.json();
          res.writeHead(upstreamResp.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        }
      } catch (err: any) {
        console.error("[paws-proxy] error:", err.message);
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.end();
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[paws] port ${config.port} in use — killing stale proxy and retrying`);
      try {
        execSync(`fuser -k ${config.port}/tcp`, { stdio: "ignore" });
        setTimeout(() => server.listen(config.port), 500);
      } catch (e: any) {
        console.error(`[paws] failed to free port ${config.port}:`, e.message);
      }
    } else {
      console.error("[paws] proxy error:", err.message);
    }
  });

  server.listen(config.port);
  console.log(`Paws proxy listening on http://localhost:${config.port}`);

  return {
    port: config.port,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}
