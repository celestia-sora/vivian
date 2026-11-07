import assert from "node:assert/strict";
import test from "node:test";
import { detectLive2DEmotion, extractEmotionTags, resolveLive2DExpression, resolveLive2DMotion } from "../lib/live2d-emotion.ts";

const go = (reply, userText = "", mood = "calm", intensity = 35, idle = false) => detectLive2DEmotion({ reply, userText, mood, intensity, idle });

test("voice tags win over plain words and calm mood", () => {
  assert.equal(go("[sad] วันนี้เธอเหนื่อยใช่ไหม", "วันนี้แย่จัง", "calm"), "sad");
  assert.equal(go("[sad] ฉันฟังอยู่", "", "warm", 80), "sad");
  assert.equal(go("[curious] จริงเหรอ", "", "calm"), "confused");
  assert.equal(go("[startled] หา!?", "", "calm"), "surprised");
  assert.equal(go("[slightly flustered, trying to sound composed] ไม่ได้เขิน", "", "calm"), "blush");
  assert.equal(go("[dryly teasing, restrained] ตาบ้าเอ๊ย", "", "calm"), "tease");
});

test("thai keywords score without the old substring traps", () => {
  assert.equal(go("กลับคฤหาสน์กันเถอะ", "ตามนี้เลย", "calm"), "calm");
  assert.equal(go("ดูนี่สิ", "ตามสบาย", "calm"), "eyes");
  assert.equal(go("ง่วงแล้วไปนอนกัน", "วันนี้เหนื่อย", "calm"), "tired");
  assert.equal(go("ดื่มชากัน", "หิวน้ำจัง", "calm"), "tea");
  assert.equal(go("ผมชอบชา", "บอกหน่อย", "calm"), "calm");
  assert.equal(go("ผมยาวกว่านี้สวยไหม", "ทำผมใหม่", "calm"), "hair");
  assert.equal(go("น่ารักจัง", "ชมให้หน่อย", "yandere", 70), "blush");
  assert.equal(go("555 ขำจัง", "มุกนี้ดี", "playful", 80), "laugh");
});

test("distress outranks flustered words and idle tired keeps the tea rest", () => {
  assert.equal(go("อย่าร้องไห้เลย นะ", "ฉันเศร้าต้องการกำลังใจ", "yandere", 90), "sad");
  assert.equal(go("พักหน่อยนะ", "", "tired", 80, true), "tea");
  assert.equal(go("พักหน่อยนะ", "", "tired", 80, false), "tired");
});

test("miss map, generic models and motions resolve", () => {
  assert.equal(resolveLive2DExpression("blush", ["#", "M lianhong", "M miyan"]), "M lianhong");
  assert.equal(resolveLive2DExpression("happy", ["#", "M miyan"]), "M miyan");
  assert.equal(resolveLive2DExpression("sad", ["#", "M QAQ"]), "M QAQ");
  assert.equal(resolveLive2DExpression("tired", ["#", "S chabei"]), "S chabei");
  // Non-Miss artist names: Chinese/Japanese are matched generically.
  assert.equal(resolveLive2DExpression("blush", ["#", "脸红", "开心"]), "脸红");
  assert.equal(resolveLive2DExpression("happy", ["通常", "笑顔"]), "笑顔");
  assert.equal(resolveLive2DExpression("sad", ["通常", "悲し"]), "悲し");
  assert.equal(resolveLive2DExpression("angry", ["通常", "怒り"]), "怒り");
  assert.equal(resolveLive2DExpression("happy", ["通常", "开心"]), "开心");
  assert.equal(resolveLive2DExpression("calm", ["通常", "开心"]), "通常");
  assert.equal(resolveLive2DExpression("happy", ["通常"]), null);
  assert.equal(resolveLive2DMotion("happy", ["Idle", "Happy"]), "Happy");
  assert.equal(resolveLive2DMotion("sad", ["Idle", "Sad"]), "Sad");
  assert.equal(resolveLive2DMotion("blush", ["Idle", "Warm"]), "Warm");
  assert.equal(resolveLive2DMotion("happy", ["Idle"]), "Idle");
  assert.equal(resolveLive2DMotion("happy", []), null);
  assert.deepEqual(extractEmotionTags("[playful] สวัสดี [sighs]"), ["playful", "sighs"]);
});
