import type { Mood } from "@/lib/companion";

// Pure Live2D emotion engine. The old path used a first-match regex over the
// combined chat text and only knew Miss's authored names, so Vivian kept the
// wrong face (or no face) whenever the reply used an ElevenLabs tag, a word
// the regex missed, or a non-Miss model (e.g. Marymei with Chinese names
// like 脸红). This module scores every cue, lets intentional audio tags
// win, and resolves against any model's expression/motion names.

export type Live2DEmotion =
  | "happy" | "laugh" | "sad" | "angry" | "surprised" | "confused"
  | "tired" | "blush" | "love" | "tease" | "eyes" | "phone" | "tea"
  | "hair" | "thinking" | "calm";

interface EmotionRule {
  emotion: Live2DEmotion;
  pattern: RegExp;
  weight: number;
}

// Keyword cues are ordered by strength, not first-match. Patterns avoid the
// old bare-substring traps: "ตา" (matches ตาม/ตาก), bare "หา" (matches
// หาเงิน), bare "ชา" (matches ชาย) and bare "ผม" (matches ผมชอบ) are gone.
const TEXT_RULES: EmotionRule[] = [
  { emotion: "sad", pattern: /เศร้า|เสียใจ|ร้องไห้|เหงา|หดหู่|เศร้าสร้อย|กลัว|กังวล|วิตก|กังวลใจ|sad|cry|tear|lonely|depressed|afraid|anxious|worried|悲|哭|难过|伤心|心痛|伤感|悲し|泣|涙|寂し|不安/i, weight: 3 },
  { emotion: "angry", pattern: /โกรธ|โมโห|หงุดหงิด|รำคาญ|ไม่พอใจ|งอน|angry|mad|annoyed|upset|furious|pout|怒|生气|愤怒|恼火|怒り|ぷん|怒っ/i, weight: 3 },
  { emotion: "surprised", pattern: /ตกใจ|ว้าว|จริงเหรอ|ไม่น่าเชื่อ|หา\?|ห๊ะ|เอ๊ะ|surprise|wow|really\?|shocked|startled|惊|吃惊|惊讶|讶|驚|驚き|ビックリ|まじ|えっ/i, weight: 2 },
  { emotion: "tired", pattern: /ง่วง|เพลีย|อยากนอน|เหนื่อย|พักผ่อน|อ่อนล้า|tired|sleepy|exhausted|sleep|眠|困|累|疲|辛|しんど|眠い/i, weight: 2 },
  { emotion: "blush", pattern: /เขิน|หน้าแดง|อาย|ชม|หยอด|หึง|หวง|fluster|blush|shy|embarrass|jealous|possessive|脸红|害羞|羞|照れ|恥|ドキドキ/i, weight: 2 },
  { emotion: "love", pattern: /รัก|คิดถึง|กอด|ห่วงใย|love|miss you|hug|care for|affection|crush|爱|好き|好|爱し|รักนะ|คิดถึงนะ/i, weight: 2 },
  { emotion: "laugh", pattern: /ขำ|ตลก|หัวเราะ|มุก|ฮ่า|haha|lol|funny|joke|laugh|chuckle|giggle|哈哈|大笑|笑い|あはは|ウケ/i, weight: 2 },
  { emotion: "tease", pattern: /แกล้ง|หยอก|ล้อเล่น|ทะเล้น|จุ๊บ|จูบ|kiss|tease|tongue|wink|吐舌|眨眼|ウィンク|チュー/i, weight: 2 },
  { emotion: "eyes", pattern: /มอง|ตามอง|ดูนี่|กระพริบ|หลับตา|eyes|look|blink|watch|gaze|目|眼|観|見る|瞬き/i, weight: 1 },
  { emotion: "phone", pattern: /โทรศัพท์|โทรหา|สายโทร|แจ้งเตือน|ข้อความ|notification|phone|call|text me|スマホ|携帯|手机|来电|消息/i, weight: 1 },
  { emotion: "tea", pattern: /(?:ดื่ม|จิบ)ชา|กาแฟ|ชาเขียว|drink|tea|coffee|お茶|茶|咖啡|喝茶/i, weight: 1 },
  { emotion: "hair", pattern: /ทรงผม|ผมยาว|ผมสั้น|หวีผม|ทำผม|ตัดผม|แต่งตัว|แต่งหน้า|แฟชั่น|สวย|ดูดี|hair|hairstyle|makeup|fashion|pretty|beautiful|髪|化粧|お洒落/i, weight: 1 },
  { emotion: "confused", pattern: /อะไรนะ|งง|ไม่เข้าใจ|ทำไม|what\?|huh|confused|don't understand|困惑|疑问|为什么|なぜ|なんで|分からない/i, weight: 1 },
  { emotion: "thinking", pattern: /คิดว่า|คิดดู|ครุ่นคิด|คิดอยู่|hmm|thinking|thoughtful|思考|考え|悩|うーん/i, weight: 1 },
  { emotion: "happy", pattern: /ดีใจ|ตื่นเต้น|เยี่ยม|สุดยอด|ฉลอง|ยิ้ม|สวัสดี|ทักทาย|ขอบคุณ|สุขสันต์|happy|excited|great|awesome|celebrate|smile|hello|thank|开心|开心|微笑|开怀|笑顔|にっこり|嬉し/i, weight: 2 },
];

const TAG_TO_EMOTION: Record<string, Live2DEmotion> = {
  curious: "confused", playful: "tease", thoughtful: "thinking", content: "happy",
  anxious: "sad", tired: "tired", startled: "surprised", sad: "sad", excited: "happy",
  happy: "happy", laughs: "laugh", chuckles: "laugh", sighs: "tired", exhales: "tired",
  whispers: "calm", softly: "calm", quietly: "calm", shouts: "angry", rushed: "surprised",
};

// ElevenLabs Character cues are free-form ("slightly flustered, trying to
// sound composed"). Match distinctive words rather than the full string so
// paraphrases still map to a face.
const CHARACTER_CUE_RULES: Array<[RegExp, Live2DEmotion]> = [
  [/fluster|embarrass|shy|blush|composed/i, "blush"],
  [/teas|playful|cheeky|mischiev/i, "tease"],
  [/warm|affection|tender|gentle|fond|amused/i, "love"],
  [/sad|down|hurt|glum|gloomy|worried|anxious/i, "sad"],
  [/annoyed|irritated|frustrated|angry|cross/i, "angry"],
  [/surprise|startled|amazed|shocked/i, "surprised"],
  [/tired|weary|exhausted|sleepy/i, "tired"],
  [/excited|thrilled|delighted|cheerful|bright/i, "happy"],
  [/curious|puzzled|confused|questioning/i, "confused"],
];

export function extractEmotionTags(text: string): string[] {
  const tags: string[] = [];
  for (const match of text.matchAll(/\[\s*([^\]]{1,80})\s*\]/g)) tags.push(match[1].trim());
  return tags;
}

function moodBonus(mood: Mood, intensity: number): Partial<Record<Live2DEmotion, number>> {
  const scale = intensity >= 70 ? 1.5 : 1;
  switch (mood) {
    case "warm": return { happy: scale, love: scale * 0.5 };
    case "playful": return { tease: scale, laugh: scale * 0.5, happy: scale * 0.5 };
    case "tired": return { tired: scale, tea: scale * 0.5 };
    case "melancholy": return { sad: scale };
    case "yandere": return { blush: scale, angry: scale * 0.5 };
    default: return { calm: scale * 0.5 };
  }
}

// Tie-break order: distress and strong reactions never lose to a context tag
// like eyes/phone/tea by an accidental equal score.
const PRIORITY: Live2DEmotion[] = [
  "sad", "angry", "surprised", "tired", "blush", "love", "laugh", "happy",
  "tease", "confused", "thinking", "eyes", "phone", "tea", "hair", "calm",
];

export function detectLive2DEmotion(options: {
  reply: string;
  userText: string;
  mood: Mood;
  intensity: number;
  idle?: boolean;
}): Live2DEmotion {
  const combined = `${options.reply} ${options.userText}`;
  const scores = new Map<Live2DEmotion, number>();
  const add = (emotion: Live2DEmotion, value: number) => scores.set(emotion, (scores.get(emotion) ?? 0) + value);

  // 1. Intentional voice tags are the strongest signal.
  for (const tag of extractEmotionTags(options.reply)) {
    const key = tag.toLowerCase();
    const direct = TAG_TO_EMOTION[key.split(/[,]/)[0].trim()];
    if (direct) { add(direct, 3); continue; }
    for (const [pattern, emotion] of CHARACTER_CUE_RULES) {
      if (pattern.test(tag)) { add(emotion, 2); break; }
    }
  }

  // 2. Mood is background weight, never the whole answer.
  for (const [emotion, value] of Object.entries(moodBonus(options.mood, options.intensity)) as Array<[Live2DEmotion, number]>) {
    add(emotion, value);
  }

  // 3. Spoken words.
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(combined)) add(rule.emotion, rule.weight);
  }

  // 4. Idle+tired keeps the authored tea rest instead of a generic face.
  if (options.idle && options.mood === "tired") add("tea", 2);

  let best: Live2DEmotion = "calm";
  let bestScore = -Infinity;
  for (const emotion of PRIORITY) {
    const score = scores.get(emotion) ?? 0;
    if (score > bestScore) { best = emotion; bestScore = score; }
  }
  return best;
}

// Miss's authored expressions (lib/models.ts). Names are matched exactly,
// including the trailing space in "M wenhao " and the bare "#".
export const MISS_EXPRESSION_BY_EMOTION: Record<Live2DEmotion, string[]> = {
  happy: ["M miyan"],
  laugh: ["M xingxing2"],
  sad: ["M QAQ"],
  angry: ["M nu"],
  surprised: ["M wenhao "],
  confused: ["M ##"],
  tired: ["S chabei"],
  blush: ["M lianhong"],
  love: ["M love", "M lianhong"],
  tease: ["X shetou"],
  eyes: ["M ###"],
  phone: ["S shouji"],
  tea: ["S chabei"],
  hair: ["T faxing"],
  thinking: ["M ##"],
  calm: ["#"],
};

const GENERIC_EXPRESSION_PATTERNS: Record<Live2DEmotion, RegExp> = {
  happy: /happy|smile|joy|warm|miyan|微笑|开心|开怀|笑顔|にっこり|嬉し|ยิ้ม/i,
  laugh: /laugh|chuckle|giggle|xingxing2|大笑|哈哈|笑い|ウケ/i,
  sad: /sad|cry|tear|depress|melancholy|QAQ|悲|哭|难过|伤心|悲し|泣|涙|เศร้า|เหงา|เสียใจ/i,
  angry: /angry|mad|annoy|upset|nu|怒|生气|愤怒|怒り|ぷん|โกรธ|โมโห|งอน|หงุดหงิด/i,
  surprised: /surprise|shock|startl|wenhao|惊|吃惊|惊讶|驚|驚き|ビックリ|ตกใจ|ว้าว/i,
  confused: /confus|question|puzzl|wenhao|##|困惑|疑问|为什么|なぜ|なんで|งง|ไม่เข้าใจ|ทำไม/i,
  tired: /tired|sleep|exhaust|chabei|眠|困|累|疲|ง่วง|เหนื่อย|เพลีย/i,
  blush: /blush|shy|fluster|embarrass|lianhong|脸红|害羞|羞|照れ|恥|เขิน|หน้าแดง|อาย/i,
  love: /love|affection|crush|lianhong|爱|好き|愛|รัก|คิดถึง/i,
  tease: /tease|tongue|wink|shetou|吐舌|眨|ウィンク|แกล้ง|หยอก/i,
  eyes: /###|eyes|look|blink|gaze|目|眼|มอง|กระพริบ|หลับตา/i,
  phone: /phone|shouji|call|message|スマホ|携帯|手机|โทร|消息/i,
  tea: /tea|coffee|drink|chabei|お茶|咖啡|茶|กาแฟ|ดื่ม/i,
  hair: /hair|faxing|fashion|style|pretty|makeup|髪|化粧|お洒落|ผม|แฟชั่น|สวย/i,
  thinking: /think|##|思考|考え|悩|うーん|คิด/i,
  calm: /neutral|normal|default|calm|idle|#|平常|通常|ปกติ|ปกติ|สงบ/i,
};

export function resolveLive2DExpression(emotion: Live2DEmotion, supported: readonly string[]): string | null {
  const exact = MISS_EXPRESSION_BY_EMOTION[emotion] ?? [];
  for (const name of exact) {
    const hit = supported.find((item) => item.trim() === name.trim());
    if (hit) return hit;
  }
  const pattern = GENERIC_EXPRESSION_PATTERNS[emotion];
  return supported.find((name) => pattern.test(name)) ?? null;
}

const GENERIC_MOTION_PATTERNS: Record<Live2DEmotion, RegExp> = {
  happy: /happy|smile|excited|warm|喜|开心|微笑|笑|嬉し|ยิ้ม/i,
  laugh: /laugh|chuckle|giggle|Laugh|笑|大笑|笑い/i,
  sad: /sad|Sad|悲|哭|难过|伤心|悲し|泣|เศร้า/i,
  angry: /angry|Angry|怒|生气|怒り|โกรธ/i,
  surprised: /surprise|Surprise|shock|惊|驚|ตกใจ|ว้าว/i,
  confused: /think|Thinking|困惑|考え|งง/i,
  tired: /tired|sleep|Tea|眠|困|ง่วง|เหนื่อย/i,
  blush: /blush|shy|embarrass|脸红|害羞|照れ|เขิน/i,
  love: /love|Love|warm|Warm|爱|好き|รัก/i,
  tease: /tease|Tease|tongue|wink|吐舌|ウィンク|แกล้ง/i,
  eyes: /look|Look|目|眼|มอง/i,
  phone: /phone|Phone|スマホ|手机|โทร/i,
  tea: /tea|Tea|咖啡|お茶|กาแฟ/i,
  hair: /hair|Hair|style|Style|髪|ผม|แฟชั่น/i,
  thinking: /think|Thinking|思考|考え|คิด/i,
  calm: /idle|Idle|stand|待機|待机|ปกติ/i,
};

// Miss's authored motion groups, kept as the first choice for Miss.
export const MISS_MOTION_BY_EMOTION: Record<Live2DEmotion, string[]> = {
  happy: ["Happy", "Idle"], laugh: ["Laugh", "Idle"], sad: ["Sad", "Idle"],
  angry: ["Angry", "Idle"], surprised: ["Surprise", "Idle"], confused: ["Thinking", "Idle"],
  tired: ["Tea", "Idle"], blush: ["Warm", "Idle"], love: ["Warm", "Idle"],
  tease: ["Tease", "Idle"], eyes: ["Look", "Idle"], phone: ["Phone", "Idle"],
  tea: ["Tea", "Idle"], hair: ["Hair", "Idle"], thinking: ["Thinking", "Idle"], calm: ["Idle"],
};

export function resolveLive2DMotion(emotion: Live2DEmotion, availableGroups: readonly string[]): string | null {
  const authored = MISS_MOTION_BY_EMOTION[emotion] ?? ["Idle"];
  const authoredHit = authored.find((name) => availableGroups.includes(name));
  if (authoredHit) return authoredHit;
  const pattern = GENERIC_MOTION_PATTERNS[emotion];
  const genericHit = availableGroups.find((name) => pattern.test(name));
  if (genericHit) return genericHit;
  return availableGroups.includes("Idle") ? "Idle" : (availableGroups[0] ?? null);
}
