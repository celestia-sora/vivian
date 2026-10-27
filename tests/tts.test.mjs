import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as speech from "../lib/speech.ts";

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL("../app/api/tts/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function handler(fetch, denied = null, payload = { text: "สวัสดีค่ะ", language: "th" }) {
  const exports = {};
  const logs = [];
  runInNewContext(source, {
    exports, fetch, Error,
    // Use fixture credentials only; do not read or contact production providers.
    process: { env: { ELEVENLABS_API_KEY: "fixture-key", ELEVENLABS_VOICE_ID: "fixture-voice" } },
    AbortSignal: { timeout(ms) { assert.equal(ms, 14000); return AbortSignal.timeout(15); } },
    console: { warn: (...args) => logs.push(args), info: (...args) => logs.push(args) },
    require(name) {
      if (name === "@/lib/auth/server") return { requireApiAccess: async () => denied };
      if (name === "@/lib/rate-limit") return { rateLimit: () => ({ allowed: true }) };
      if (name === "@/lib/speech") return speech;
      if (name === "next/server") return require("next/server");
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { post: () => exports.POST(new Request("https://vivian.example/api/tts", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  })), logs };
}

function interruptedAudio(error) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([73, 68, 51]));
    queueMicrotask(() => controller.error(error));
  } }));
}

for (const name of ["TimeoutError", "AbortError"]) {
  test(`timeout after successful headers and partial audio (${name}) returns controlled JSON`, async () => {
    const error = new Error("provider stalled"); error.name = name;
    const fixture = handler(async () => interruptedAudio(error));
    const response = await fixture.post();
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, "TTS_TIMEOUT");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(fixture.logs[0][1].phase, "audio");
  });
}

test("the upstream deadline remains active while reading the audio body", async () => {
  const fixture = handler(async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([73, 68, 51]));
    signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
  } })));
  // Keep the event loop alive for the shortened AbortSignal timeout.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const response = await fixture.post();
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, "TTS_TIMEOUT");
  } finally { clearTimeout(keepAlive); }
});

test("network failures before headers and during audio return 502", async () => {
  for (const fetch of [async () => { throw new TypeError("network unavailable"); }, async () => interruptedAudio(new TypeError("socket closed"))]) {
    const response = await handler(fetch).post();
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "TTS_UPSTREAM");
  }
});

test("complete MP3 is preserved; empty audio and provider rejections stay JSON errors", async () => {
  const audio = new Uint8Array([73, 68, 51, 1, 2, 3]);
  const success = await handler(async () => new Response(audio)).post();
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual(new Uint8Array(await success.arrayBuffer()), audio);
  const empty = await handler(async () => new Response(new Uint8Array())).post();
  assert.equal(empty.status, 502);
  assert.equal((await empty.json()).code, "TTS_UPSTREAM");
  const rejected = await handler(async () => new Response("rate limited", { status: 429 })).post();
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, "TTS_UPSTREAM");
});

test("access denial stops synthesis before contacting ElevenLabs", async () => {
  const denied = Response.json({ code: "AUTH_REQUIRED" }, { status: 401 });
  assert.equal(await handler(async () => { assert.fail("ElevenLabs must not be called"); }, denied).post(), denied);
});

test("v4 character limit is checked after spoken text preparation", async () => {
  const tooLong = await handler(async () => { assert.fail("Over-limit text must be rejected before the upstream request"); }, null, { text: "ก".repeat(2001), language: "th" }).post();
  assert.equal(tooLong.status, 400);
  assert.match((await tooLong.json()).error, /2000 characters/);
});

test("actual ElevenLabs payload preserves tags from multiple v4 categories with the configured voice and Thai language", async () => {
  const text = "(กอดอก) [tired] ราคา 1,250 บาท [chuckling] ลด 15% [whispering] ด- ด- เดี๋ยว! [keyboard typing]";
  const fixture = handler(async (url, options) => {
    assert.equal(url, "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=mp3_44100_128");
    assert.equal(options.headers["xi-api-key"], "fixture-key");
    const body = JSON.parse(options.body);
    assert.equal(body.model_id, "eleven_v4");
    assert.deepEqual(body.inputs, [{ text: "[tired] ราคา หนึ่งพันสองร้อยห้าสิบบาท [chuckling] ลด สิบห้าเปอร์เซ็นต์ [whispering] ด… ด… เดี๋ยว! [keyboard typing]", voice_id: "fixture-voice" }]);
    assert.equal(body.language_code, "th");
    assert.equal(body.apply_text_normalization, "auto");
    return new Response(new Uint8Array([73, 68, 51]));
  }, null, { text, language: "th" });
  assert.equal((await fixture.post()).status, 200);
  assert.equal(text, "(กอดอก) [tired] ราคา 1,250 บาท [chuckling] ลด 15% [whispering] ด- ด- เดี๋ยว! [keyboard typing]");
});
