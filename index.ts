/**
 * index.ts — Pi extension entry (provider registration + model building).
 *
 * Registers ai.paws.best as a Pi provider, fetches the live model catalog,
 * and wires up the OAuth login flow for /login support.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getStoredToken, refreshJwt, clearToken, type AuthState } from "./auth";
import { getCatalog, fetchCatalog } from "./catalog";
import { catalogToPiModels } from "./models";
import { pawsOAuthLogin, pawsRefreshToken, pawsGetApiKey } from "./oauth";

const PROVIDER_NAME = "paws";
const BASE_URL = "https://ai.paws.best";

function buildProviderConfig(authToken: string, models: any[]) {
  return {
    name: "Paws WebUI",
    baseUrl: BASE_URL,
    apiKey: authToken,
    api: "openai-completions",
    models,
    oauth: {
      name: "Paws WebUI",
      login: (callbacks: any) => pawsOAuthLogin(BASE_URL, callbacks),
      refreshToken: (creds: any) => pawsRefreshToken(BASE_URL, creds),
      getApiKey: (creds: any) => pawsGetApiKey(creds),
    },
  };
}

function modelsToPi(catalog: any[]) {
  return catalogToPiModels(catalog, BASE_URL).map((m) => ({
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    headers: m.headers,
    compat: m.compat,
  }));
}

export default async function (pi: ExtensionAPI) {
  const stored = getStoredToken();
  let hasCreds = !!stored;

  if (hasCreds) {
    try {
      const auth = await refreshJwt(BASE_URL);
      if (auth) {
        const catalog = await getCatalog(BASE_URL, auth);
        const models = modelsToPi(catalog);
        pi.registerProvider(PROVIDER_NAME, buildProviderConfig(auth.token, models));
        console.error(`[paws] connected — ${models.length} models`);
      } else {
        hasCreds = false;
      }
    } catch {
      hasCreds = false;
    }
  }

  if (!hasCreds) {
    pi.registerProvider(PROVIDER_NAME, buildProviderConfig("", []));
    console.error("[paws] /login paws to connect");
  }

  // Re-register models after login
  pi.on("session_start", async () => {
    const auth = getStoredToken();
    if (auth) {
      try {
        const refreshed = await refreshJwt(BASE_URL);
        if (refreshed) {
          const catalog = await getCatalog(BASE_URL, refreshed);
          const models = modelsToPi(catalog);
          pi.registerProvider(PROVIDER_NAME, buildProviderConfig(refreshed.token, models));
          console.error(`[paws] connected — ${models.length} models`);
        }
      } catch {}
    }
  });

  // Register /paws command
  pi.registerCommand("paws", {
    description: "Refresh Paws model catalog or show status",
    handler: async (args, ctx) => {
      const subcommand = args.trim().split(/\s+/)[0];

      if (subcommand === "logout") {
        clearToken();
        ctx.ui.notify("Paws: Logged out", "info");
        return;
      }

      if (subcommand === "status") {
        const token = getStoredToken();
        if (token) {
          const expires = new Date(token.payload.exp * 1000).toLocaleString();
          ctx.ui.notify(`Paws: Authenticated (expires ${expires})`, "info");
        } else {
          ctx.ui.notify("Paws: Not authenticated", "warning");
        }
        return;
      }

      // Default: refresh catalog
      const auth = getStoredToken();
      if (!auth) {
        ctx.ui.notify("Not authenticated. Use /login paws first.", "warning");
        return;
      }
      try {
        const refreshed = await refreshJwt(BASE_URL);
        if (!refreshed) {
          ctx.ui.notify("Paws: Token expired. Use /login paws.", "error");
          return;
        }
        const catalog = await fetchCatalog(BASE_URL, refreshed);
        const models = modelsToPi(catalog);
        pi.registerProvider(PROVIDER_NAME, buildProviderConfig(refreshed.token, models));
        ctx.ui.notify(`Paws: Refreshed ${models.length} models`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Paws: Refresh failed: ${err.message}`, "error");
      }
    },
  });
}
