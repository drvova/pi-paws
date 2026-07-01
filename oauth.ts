/**
 * oauth.ts — Browser-based login for Pi's /login command.
 *
 * Flow:
 *   1. Open browser to ai.paws.best
 *   2. User authenticates (Google OAuth / Discord / email)
 *   3. User copies JWT from browser localStorage
 *   4. Extension validates and stores token
 *
 * Google OAuth uses a fixed redirect_uri on ai.paws.best,
 * so localhost loopback isn't possible. This is the standard
 * pattern for Open WebUI providers.
 */

import { getUserJwt, type AuthState } from "./auth";

export interface OAuthCredentials {
  token: string;
  expires: number;
}

function parseJwtExp(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.exp * 1000;
  } catch (e: any) {
    console.error("[paws-oauth] JWT expiry parse failed, assuming 1yr:", e.message);
    return Date.now() + 365 * 24 * 60 * 60 * 1000;
  }
}

export async function pawsOAuthLogin(
  baseUrl: string,
  callbacks: {
    onAuth: (info: { url: string }) => void;
    onPrompt: (prompt: { message: string }) => Promise<string>;
    onProgress?: (message: string) => void;
  },
): Promise<OAuthCredentials> {
  const loginUrl = `${baseUrl}`;
  callbacks.onAuth({ url: loginUrl });

  const token = await callbacks.onPrompt({
    message:
      "Login to Paws WebUI in the browser that just opened.\n\n" +
      "After logging in, open DevTools (F12) → Console, then paste this:\n\n" +
      "  copy(localStorage.token)\n\n" +
      "Paste the token here:",
  });

  if (!token) throw new Error("Login cancelled");

  const trimmed = token.trim();
  const resp = await fetch(`${baseUrl}/api/v1/auths/`, {
    headers: { Authorization: `Bearer ${trimmed}` },
  });
  if (!resp.ok) throw new Error("Token rejected by server — are you logged in?");

  callbacks.onProgress?.("Authenticated with Paws WebUI");
  return { token: trimmed, expires: parseJwtExp(trimmed) };
}

export async function pawsRefreshToken(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  try {
    const resp = await fetch("https://ai.paws.best/api/v1/auths/", {
      headers: { Authorization: `Bearer ${credentials.token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.token) return { token: data.token, expires: parseJwtExp(data.token) };
    }
  } catch (e: any) {
    console.error("[paws-oauth] token refresh failed:", e.message);
  }
  return credentials;
}

export function pawsGetApiKey(credentials: OAuthCredentials): string {
  return credentials.token;
}
