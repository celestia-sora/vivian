// Local vivianAuth-verify fixture only.
// Emulates vivianAuth's POST /api/verify (shared internal token + Bearer
// session token → user). No Google credentials or live data are used.
import { createServer } from "node:http";
import { once } from "node:events";

export const internalToken = "test-internal-token";

export const fixtureEmails = {
  first: "suphloeksangko@gmail.com",
  second: "duckchan690@gmail.com",
  denied: "stranger@example.com",
  unverified: "duckchan690@gmail.com",
};

export function sessionToken(kind) {
  return `token-${kind}`;
}

export function userFor(kind) {
  return {
    id: kind === "second" ? "00000000-0000-0000-0000-000000000002" : "00000000-0000-0000-0000-000000000001",
    email: fixtureEmails[kind],
    email_confirmed_at: kind === "unverified" || kind === "denied" ? null : "2026-10-02T00:00:00Z",
    is_anonymous: false,
    created_at: "2026-10-02T00:00:00Z",
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    aud: "authenticated",
  };
}

export async function startVerifyFixture() {
  const calls = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ path: url.pathname, headers: request.headers });
    const send = (status, data) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
    if (url.pathname === "/api/verify") {
      if (request.headers["x-internal-token"] !== internalToken) {
        return send(401, { error: "Unauthorized", status: 401, code: "AUTH_REQUIRED" });
      }
      const authorization = request.headers.authorization ?? "";
      const token = authorization.replace(/^Bearer\s+/i, "");
      const kind = Object.keys(fixtureEmails).find((k) => sessionToken(k) === token);
      if (!kind) return send(401, { error: "Please sign in", status: 401, code: "AUTH_REQUIRED" });
      const user = userFor(kind);
      if (!user.email_confirmed_at) return send(403, { error: "This account does not have access", status: 403, code: "ACCESS_DENIED" });
      return send(200, { user });
    }
    return send(404, { message: "Unknown fixture endpoint" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, calls, url: `http://127.0.0.1:${server.address().port}` };
}
