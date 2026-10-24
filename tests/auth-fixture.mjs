// Local Auth fixture only. No Google credentials or live Supabase data are used.
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";

export const emails = { first: "suphloeksangko@gmail.com", second: "duckchan690@gmail.com", denied: "stranger@example.com", unverified: "duckchan690@gmail.com" };
export const verifier = "local-test-pkce-verifier";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function session(kind, expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const user = { id: kind === "second" ? "00000000-0000-0000-0000-000000000002" : "00000000-0000-0000-0000-000000000001", aud: "authenticated", email: emails[kind], email_confirmed_at: kind === "unverified" || kind === "denied" ? null : "2026-10-02T00:00:00Z", created_at: "2026-10-02T00:00:00Z", app_metadata: { provider: "google", providers: ["google"] }, user_metadata: {}, identities: [], is_anonymous: false };
  return { access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: user.id, exp: expiresAt, email: user.email, kind })}.test-signature`, refresh_token: `refresh-${kind}`, expires_in: 3600, expires_at: expiresAt, token_type: "bearer", user };
}

export function sessionCookie(kind, options = {}) {
  const value = session(kind, options.expiresAt);
  if (options.forgedEmail) value.user.email = options.forgedEmail;
  return `sb-127-auth-token=base64-${encode(value)}`;
}

export function verifierCookie(flowId) {
  return `sb-127-auth-token${flowId ? `-flow-${flowId}` : ""}-code-verifier=base64-${encode(verifier)}`;
}

export async function startAuthFixture() {
  const calls = [];
  let browserChallenge;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) : {};
    calls.push({ path: url.pathname, grant: url.searchParams.get("grant_type"), payload });
    const send = (status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
    if (url.pathname === "/auth/v1/user") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const kind = Object.keys(emails).find((key) => session(key).access_token === token);
      // exp changes at second boundaries; accept the fixture's own HS256-shaped token only.
      let decoded;
      try { decoded = JSON.parse(Buffer.from(token.split(".")[1], "base64url")); } catch { /* invalid token */ }
      if (token?.endsWith(".test-signature") && emails[decoded?.kind] && decoded.exp > Math.floor(Date.now() / 1000)) return send(200, session(kind ?? decoded.kind).user);
      return send(401, { message: "Invalid token", code: "bad_jwt" });
    }
    if (url.pathname === "/auth/v1/token") {
      if (url.searchParams.get("grant_type") === "refresh_token" && payload.refresh_token === "refresh-first") return send(200, session("first"));
      if (url.searchParams.get("grant_type") === "pkce" && payload.code_verifier === verifier) {
        if (payload.auth_code === "allowed-code") return send(200, session("first"));
        if (payload.auth_code === "denied-code") return send(200, session("denied"));
      }
      if (url.searchParams.get("grant_type") === "pkce" && browserChallenge && createHash("sha256").update(payload.code_verifier ?? "").digest("base64url") === browserChallenge) {
        if (payload.auth_code === "browser-allowed-code") return send(200, session("first"));
        if (payload.auth_code === "browser-denied-code") return send(200, session("denied"));
      }
      return send(400, { message: "Invalid OAuth code or verifier", code: "validation_failed" });
    }
    if (url.pathname === "/auth/v1/logout") { response.writeHead(204); return response.end(); }
    if (url.pathname === "/auth/v1/.well-known/jwks.json") return send(200, { keys: [] });
    if (url.pathname === "/auth/v1/authorize") {
      const callback = new URL(url.searchParams.get("redirect_to"));
      if (!["localhost", "127.0.0.1"].includes(callback.hostname)) return send(400, { message: "Only local fixture redirects are allowed" });
      browserChallenge = url.searchParams.get("code_challenge");
      callback.searchParams.set("code", "browser-allowed-code");
      const allowed = callback.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      callback.searchParams.set("code", "browser-denied-code");
      const denied = callback.toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      response.writeHead(200, { "Content-Type": "text/html" });
      return response.end(`<h1>Local Google OAuth request received</h1><p>This test does not contact Google.</p><p><a href="${allowed}">Continue as invited test account</a></p><p><a href="${denied}">Continue as uninvited test account</a></p>`);
    }
    return send(404, { message: "Unknown local fixture endpoint" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}
