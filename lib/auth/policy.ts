import type { User } from "@supabase/supabase-js";

// Temporary hackathon access: allow any Supabase-authenticated account with a
// confirmed email. Keep rejecting anonymous and unverified identities.
export function isAllowedUser(user: Pick<User, "email" | "email_confirmed_at" | "is_anonymous"> | null): boolean {
  return Boolean(user && !user.is_anonymous && user.email?.trim() && user.email_confirmed_at);
}

export function isSameOriginMutation(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  // Next may normalize request.url to its internal hostname. Host identifies
  // the origin the browser actually requested; no forwarded-host redirect is used.
  const target = new URL(request.url);
  const host = request.headers.get("host");
  if (host) target.host = host;
  return origin === target.origin;
}
