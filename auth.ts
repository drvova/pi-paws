/**
 * auth.ts — JWT minting via GetUserJwt.
 *
 * Single source of truth for token lifecycle: decode expiry, refresh via
 * the backend GetUserJwt endpoint, and hold the current bearer token.
 */

export interface JwtPayload {
  id: string;
  exp: number;
  jti: string;
}

export interface AuthState {
  token: string;
  payload: JwtPayload;
}

const TOKEN_STORAGE_KEY = "paws.jwt";

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function getCredentialsPath(): string {
  const dir = path.join(os.homedir(), ".pi", "credentials");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "paws.json");
}

let currentAuth: AuthState | null = null;

export function decodeJwt(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT: expected 3 parts");
  const payload = JSON.parse(atob(parts[1]));
  return { id: payload.id, exp: payload.exp, jti: payload.jti };
}

export function isExpired(auth: AuthState, bufferSeconds = 300): boolean {
  return Date.now() / 1000 > auth.payload.exp - bufferSeconds;
}

export function getStoredToken(): AuthState | null {
  if (currentAuth) return currentAuth;
  // Try file storage (Node.js runtime)
  try {
    const p = getCredentialsPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      if (data.token) {
        const payload = decodeJwt(data.token);
        currentAuth = { token: data.token, payload };
        return currentAuth;
      }
    }
  } catch {}
  // Fallback to localStorage (browser runtime)
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_STORAGE_KEY) : null;
  if (!raw) return null;
  try {
    const payload = decodeJwt(raw);
    currentAuth = { token: raw, payload };
    return currentAuth;
  } catch {
    return null;
  }
}

export function setToken(token: string): AuthState {
  const payload = decodeJwt(token);
  currentAuth = { token, payload };
  // File storage (Node.js runtime)
  try {
    const p = getCredentialsPath();
    fs.writeFileSync(p, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  } catch {}
  // localStorage (browser runtime)
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  return currentAuth;
}

export function clearToken(): void {
  currentAuth = null;
  try {
    const p = getCredentialsPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export async function getUserJwt(baseUrl: string, email: string, password: string): Promise<AuthState> {
  const resp = await fetch(`${baseUrl}/api/v1/auths/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`SignIn failed (${resp.status}): ${body}`);
  }
  const data = await resp.json();
  return setToken(data.token);
}

export async function refreshJwt(baseUrl: string): Promise<AuthState | null> {
  const stored = getStoredToken();
  if (!stored) return null;
  if (!isExpired(stored)) return stored;
  // Re-authenticate with stored token as cookie
  try {
    const resp = await fetch(`${baseUrl}/api/v1/auths/`, {
      headers: { Authorization: `Bearer ${stored.token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.token) return setToken(data.token);
    return stored;
  } catch {
    return null;
  }
}

export function buildAuthHeaders(auth: AuthState): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.token}`,
    Cookie: `token=${auth.token}`,
  };
}
