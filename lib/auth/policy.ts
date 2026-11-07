// Local AuthUser shape (verified identity from vivianAuth /api/verify).
export interface AuthUserLike {
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean;
}

// A non-anonymous account with a confirmed email can access. Anonymous
// and unverified identities are rejected, including forged
// user_metadata claims.
export function isAllowedUser(user: AuthUserLike | null): boolean {
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
