import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as values from "../lib/voice-preferences.ts";
const source = ts.transpileModule(readFileSync(new URL("../app/api/voice/preferences/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
let stored;
function handler(denied = null, unavailable = false, legacy = false) {
  const exports = {};
  runInNewContext(source, { exports, Response, Error, Date, AbortSignal, require(name) {
    if (name === "@/lib/auth/server") return { requireApiAccess: async () => denied };
    if (name === "@/lib/voice-preferences") return values;
    if (name === "@/lib/supabase-admin") return { getSupabaseAdmin() {
      if (unavailable) throw new Error();
      return { from(table) {
        assert.equal(table, "vivian_voice_preferences");
        let candidate;
        let selected;
        const query = {
          upsert(row, options) {
            assert.equal(row.id, "global");
            assert.equal(options.onConflict, "id");
            candidate = { ...stored, ...row };
            return query;
          },
          select(columns) { assert.ok(["speaking_speed,speech_language", "speaking_speed"].includes(columns)); selected = columns; return query; },
          eq(column, key) { assert.equal(column, "id"); assert.equal(key, "global"); return query; },
          async single() {
            if (legacy && selected.includes("speech_language")) return { data: null, error: { message: "column vivian_voice_preferences.speech_language does not exist" } };
            stored = candidate;
            return { data: stored, error: null };
          },
          async maybeSingle() {
            if (legacy && selected.includes("speech_language")) return { data: null, error: { message: "Could not find the 'speech_language' column of 'vivian_voice_preferences' in the schema cache" } };
            return { data: stored ?? null, error: null };
          },
        }; return query;
      } };
    } };
    throw new Error(name);
  } });
  return exports;
}
const request = value => new Request("https://vivian.example/api/voice/preferences", { method: "PATCH", body: JSON.stringify(value) });
test("speed survives a new handler/account and uses one shared singleton", async () => {
  stored = undefined;
  assert.equal((await (await handler().GET(new Request("https://vivian.example"))).json()).speakingSpeed, .98);
  const saved = await handler().PATCH(request({ speakingSpeed: 1.06, userId: "ignored-account" }));
  assert.equal(saved.status, 200);
  const loaded = await handler().GET(new Request("https://vivian.example"));
  assert.equal((await loaded.json()).speakingSpeed, 1.06);
  assert.equal(loaded.headers.get("cache-control"), "private, no-store");
});
test("speech language is shared globally and survives an account switch", async () => {
  stored = undefined;
  const defaults = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(defaults.speechLanguage, "th");
  const saved = await handler().PATCH(request({ speechLanguage: "en" }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).speechLanguage, "en");
  const other = await (await handler().GET(new Request("https://vivian.example"))).json();
  assert.equal(other.speechLanguage, "en");
  assert.equal(other.speakingSpeed, .98);
});
test("speed and language can be written together without dropping either", async () => {
  stored = undefined;
  const saved = await handler().PATCH(request({ speakingSpeed: 1.02, speechLanguage: "ja" }));
  const data = await saved.json();
  assert.equal(data.speakingSpeed, 1.02);
  assert.equal(data.speechLanguage, "ja");
});
test("invalid speed or language cannot overwrite the global value", async () => {
  stored = { speaking_speed: 1.06, speech_language: "en" };
  for (const body of [{ speakingSpeed: 0 }, { speakingSpeed: 1.21 }, { speakingSpeed: "1.06" }, { speechLanguage: "fr" }, { speechLanguage: "EN" }, { speakingSpeed: null, speechLanguage: 3 }]) {
    assert.equal((await handler().PATCH(request(body))).status, 400);
  }
  assert.deepEqual(stored, { speaking_speed: 1.06, speech_language: "en" });
});
test("before the language migration runs, speed still works and language stays local", async () => {
  stored = { speaking_speed: 1.04 };
  const read = await (await handler(null, false, true).GET(new Request("https://vivian.example"))).json();
  assert.equal(read.speakingSpeed, 1.04);
  // No speechLanguage key: the client keeps its cached choice instead of being
  // reset to the Thai default on the next refresh.
  assert.equal("speechLanguage" in read, false);
  const saved = await (await handler(null, false, true).PATCH(request({ speakingSpeed: 1.08, speechLanguage: "en" }))).json();
  assert.equal(saved.speakingSpeed, 1.08);
  assert.equal("speechLanguage" in saved, false);
  assert.equal(stored.speaking_speed, 1.08);
  assert.equal(stored.speech_language, undefined);
});
test("unauthorized callers cannot read or write; cloud failure is explicit", async () => {
  const denied = Response.json({}, { status: 403 });
  assert.equal(await handler(denied, true).PATCH(request({ speakingSpeed: 1 })), denied);
  assert.equal(await handler(denied, true).GET(new Request("https://vivian.example")), denied);
  assert.equal((await handler(null, true).PATCH(request({ speakingSpeed: 1 }))).status, 503);
});
