import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as values from "../lib/custom-instructions.ts";

const source = ts.transpileModule(readFileSync(new URL("../app/api/custom-instructions/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let stored;

function handler(denied = null, unavailable = false) {
  const exports = {};
  runInNewContext(source, {
    exports, Response, Error, Date, AbortSignal,
    require(name) {
      if (name === "@/lib/auth/server") return { requireApiAccess: async () => denied };
      if (name === "@/lib/custom-instructions") return values;
      if (name === "@/lib/supabase-admin") {
        return { getSupabaseAdmin() {
          if (unavailable) throw new Error();
          return { from(table) {
            assert.equal(table, "vivian_custom_instructions");
            let candidate;
            const query = {
              upsert(row, options) {
                assert.equal(row.id, "global");
                assert.equal(options.onConflict, "id");
                candidate = { ...row };
                return query;
              },
              select(columns) { assert.equal(columns, "instructions"); return query; },
              eq(column, key) { assert.equal(column, "id"); assert.equal(key, "global"); return query; },
              async single() {
                stored = candidate;
                return { data: { instructions: stored.instructions }, error: null };
              },
              async maybeSingle() {
                return { data: stored ? { instructions: stored.instructions } : null, error: null };
              },
            };
            return query;
          } };
        } };
      }
      throw new Error(name);
    },
  });
  return exports;
}

const get = () => new Request("https://vivian.example/api/custom-instructions");
const patch = value => new Request("https://vivian.example/api/custom-instructions", { method: "PATCH", body: JSON.stringify(value) });

test("custom instructions survive a new handler/account and use one shared singleton", async () => {
  stored = undefined;
  assert.equal((await (await handler().GET(get())).json()).customInstructions, "");
  const saved = await handler().PATCH(patch({ customInstructions: "Call me Sora. Speak in Thai." }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).customInstructions, "Call me Sora. Speak in Thai.");
  const loaded = await handler().GET(get());
  assert.equal((await loaded.json()).customInstructions, "Call me Sora. Speak in Thai.");
  assert.equal(loaded.headers.get("cache-control"), "private, no-store");
});

test("saving trims whitespace and an empty value clears the shared instructions", async () => {
  stored = undefined;
  await handler().PATCH(patch({ customInstructions: "  Be gentle.  " }));
  assert.equal((await (await handler().GET(get())).json()).customInstructions, "Be gentle.");
  const cleared = await handler().PATCH(patch({ customInstructions: "   " }));
  assert.equal((await cleared.json()).customInstructions, "");
  assert.equal((await (await handler().GET(get())).json()).customInstructions, "");
});

test("invalid or oversized instructions cannot overwrite the shared value", async () => {
  stored = { id: "global", instructions: "keep me" };
  for (const body of [{ customInstructions: 3 }, { customInstructions: null }, {}, { customInstructions: "a".repeat(2001) }, []]) {
    assert.equal((await handler().PATCH(patch(body))).status, 400);
  }
  assert.equal(stored.instructions, "keep me");
  assert.equal((await handler().PATCH(patch({ customInstructions: "a".repeat(2000) }))).status, 200);
});

test("unauthorized callers cannot read or write; cloud failure is explicit", async () => {
  const denied = Response.json({}, { status: 403 });
  assert.equal(await handler(denied, true).PATCH(patch({ customInstructions: "x" })), denied);
  assert.equal(await handler(denied, true).GET(get()), denied);
  assert.equal((await handler(null, true).PATCH(patch({ customInstructions: "x" }))).status, 503);
  assert.equal((await handler(null, true).GET(get())).status, 503);
});
