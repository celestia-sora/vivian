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

test("the runtime persona is shy tsundere, character-first, and not routine-bound", () => {
  assert.match(route, /vivianPersonaPrompt/);
  assert.match(route, /companionPromptBlock\(state\)/);
  assert.match(route, /ภายนอกอาจดูเย็นชา ห่างเหิน หรือหงุดหงิดนิด ๆ/);
  assert.match(route, /ไม่มีข้อกำหนดให้ปฏิเสธทุกคำถาม/);
  assert.match(route, /ไม่ใช่หน้าที่ให้สั่ง ควบคุม หรือติดตามกิจวัตรตลอดเวลา/);
  assert.match(route, /smart device/);
  assert.match(route, /MediaPipe/);
  assert.match(persona, /shy, polite, slightly awkward tsundere manner/);
  assert.match(persona, /Prefer Thai when no language is explicitly selected/);
  assert.match(persona, /stammer a syllable, trail off with an ellipsis/);
  assert.match(persona, /Thai style reference/);
  assert.match(route, /ติดอ่าง ลากเสียงหรือเว้นจังหวะ/);
  assert.match(persona, /draw from all ElevenLabs audio-tag categories when useful/);
  assert.match(persona, /Put an Emotion tag at the beginning of the sentence it guides/);
  assert.match(persona, /Tags are audio metadata and must not be spoken aloud/);
  assert.match(story, /เป็นเพื่อนสนิทของ Vivian/);
  assert.match(dialogue, /shy, polite, slightly awkward tsundere companion/);
  assert.match(agents, /character-first shy, polite, slightly awkward tsundere companion/);
});

test("mood mapping and voice cues reflect guarded tsundere behavior", () => {
  assert.match(app, /yandere: intensity >= 70/);
  assert.match(speech, /quietly jealous, guarded/);
  assert.match(route, /ติดอ่าง ลากเสียงหรือเว้นจังหวะ/);
  assert.doesNotMatch(route, /แกน yandere เป็นตัวตนถาวร|ห้ามใช้มุกหรือพฤติกรรม tsundere/);
  assert.match(read("../lib/companion.ts"), /อย่าจบทุกข้อความด้วยคำถามหรือข้อเสนอช่วยเหลือแบบบริการ/);
});
