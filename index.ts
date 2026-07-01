/**
 * index.ts — Pi extension entry (provider registration + model building).
 *
 * Registers ai.paws.best as a Pi provider, fetches the live model catalog,
 * and wires up the OAuth login flow for /login support.
 *
 * Architecture:
 *   catalog.ts  -> fetches models from /api/models
 *   models.ts   -> converts catalog to Pi ProviderModelConfig[]
 *   auth.ts     -> JWT lifecycle (decode, refresh, mint)
 *   oauth.ts    -> /login flow (email/password)
 *   chat.ts     -> streaming chat completions
 *   proxy.ts    -> optional local HTTP proxy
 *   metadata.ts -> Connect-RPC headers
 *   wire.ts     -> protobuf wire format helpers
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getStoredToken, refreshJwt, clearToken, type AuthState } from "./auth.js";
import { getCatalog, fetchCatalog } from "./catalog.js";
import { catalogToPiModels } from "./models.js";
import { pawsOAuthLogin, pawsRefreshToken, pawsGetApiKey } from "./oauth.js";

const PROVIDER_NAME = "paws";
const BASE_URL = "https://ai.paws.best";

export default function pawsExtension(pi: ExtensionAPI) {
  let currentAuth: AuthState | null = null;

  async function ensureAuth(): Promise<AuthState | null> {
    if (currentAuth) return currentAuth;
    currentAuth = getStoredToken();
    if (currentAuth) {
      currentAuth = await refreshJwt(BASE_URL);
    }
    return currentAuth;
  }

  async function loadAndRegisterModels() {
    const auth = await ensureAuth();
    if (!auth) {
      // Register with placeholder until auth is available
      pi.registerProvider(PROVIDER_NAME, {
        name: "Paws WebUI",
        baseUrl: BASE_URL,
        api: "openai-completions",
        apiKey: "paws-placeholder",
        models: [
          {
            id: "deepseek.deepseek-v4-flash",
            name: "Deepseek v4 Flash (Paws)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131_072,
            maxTokens: 8_192,
          },
        ],
      });
      return;
    }

    try {
      const catalog = await getCatalog(BASE_URL, auth);
      const models = catalogToPiModels(catalog, BASE_URL);

      pi.registerProvider(PROVIDER_NAME, {
        name: "Paws WebUI",
        baseUrl: BASE_URL,
        apiKey: auth.token,
        api: "openai-completions",
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          thinkingLevelMap: m.thinkingLevelMap,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          headers: m.headers,
          compat: m.compat,
        })),
        oauth: {
          name: "Paws WebUI",
          login: (callbacks) => pawsOAuthLogin(BASE_URL, callbacks),
          refreshToken: (creds) => pawsRefreshToken(BASE_URL, creds),
          getApiKey: (creds) => pawsGetApiKey(creds),
        },
      });
    } catch (err: any) {
      console.error("Paws: Failed to load catalog:", err.message);
      pi.registerProvider(PROVIDER_NAME, {
        name: "Paws WebUI",
        baseUrl: BASE_URL,
        api: "openai-completions",
        apiKey: auth.token,
        models: [
          {
            id: "deepseek.deepseek-v4-flash",
            name: "Deepseek v4 Flash (Paws)",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131_072,
            maxTokens: 8_192,
          },
        ],
      });
    }
  }

  // Load on startup
  loadAndRegisterModels();

  // Refresh token before each provider request
  pi.on("before_provider_request", async (event, ctx) => {
    const auth = await ensureAuth();
    if (auth && ctx.model?.provider === PROVIDER_NAME) {
      // Attach auth headers to the outgoing request
      const payload = event.payload as any;
      if (payload && typeof payload === "object") {
        payload._pawsHeaders = {
          Authorization: `Bearer ${auth.token}`,
          Cookie: `token=${auth.token}`,
        };
      }
    }
  });

  // Re-register models after login
  pi.on("session_start", async () => {
    const auth = getStoredToken();
    if (auth) {
      currentAuth = auth;
      await loadAndRegisterModels();
    }
  });

  // Register /paws command for manual refresh
  pi.registerCommand("paws", {
    description: "Refresh Paws model catalog or show status",
    handler: async (args, ctx) => {
      const auth = await ensureAuth();
      if (!auth) {
        ctx.ui.notify("Not authenticated. Use /login to sign in.", "warning");
        return;
      }
      const subcommand = args.trim().split(/\s+/)[0];
      if (subcommand === "refresh" || subcommand === "") {
        try {
          const catalog = await fetchCatalog(BASE_URL, auth);
          const models = catalogToPiModels(catalog, BASE_URL);
          pi.registerProvider(PROVIDER_NAME, {
            name: "Paws WebUI",
            baseUrl: BASE_URL,
            apiKey: auth.token,
            api: "openai-completions",
            models: models.map((m) => ({
              id: m.id,
              name: m.name,
              reasoning: m.reasoning,
              thinkingLevelMap: m.thinkingLevelMap,
              input: m.input,
              cost: m.cost,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
              compat: m.compat,
            })),
          });
          ctx.ui.notify(`Paws: Refreshed ${models.length} models`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Paws: Refresh failed: ${err.message}`, "error");
        }
      } else if (subcommand === "logout") {
        clearToken();
        currentAuth = null;
        ctx.ui.notify("Paws: Logged out", "info");
      } else if (subcommand === "status") {
        const token = getStoredToken();
        if (token) {
          const expires = new Date(token.payload.exp * 1000).toLocaleString();
          ctx.ui.notify(`Paws: Authenticated (expires ${expires})`, "info");
        } else {
          ctx.ui.notify("Paws: Not authenticated", "warning");
        }
      }
    },
  });
}
