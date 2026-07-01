/**
 * proxy.ts — Transparent OpenAI-compatible proxy.
 *
 * Receives requests from Pi on localhost, forwards to ai.paws.best
 * with auth headers. Passes SSE stream through unmodified.
 */

import type { AuthState } from "./auth";
import { buildAuthHeaders } from "./auth";

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

    // Chat completions — transparent pass-through
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
      const auth = await getAuth();
      if (!auth) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not authenticated" }));
        return;
      }

      let rawBody = "";
      for await (const chunk of req) rawBody += chunk;

      const body = JSON.parse(rawBody);
      const isStream = body.stream !== false;

      try {
        const upstreamResp = await fetch(`${config.baseUrl}/api/chat/completions`, {
          method: "POST",
          headers: {
            ...buildAuthHeaders(auth),
            "Content-Type": "application/json",
          },
          body: rawBody,
        });

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

  server.listen(config.port);
  console.log(`Paws proxy listening on http://localhost:${config.port}`);

  return {
    port: config.port,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}
