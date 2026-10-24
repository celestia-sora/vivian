import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getAuthConfiguration } from "@/lib/auth/config";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "@/lib/auth/cookie-config";

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  if (request.nextUrl.pathname.startsWith("/api/")) return response;
  const configuration = getAuthConfiguration();
  if (!configuration) return response;
  const supabase = createServerClient(configuration.url, configuration.publishableKey, {
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) }) },
    cookieOptions: { sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: SESSION_COOKIE_MAX_AGE_SECONDS },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
        response.headers.set("Cache-Control", "private, no-store");
      },
    },
  });
  try {
    await supabase.auth.getClaims();
  } catch {
    // The page's independent getUser check will fail closed if Auth is unavailable.
  }
  return response;
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
