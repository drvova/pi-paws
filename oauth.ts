/**
 * oauth.ts — Email/password login for Pi's /login command.
 *
 * Uses Pi's OAuthLoginCallbacks interface: onPrompt for user input.
 */

import { getUserJwt } from "./auth";

export interface OAuthCredentials {
  token: string;
  expires: number;
}

export async function pawsOAuthLogin(
  baseUrl: string,
  callbacks: {
    onAuth: (info: { url: string }) => void;
    onPrompt: (prompt: { message: string }) => Promise<string>;
    onProgress?: (message: string) => void;
  },
): Promise<OAuthCredentials> {
  const email = await callbacks.onPrompt({ message: "Paws WebUI Email:" });
  if (!email) throw new Error("Login cancelled");

  const password = await callbacks.onPrompt({ message: "Paws WebUI Password:" });
  if (!password) throw new Error("Login cancelled");

  const auth = await getUserJwt(baseUrl, email.trim(), password);
  return { token: auth.token, expires: auth.payload.exp * 1000 };
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
      if (data.token) return { token: data.token, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
    }
  } catch {}
  return credentials;
}

export function pawsGetApiKey(credentials: OAuthCredentials): string {
  return credentials.token;
}
