import "server-only";

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cache } from "react";
import { getAuthConfiguration } from "./config";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "./cookie-config";
import { isAllowedUser, isSameOriginMutation } from "./policy";

export async function createAuthServerClient(): Promise<SupabaseClient | null> {
  const configuration = getAuthConfiguration();
  if (!configuration) return null;
  const cookieStore = await cookies();
  return createServerClient(configuration.url, configuration.publishableKey, {
    global: {
      fetch: (input, init) => fetch(input, {
        ...init,
        cache: "no-store",
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      }),
    },
    cookieOptions: { sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_COOKIE_MAX_AGE_SECONDS },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Components cannot write cookies; proxy.ts refreshes them.
        }
      },
    },
  });
}

interface AccessError {
  status: 401 | 403 | 503;
  code: "AUTH_REQUIRED" | "ACCESS_DENIED" | "AUTH_UNAVAILABLE";
  message: string;
}

type AccessResult = { user: User; error: null } | { user: null; error: AccessError };

// Local preview only: NODE_ENV === "development" AND DEV_BYPASS_LOGIN=true in .env.local.
// Production builds never honor the flag, and API auth policy is unchanged.
function getDevBypassUser(): User | null {
  if (process.env.NODE_ENV !== "development") return null;
  if (process.env.DEV_BYPASS_LOGIN !== "true") return null;
  return {
    id: "dev-local-preview",
    email: "dev@localhost",
    app_metadata: { provider: "dev-bypass" },
    user_metadata: {},
    aud: "dev-bypass",
    created_at: new Date(0).toISOString(),
  } as unknown as User;
}

export const getAuthAccess = cache(async (accessToken?: string): Promise<AccessResult> => {
  const devUser = getDevBypassUser();
  if (devUser) return { user: devUser, error: null };
  try {
    const supabase = await createAuthServerClient();
    if (!supabase) return { user: null, error: { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is not configured" } };
    // getUser validates with Supabase Auth. Never trust getSession or an email cookie.
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    if (error && (!error.status || error.status >= 500)) {
      return { user: null, error: { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable" } };
    }
    if (error || !user) return { user: null, error: { status: 401, code: "AUTH_REQUIRED", message: "Please sign in" } };
    if (!isAllowedUser(user)) return { user: null, error: { status: 403, code: "ACCESS_DENIED", message: "This account does not have access" } };
    return { user, error: null };
  } catch {
    return { user: null, error: { status: 503, code: "AUTH_UNAVAILABLE", message: "Sign-in is temporarily unavailable" } };
  }
});

export async function requireApiAccess(request: Request, onAuthorized?: (user: User) => void): Promise<NextResponse | null> {
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
