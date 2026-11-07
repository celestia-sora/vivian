import "server-only";

import { NextResponse } from "next/server";
import { cache } from "react";
import { isAllowedUser, isSameOriginMutation } from "./policy";

// Vivian's server-side identity check (verify-based).
//
// Sign-in happens on the Cloudflare Workers app (vivianAuth, D1-backed),
// which issues an opaque session token the browser sends here as
// `Authorization: Bearer <token>`. This module verifies the token by
// calling vivianAuth's POST /api/verify with a shared internal token
// (VIVIAN_INTERNAL_TOKEN, must match the one configured on vivianAuth).
// It never trusts cookies (different registrable domains) or claims.

export interface AuthUser {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
}

interface AccessError {
  status: 401 | 403 | 503;
  code: "AUTH_REQUIRED" | "ACCESS_DENIED" | "AUTH_UNAVAILABLE";
  message: string;
}
type AccessResult = { user: AuthUser; error: null } | { user: null; error: AccessError };

const AUTH_TIMEOUT_MS = 8000;
function timeoutSignal(extra?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
  if (extra && typeof AbortSignal.any === "function") return AbortSignal.any([extra, timeout]);
  return timeout;
}

function getVerifyConfig(): { url: string; internalToken: string } | null {
  const base = process.env.VIVIANAUTH_URL?.trim();
  const internalToken = process.env.VIVIAN_INTERNAL_TOKEN?.trim();
  if (!base || !internalToken) return null;
  try {
    const parsed = new URL(base);
    const isLocalhost = ["localhost", "127.0.0.1"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) return null;
    return { url: `${base.replace(/\/$/, "")}/api/verify`, internalToken };
  } catch {
    return null;
  }
}

// Local preview only: NODE_ENV === "development" AND DEV_BYPASS_LOGIN=true.
// Production builds never honor the flag. API policy is otherwise unchanged.
function getDevBypassUser(): AuthUser | null {
  if (process.env.NODE_ENV !== "development") return null;
  if (process.env.DEV_BYPASS_LOGIN !== "true") return null;
  return { id: "dev-local-preview", email: "dev@localhost" };
}

export const getAuthAccess = cache(async (accessToken?: string): Promise<AccessResult> => {
  const devUser = getDevBypassUser();
  if (devUser) return { user: devUser, error: null };
  const config = getVerifyConfig();
  if (!config) return { user: null, error: { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is not configured" } };
  if (!accessToken) return { user: null, error: { status: 401, code: "AUTH_REQUIRED", message: "Please sign in" } };
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "X-Internal-Token": config.internalToken,
      },
      cache: "no-store",
      signal: timeoutSignal(),
    });
    if (response.status >= 500) return { user: null, error: { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable" } };
    const body = (await response.json().catch(() => null)) as { user?: AuthUser | null } | null;
    if (response.status === 403 || (response.status === 200 && body?.user && !isAllowedUser(body.user))) {
      return { user: null, error: { status: 403, code: "ACCESS_DENIED", message: "This account does not have access" } };
    }
    if (response.status !== 200 || !body?.user) return { user: null, error: { status: 401, code: "AUTH_REQUIRED", message: "Please sign in" } };
    return { user: body.user, error: null };
  } catch {
    return { user: null, error: { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable" } };
  }
});

export async function requireApiAccess(request: Request, onAuthorized?: (user: AuthUser) => void): Promise<NextResponse | null> {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Cross-site request rejected", status: 403, code: "ACCESS_DENIED" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (authorization && !bearer) {
    return NextResponse.json({ error: "Please sign in", status: 401, code: "AUTH_REQUIRED" }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
  }
  const { user, error } = await getAuthAccess(bearer);
  if (!error) { onAuthorized?.(user); return null; }
  return NextResponse.json({ error: error.message, status: error.status, code: error.code }, {
    status: error.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
