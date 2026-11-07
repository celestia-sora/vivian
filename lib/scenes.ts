/** Shared presentation contract. No image data belongs in a model context. */
export const SCENE_MAX_BYTES = 8 * 1024 * 1024;
export const SCENE_MAX_COUNT = 50;
export const SCENE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export interface VivianScene {
  id: string;
  label: string;
  imageUrl: string;
  thumbnailUrl: string;
  sourceType: "upload" | "url";
  createdAt: string;
  updatedAt: string;
}
export interface ScenePreferences {
  autoScene: boolean;
  activeSceneId: string | null;
  preset: "day" | "night" | null;
  revision: string;
}
export type SceneDecision = { change: false } | { change: true; id: string };
export class SceneError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function validateSceneLabel(value: unknown): string {
  if (typeof value !== "string") throw new SceneError("Enter a scene label (1–50 characters).");
  const label = value.trim().normalize("NFC");
  if (!label || [...label].length > 50 || /[\p{Cc}\p{Cf}<>]/u.test(label)) throw new SceneError("Enter a scene label (1–50 characters, without markup or control characters).");
  return label;
}
export function validateSceneId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new SceneError("Scene not found.", 404);
  return value;
}

export function sceneThumbnailKey(key: string): string {
  return key.replace(/\.[^/.]+$/, ".thumb.webp");
}
export function sceneImageExtension(mime: string): string {
  const extensions: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
  const extension = extensions[mime];
  if (!extension) throw new SceneError("Unsupported scene image type.");
  return extension;
}

// Deterministic scene match: the user's own label IS the scene meaning.
// Exact mentions win (longest + latest destination wins, e.g. "จากAไปB"
// switches to B). Partial matches use anchor words and substring coverage
// so a scene with many scenes in the library can still be picked when the
// user says only the core name ("ห้องนอน" for "ห้องนอนตอนกลางคืน"),
// while a tie across overlapping scenes returns nothing instead of
// guessing. Negated mentions ("ไม่อยากไป…", "อย่าไป…") are ignored.
// The first text is treated as the current user turn and weighted highest.
const SCENE_ANCHORS = [
  "คฤหาสน์", "ห้องนอน", "ห้องน้ำ", "ห้องครัว", "ห้องทำงาน", "ห้องรับแขก", "ห้องอ่านหนังสือ",
  "ชายหาด", "สวนดอกไม้", "ร้านกาแฟ", "ร้านอาหาร", "ห้องนอนตอนกลางคืน",
  "คาเฟ่", "กาแฟ", "ตลาด", "ห้าง", "โรงแรม", "โรงพยาบาล", "โรงเรียน", "มหาวิทยาลัย",
  "ออฟฟิศ", "ที่ทำงาน", "ภูเขา", "ทะเล", "เมือง", "วัง", "สวน", "บ้าน", "ห้อง", "ครัว",
  "ระเบียง", "สระน้ำ", "สระว่ายน้ำ", "สนามหญ้า", "ดาดฟ้า", "ลาน",
  "กลางคืน", "กลางวัน", "ตอนเช้า", "ตอนเย็น", "ตอนค่ำ", "นอน", "พักผ่อน",
  "อ่านหนังสือ", "กินข้าว", "ดื่มกาแฟ",
];
const MOVEMENT_HINT = /(ไป|กลับ|ย้าย|เดิน|มุ่ง|เข้า|ออก|ขึ้น|ลง|พัก|อยู่|นอน|ตื่น|go|going|return|back|move|moving|enter|stay|staying|sleep|wake)/i;
const NEGATION_HINT = /(ไม่ไป|ไม่อยาก|อย่าไป|เลิกไป|หนีจาก|ออกไปจาก|ไม่อยู่|เบื่อ|ไม่ชอบ|ไม่ต้องการ|ไม่เอา|ปฏิเสธ|not going|don't go|dont go|don't want|never go)/i;

function normalizeSceneText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function compactSceneText(value: string): string {
  return normalizeSceneText(value).replace(/\s+/g, "");
}

function longestCommonSubstringLength(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const dp = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev + 1; else dp[j] = 0;
      if (dp[j] > best) best = dp[j];
      prev = tmp;
    }
  }
  return best;
}

function isNegated(compact: string, index: number): boolean {
  const prefix = compact.slice(Math.max(0, index - 14), index);
  return NEGATION_HINT.test(prefix);
}

export function findSceneLabelMatch(
  texts: string[],
  scenes: ReadonlyArray<{ id: string; label: string }>,
  activeSceneId: string | null = null,
): string | null {
  let bestExact: { id: string; score: number; length: number } | null = null;
  const partials: Array<{ id: string; score: number }> = [];
  for (const scene of scenes) {
    if (scene.id === activeSceneId) continue;
    const label = scene.label.trim().normalize("NFC");
    const length = [...label].length;
    if (length < 2) continue;
    const labelCompact = compactSceneText(label);
    const labelChars = [...labelCompact];
    const labelAnchors = SCENE_ANCHORS.filter((anchor) => labelCompact.includes(compactSceneText(anchor)));
    let bestScore = 0;
    let exact = false;
    for (let textIndex = 0; textIndex < texts.length; textIndex++) {
      const raw = texts[textIndex];
      if (!raw) continue;
      const textCompact = compactSceneText(raw);
      if (!textCompact) continue;
      const weight = textIndex === 0 ? 1 : 0.92;
      // Exact full-label mention (skipping negated occurrences).
      let idx = textCompact.indexOf(labelCompact);
      while (idx !== -1) {
        if (!isNegated(textCompact, idx)) {
          const score = (100 + length + idx / Math.max(1, textCompact.length)) * weight;
          if (!exact || score > bestScore) { bestScore = score; exact = true; }
        }
        idx = textCompact.indexOf(labelCompact, idx + 1);
      }
      if (exact) continue;
      // A negated full-label mention must not resurrect through partial scoring.
      if (textCompact.includes(labelCompact)) continue;
      // Partial: anchor-word match.
      for (const anchor of labelAnchors) {
        const anchorCompact = compactSceneText(anchor);
        const aIdx = textCompact.indexOf(anchorCompact);
        if (aIdx === -1 || isNegated(textCompact, aIdx)) continue;
        const anchorLength = [...anchorCompact].length;
        let score = 45 + anchorLength;
        if (MOVEMENT_HINT.test(normalizeSceneText(raw))) score += 8;
        score *= weight;
        if (score > bestScore) bestScore = score;
      }
      // Partial: absolute shared-substring length (not ratio). Using the
      // ratio alone would favour the shorter of two overlapping labels
      // ("ห้องนอนตอนเช้า" over "ห้องนอนตอนกลางคืน") on the same shared
      // core "ห้องนอน", which would be a guess among many scenes.
      const textChars = [...textCompact];
      const lcs = longestCommonSubstringLength(labelChars, textChars);
      if (lcs >= 4) {
        let score = (38 + lcs * 4) * weight;
        if (MOVEMENT_HINT.test(normalizeSceneText(raw))) score += 5;
        if (score > bestScore) bestScore = score;
      }
      if (bestScore >= 100) break;
    }
    if (exact) {
      if (!bestExact || bestScore > bestExact.score) bestExact = { id: scene.id, score: bestScore, length };
    } else if (bestScore > 0) {
      partials.push({ id: scene.id, score: bestScore });
    }
  }
  if (bestExact) return bestExact.id;
  partials.sort((a, b) => b.score - a.score);
  const top = partials[0];
  if (!top || top.score < 53) return null;
  const runner = partials[1];
  if (runner && top.score - runner.score < 8) return null;
  return top.id;
}

export function sceneLabelForId(
  scenes: ReadonlyArray<{ id: string; label: string }>,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return scenes.find((scene) => scene.id === id)?.label ?? null;
}
