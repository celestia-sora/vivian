"use client";

// Bearer token handoff helpers for the Cloudflare sign-in flow.
//
// The Cloudflare login (vivianAuth on Workers, D1-backed) issues an opaque
// session token. After a successful sign-in it redirects to the Vivian app
// with `#token=<token>` appended. This app's client consumes that fragment
// (or reads the stored token on later visits — the session persists until
// logout, up to the server-side expiry), and sends the token as
// `Authorization: Bearer <token>` on every API call (see authFetch and the
// API routes' requireApiAccess, which verify via vivianAuth /api/verify).
export const TOKEN_KEY = "vivian_auth_token";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
}

export async function authFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = getAuthToken();
  const headers = new Headers(options?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 || response.status === 403) {
    const reason = response.status === 403 ? "access_denied" : "session_expired";
    window.location.replace(`/login?error=${reason}`);
  }
  return response;
}
