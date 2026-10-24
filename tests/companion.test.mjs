import assert from "node:assert/strict";
import test from "node:test";
import { applyConversationTurn, companionPromptBlock, defaultCompanionState, decayCompanionState, normalizeMood } from "../lib/companion.ts";

test("legacy moods migrate without resetting relationship or memory", () => {
  const saved = { ...defaultCompanionState(), affinity: 82, trust: 73, familiarity: 64, mood: "tsundere", conversationSummary: "ผู้ใช้ชอบชา" };
  const restored = { ...saved, mood: normalizeMood(saved.mood) };
  assert.equal(restored.mood, "yandere");
  assert.equal(restored.affinity, saved.affinity);
  assert.equal(restored.trust, saved.trust);
  assert.equal(restored.familiarity, saved.familiarity);
  assert.equal(restored.conversationSummary, saved.conversationSummary);
  assert.equal(normalizeMood("unknown"), "calm");
  assert.equal(normalizeMood("warm"), "warm");
  assert.equal(normalizeMood("yandere"), "yandere");
});

test("a jealous reply expresses yandere mood even in a new relationship", () => {
  const state = defaultCompanionState();
  const next = applyConversationTurn(state, "มีคนมาจีบฉัน", "ใคร? เธอไม่ต้องสนใจคนนั้นหรอก");
  assert.equal(next.mood, "yandere");
  assert.equal(state.mood, "calm");
  assert.equal(next.affinity, state.affinity + 1);
});

test("embarrassment does not replace Vivian's yandere mood", () => {
  const next = applyConversationTurn(defaultCompanionState(), "ชมได้ไหม", "หน้าแดงทำไม? ไม่ได้เขินสักหน่อย");
  assert.equal(next.mood, "yandere");
});

test("distress takes precedence over flustered banter", () => {
  const next = applyConversationTurn(defaultCompanionState(), "วันนี้เศร้ามาก", "ฉันฟังอยู่ ไม่ได้เป็นห่วงสักหน่อย");
  assert.equal(next.mood, "melancholy");
});

test("idle banter does not increase closeness and intense moods still decay", () => {
  const state = { ...defaultCompanionState(), moodIntensity: 98 };
  const next = applyConversationTurn(state, "", "ฉันหวงเธอ", true);
  assert.equal(next.affinity, state.affinity);
  assert.equal(next.familiarity, state.familiarity);
  assert.equal(next.moodIntensity, 100);
  const faded = decayCompanionState(next, Date.parse(next.lastInteractionAt) + 24 * 3_600_000);
  assert.equal(faded.mood, "calm");
  assert.equal(faded.affinity, state.affinity);
});

test("relationship prompt gives Vivian initiative without inventing closeness", () => {
  const early = companionPromptBlock(defaultCompanionState());
  assert.match(early, /ยังรู้จักกันไม่นาน: Vivian ยังมีความเห็นและริเริ่มได้/);
  assert.match(early, /ไม่ต้องรอให้ผู้ใช้กำหนดทุกจังหวะ/);
  assert.match(early, /อย่าจบทุกข้อความด้วยคำถาม/);

  const close = companionPromptBlock({ ...defaultCompanionState(), affinity: 82 });
  assert.match(close, /คุ้นเคยมาก: เริ่มหัวข้อ/);
});
