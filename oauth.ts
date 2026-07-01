/**
 * oauth.ts — Login loopback + RegisterUser.
 *
 * Provides OAuth-style login flow for Pi's /login command.
 * Opens a local loopback server to handle the OAuth redirect,
 * or falls back to email/password sign-in.
 */

import { getUserJwt } from "./auth";

const LOCALHOST_PORT = 18923;

export interface OAuthCallbacks {
  openUrl(url: string): Promise<void>;
  input(prompt: string): Promise<string>;
  notify(message: string): void;
}

export interface OAuthResult {
  credentials: { token: string };
}

function startLoopbackServer(): { port: number; waitForCode: () => Promise<string>; close: () => void } {
  const { createServer } = require("http");
  let resolveCode: ((code: string) => void) | null = null;
  const server = createServer((req: any, res: any) => {
    const url = new URL(req.url, `http://localhost`);
    const code = url.searchParams.get("code");
    if (code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Authenticated! You can close this window.</h1></body></html>");
      resolveCode?.(code);
    } else {
      res.writeHead(400);
      res.end("Missing code parameter");
    }
  });

  return {
    port: LOCALHOST_PORT,
    waitForCode: () =>
      new Promise<string>((resolve) => {
        resolveCode = resolve;
      }),
    close: () => server.close(),
  };
}

export async function pawsOAuthLogin(
  baseUrl: string,
  callbacks: OAuthCallbacks,
): Promise<OAuthResult> {
  // Try email/password flow via UI prompt
  const email = await callbacks.input("Paws WebUI Email:");
  if (!email) throw new Error("Login cancelled");

  const password = await callbacks.input("Paws WebUI Password:");
  if (!password) throw new Error("Login cancelled");

  const auth = await getUserJwt(baseUrl, email, password);
  callbacks.notify("Authenticated with Paws WebUI");
  return { credentials: { token: auth.token } };
}

export async function pawsRefreshToken(
  baseUrl: string,
  credentials: { token: string },
): Promise<OAuthResult> {
  // Re-validate existing token
  try {
    const resp = await fetch(`${baseUrl}/api/v1/auths/`, {
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.token) return { credentials: { token: data.token } };
    }
  } catch {}
  return { credentials };
}

export function pawsGetApiKey(credentials: { token: string }): string {
  return credentials.token;
}
