import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startVerifyFixture, internalToken, sessionToken } from "./auth-fixture.mjs";

// Adapted to the Cloudflare-login flow: Vivian's API routes validate a
// Bearer session token by calling vivianAuth's POST /api/verify (shared
// internal token). The fixture below emulates that verify endpoint.
// `/` is now client-gated (Companion) and always renders; the server
// enforcement lives on the protected APIs.
const root = fileURLToPath(new URL("..", import.meta.url));
const apps = [];
let fixture, base, lockedBase;

async function startApp(overrides = {}) {
  const env = {
    ...process.env,
    VIVIANAUTH_URL: fixture.url,
    VIVIAN_INTERNAL_TOKEN: internalToken,
    NEXT_PUBLIC_SUPABASE_URL: fixture.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_local_test_only",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    SUPABASE_URL: fixture.url,
    SUPABASE_SERVICE_ROLE_KEY: "",
    // Realtime config is still needed by /api/realtime/config tests? No —
    // realtime returns config from env directly; give it fixture values.
    GROQ_API_KEY: "",
    CEREBRAS_API_KEY: "",
    GEMINI_API_KEY: "",
    FISH_AUDIO_API_KEY: "",
    TYPESAFE_API_KEY: "",
    JEV_API_KEY: "",
    OPENROUTER_API_KEY: "",
    ...overrides,
  };
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "0", "-H", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  apps.push(child);
  let output = "";
  const collect = (chunk) => { output += chunk; };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  for (let attempt = 0; attempt < 150; attempt++) {
    const address = output.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
    if (address) {
      try { const response = await fetch(`${address}/login`); if (response.ok) return address; } catch { /* wait */ }
    }
    if (child.exitCode !== null) throw new Error(`Next start failed: ${output}`);
    await delay(200);
  }
  throw new Error("Local Auth test app did not start");
}

before(async () => {
  fixture = await startVerifyFixture();
  base = await startApp();
  lockedBase = await startApp({ VIVIAN_INTERNAL_TOKEN: "" });
}, { timeout: 60000 });

after(async () => {
  for (const child of apps) child.kill("SIGTERM");
  if (fixture) await new Promise((resolve) => fixture.server.close(resolve));
});

const call = (path, options = {}) => fetch(`${base}${path}`, { redirect: "manual", ...options });
const routeKinds = [
  ["/api/conversations", "GET"], ["/api/conversations", "PUT"], ["/api/chat", "POST"],
  ["/api/stt", "POST"], ["/api/tts", "POST"], ["/api/memory", "GET"], ["/api/memory", "POST"],
  ["/api/memory", "PATCH"], ["/api/memory", "DELETE"], ["/api/jev/status", "GET"],
  ["/api/scenes", "GET"], ["/api/scenes", "POST"], ["/api/scenes/preview", "POST"],
  ["/api/scenes/preferences", "PATCH"], ["/api/scenes/00000000-0000-4000-8000-000000000001", "PATCH"],
  ["/api/scenes/00000000-0000-4000-8000-000000000001", "DELETE"], ["/api/scenes/00000000-0000-4000-8000-000000000001/image", "GET"],
  ["/api/storage/status", "GET"], ["/api/models", "GET"], ["/api/models", "POST"],
  ["/api/models/00000000-0000-4000-8000-000000000001", "GET"], ["/api/models/00000000-0000-4000-8000-000000000001", "POST"],
  ["/api/models/00000000-0000-4000-8000-000000000001", "DELETE"], ["/api/models/00000000-0000-4000-8000-000000000001/parts?first=1", "POST"],
  ["/api/voice/preferences", "GET"], ["/api/custom-instructions", "GET"], ["/api/realtime/config", "GET"],
];

test("signed-out users cannot access any protected API", async () => {
  for (const [path, method] of routeKinds) {
    const response = await call(path, { method, headers: { "x-user-email": "suphloeksangko@gmail.com", cookie: "email=suphloeksangko@gmail.com" } });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((await response.json()).code, "AUTH_REQUIRED");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("verified accounts are allowed and forged claims are ignored", async () => {
  for (const kind of ["first", "second"]) {
    const response = await call("/api/jev/status", { headers: { authorization: `Bearer ${sessionToken(kind)}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: false });
  }
  for (const kind of ["denied", "unverified"]) {
    for (const [path, method] of routeKinds) {
      const response = await call(path, { method, headers: { authorization: `Bearer ${sessionToken(kind)}` } });
      assert.equal(response.status, 403, `${kind}: ${method} ${path}`);
    }
  }
  assert.equal((await call("/api/jev/status", { headers: { authorization: "Bearer token-first-x" } })).status, 401);
  assert.equal((await call("/api/jev/status", { headers: { authorization: `Bearer ${sessionToken("first")}`, cookie: "email=suphloeksangko@gmail.com" } })).status, 200);
});

test("missing configuration fails closed", async () => {
  const locked = await fetch(`${lockedBase}/api/jev/status`);
  assert.equal(locked.status, 503);
  assert.equal((await locked.json()).code, "AUTH_UNAVAILABLE");
});

test("mutations reject cross-site origins", async () => {
  const response = await call("/api/memory", { method: "POST", headers: { authorization: `Bearer ${sessionToken("first")}`, origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  const malformed = await call("/api/memory", { method: "POST", headers: { authorization: "Bearer not a token" } });
  assert.equal(malformed.status, 401);
});
