import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const route = read("../app/api/chat/route.ts");
const app = read("../app/companion.tsx");
const speech = read("../lib/speech.ts");
const story = read("../lib/vivian-story.ts");
const dialogue = read("../lib/vivian-dialogue.ts");
const agents = read("../AGENTS.md");
const persona = read("../lib/vivian-persona.ts");

test("the runtime persona is yandere, character-first, and not routine-bound", () => {
  assert.match(route, /yanderePersonaPrompt/);
  assert.match(route, /น้ำเสียงหลักเย็นชา กระชับ ตรง และหนักแน่น/);
  assert.match(route, /ไม่มีข้อกำหนดให้ปฏิเสธทุกคำถาม/);
  assert.match(route, /ไม่ใช่หน้าที่ให้สั่ง ควบคุม หรือติดตามกิจวัตรตลอดเวลา/);
  assert.match(route, /smart device/);
  assert.match(route, /MediaPipe/);
  assert.match(persona, /intensely attached, quietly possessive/);
  assert.match(story, /เพื่อนสนิท yandere/);
  assert.match(dialogue, /cool-headed yandere companion/);
  assert.match(agents, /character-first yandere companion/);
});

test("mood mapping and voice cues reflect controlled possessiveness", () => {
  assert.match(app, /yandere: intensity >= 70/);
  assert.match(speech, /quietly intense, possessive but controlled/);
  assert.match(speech, /vulnerable moments take precedence over intense character styling/);
});
