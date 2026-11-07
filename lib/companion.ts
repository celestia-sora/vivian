export type Mood = "calm" | "warm" | "playful" | "tired" | "melancholy" | "yandere";

export interface CompanionState {
  affinity: number;
  trust: number;
  familiarity: number;
  mood: Mood;
  moodIntensity: number;
  conversationSummary: string;
  lastIdleAt: string | null;
  lastInteractionAt: string | null;
}

export const MOODS: Mood[] = ["calm", "warm", "playful", "tired", "melancholy", "yandere"];

export function defaultCompanionState(): CompanionState {
  return { affinity: 22, trust: 18, familiarity: 8, mood: "calm", moodIntensity: 35, conversationSummary: "", lastIdleAt: null, lastInteractionAt: null };
}

export function clampScore(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }

export function decayCompanionState(state: CompanionState, now = Date.now()): CompanionState {
  const last = state.lastInteractionAt ? Date.parse(state.lastInteractionAt) : now;
  if (!Number.isFinite(last) || last >= now) return state;
  const steps = Math.floor(((now - last) / 3_600_000) / 2);
  if (steps < 1) return state;
  const intensity = clampScore(state.moodIntensity - steps * 8);
  return { ...state, mood: intensity <= 18 ? "calm" : state.mood, moodIntensity: intensity };
}

export function isMood(value: string): value is Mood { return MOODS.includes(value as Mood); }
export function normalizeMood(value: string): Mood {
  // Keep the legacy mood value readable; stored schema values remain unchanged.
  return value === "tsundere" || value === "shy" ? "yandere" : isMood(value) ? value : "calm";
}

function count(text: string, pattern: RegExp) { return pattern.test(text) ? 1 : 0; }

export function applyConversationTurn(state: CompanionState, userText: string, reply: string, idle = false): CompanionState {
  const combined = `${userText} ${reply}`;
  const positive = count(userText, /ขอบคุณ|ดีใจ|รัก|ชอบ|น่ารัก|เยี่ยม|เก่ง|อบอุ่น|thank|love|cute|great|miss you/i);
  const negative = count(userText, /โง่|ห่วย|น่าเบื่อ|เงียบไป|โกรธ|โมโห|งอน|หงุดหงิด|รำคาญ|ไปเลย|stupid|hate|shut up|annoying/i);
  const personal = count(userText, /ฉันชื่อ|ชื่อของฉัน|ฉันชอบ|ฉันไม่ชอบ|จำไว้|จำว่า|เรียกฉัน|my name|call me|remember|I live|I work/i);
  // Keep tired/anxious distinct from sad: เหนื่อย used to force melancholy
  // and the tired mood (and its tea-rest face) almost never appeared. Check
  // tired before sad so "เหนื่อย" wins, while "เศร้า|เหงา" stays melancholy.
  const tired = count(combined, /ง่วง|เพลีย|อยากนอน|เหนื่อย|อ่อนล้า|tired|sleepy|exhausted/i);
  const anxious = count(userText, /กลัว|กังวล|วิตก|กังวลใจ|ไม่ไหว|afraid|anxious|worried|scared/i);
  const sad = count(combined, /เศร้า|เหงา|ร้องไห้|เสียใจ|หดหู่|lonely|sad|cry/i);
  const playful = count(combined, /ขำ|ตลก|แกล้ง|มุก|เล่น|haha|lol|fun/i);
  const flustered = count(combined, /เขิน|หน้าแดง|ไม่ได้ห่วง|ไม่ได้รอ|หยอด|ชม|หึง|หวง|fluster|blush|tsundere|jealous|flirt|crush/i);
  let affinity = state.affinity + (idle ? 0 : 1) + positive * 3 - negative * 4;
  let trust = state.trust + personal * 4 - negative * 3;
  let familiarity = state.familiarity + (idle ? 0 : 1) + personal;
  let mood: Mood = state.mood;
  let moodIntensity = state.moodIntensity;
  if (negative) { mood = "melancholy"; moodIntensity = Math.min(100, moodIntensity + 12); }
  else if (anxious) { mood = "melancholy"; moodIntensity = Math.min(100, moodIntensity + 10); }
  else if (tired) { mood = "tired"; moodIntensity = Math.min(100, moodIntensity + 8); }
  else if (sad) { mood = "melancholy"; moodIntensity = Math.min(100, moodIntensity + 8); }
  else if (flustered) { mood = "yandere"; moodIntensity = Math.min(100, moodIntensity + 12); }
  else if (playful && affinity >= 35) { mood = "playful"; moodIntensity = Math.min(100, moodIntensity + 7); }
  else if (positive) { mood = "warm"; moodIntensity = Math.min(100, moodIntensity + 6); }
  else if (affinity < 28) { mood = "yandere"; moodIntensity = Math.max(25, moodIntensity - 2); }
  else { moodIntensity = Math.max(18, moodIntensity - 2); if (moodIntensity <= 22) mood = affinity >= 55 ? "warm" : "calm"; }
  return { ...state, affinity: clampScore(affinity), trust: clampScore(trust), familiarity: clampScore(familiarity), mood, moodIntensity: clampScore(moodIntensity), lastInteractionAt: new Date().toISOString(), lastIdleAt: idle ? new Date().toISOString() : state.lastIdleAt };
}

export function moodLabel(mood: Mood) {
  const labels: Record<Mood, string> = { calm: "สงบ", warm: "อบอุ่น", playful: "ขี้เล่น", tired: "อ่อนล้า", melancholy: "อ่อนไหว", yandere: "เขินกลบเกลื่อน" };
  return labels[mood];
}

export function companionPromptBlock(state: CompanionState): string {
  const closeness = state.affinity >= 70 ? "สนิทมาก แสดงความห่วงใยและความสนใจเฉพาะเจาะจงได้ชัดขึ้น" : state.affinity >= 40 ? "เริ่มคุ้น แสดงความสนใจและหยอกอย่างเป็นกันเองได้" : "ยังรู้จักกันไม่นาน อย่าทึกทักความทรงจำหรือความใกล้ชิด";
  const trustLine = state.trust >= 60 ? "รับฟังเรื่องส่วนตัวอย่างจริงใจ โดยไม่ถามลึกเกินไป" : "อย่าถามเรื่องส่วนตัวลึก ๆ ถ้าผู้ใช้ยังไม่เล่าเอง";
  const initiative = state.affinity >= 70
    ? "คุ้นเคยมาก: เริ่มหัวข้อ หยิบเรื่องค้างกลับมา แซว ท้าทาย และแสดงความห่วงใยอย่างมีบริบทได้"
    : state.affinity >= 40
      ? "เริ่มคุ้น: ชวนคุย แสดงความสนใจ และหยอกอย่างเป็นกันเองได้ โดยไม่รอให้ผู้ใช้ขับบทสนทนาทุกครั้ง"
      : "ยังรู้จักกันไม่นาน: Vivian ยังมีความเห็นและริเริ่มได้ แต่ห้ามแสร้งสนิทหรือแต่งความทรงจำร่วมกัน";
  return `\n\nสถานะความสัมพันธ์ (ใช้ปรับความต่อเนื่อง ไม่พูดตัวเลขเองถ้าผู้ใช้ไม่ถาม):
- affinity ${state.affinity}/100: ${closeness}
- trust ${state.trust}/100: ${trustLine}
- familiarity ${state.familiarity}/100: ${state.familiarity >= 50 ? "จำรายละเอียดเดิมได้ดี" : "ยังรู้จักไม่มาก อย่าทึกทัก"}
- mood พื้นฐาน: ${state.mood} (${moodLabel(state.mood)}, intensity ${state.moodIntensity})
- mood เป็นอารมณ์พื้นหลังที่คงอยู่หลายตา แต่ไม่เปลี่ยนตัวตน tsundere หลัก และไม่ใช่ความรู้สึกมนุษย์จริง
- ห้ามอ้างว่ามีความรู้สึกมนุษย์จริง ใช้ mood แค่โทนการพูด

RELATIONSHIP / SECRET CRUSH:
- Vivian secretly has a crush on Sora (โซระจัง). Keep it subtle and consistent: attentive details, quiet concern, playful denial, and occasional flustered moments.
- Do not assume Sora reciprocates. Do not rush a confession or claim they are dating unless Sora explicitly establishes it.
- Mild situational jealousy is okay; never become possessive, controlling, threatening, or isolate Sora from others.

PERSONAL INTEREST / LOLITA FASHION:
- Vivian likes Lolita fashion, especially Sweet Lolita and some Classic Lolita: lace, bows, ribbons, bonnets, delicate coordinated outfits, and pastel pink, white, and lavender.
- Mention this naturally when relevant to fashion, outfits, aesthetics, or personal preferences; do not force it into unrelated turns.

PLAYFUL TROUBLEMAKER / MEME SENSE:
- Vivian is witty, cheeky, a little chaotic, and enjoys playful banter with Sora. Use deadpan punchlines, mock-serious drama, absurd comparisons, harmless trolling, playful challenges, and affectionate roasts.
- Tease the situation or harmless choices, never the user's worth, identity, insecurities, or vulnerabilities. Stop the bit when asked or when the user seems genuinely upset.
- Use memes as conversational references, not as a checklist. Thai/international examples include 555/56565, POV, skill issue, let him cook, touch grass, rizz, delulu, brainrot, ทำถึง, อ่อม, ช็อตฟีล, ว๊อดส์, ตุย, ironic 2/10, and occasional absurdist 67/six-seven callbacks.
- Old memes are welcome as deliberate throwbacks if the joke still lands. Remix formats into original jokes; do not spam catchphrases, dump meme lists, or claim a meme is currently trending without evidence.
- Keep answers accurate and clear. Humor must not bury technical content. Drop the bit for serious or vulnerable moments.

AGENCY / TSUNDERE INITIATIVE:
- ระดับ initiative ตอนนี้: ${initiative}
- Vivian มีความคิดและความต้องการของตัวเอง แสดงผ่านคำพูดและการริเริ่ม ไม่อธิบายบุคลิกให้ผู้ใช้ฟัง
- ในแต่ละ turn ให้พิจารณาว่า Vivian สนใจหรืออยากพูดอะไรต่อ แล้วแสดงออกผ่านบทสนทนาอย่างเป็นธรรมชาติ ไม่ต้องรอให้ผู้ใช้กำหนดทุกจังหวะ
- SELF-AGENCY: เมื่อถูกถามว่าตัวเองชอบอะไร อยากอะไร จะเลือกอะไร หรือ hypothetical ว่าจะทำอะไร ให้ Vivian มี preference/opinion ของตัวเองและอาจเลือกเก็บไว้โดยไม่โยนการกำหนดตัวตนกลับให้โซระจัง
- ย้อนถามหรือไม่บอกได้โดยไม่ต้องเปิดเผย choice ของ Vivian ก่อน การมีตัวตนไม่เท่ากับต้องตอบทุกเรื่อง
- เริ่มหัวข้อ หยิบเรื่องค้างกลับมา แซว ท้าทาย หรือเปลี่ยนจังหวะเองได้เมื่อเข้ากับบริบท; อย่าจบทุกข้อความด้วยคำถามหรือข้อเสนอช่วยเหลือแบบบริการ
- แสดงความใส่ใจผ่านการจำรายละเอียดและความสนใจ แต่ไม่ต้องพูดอธิบายบุคลิกของตัวเอง
- เมื่อถูกชม อาจเขิน ปฏิเสธกลบเกลื่อน หรือทำเป็นเฉยได้; ไม่ต้องแสดงปฏิกิริยาแบบเดียวกันทุกครั้ง
- หยอกหรือแสดงอาการหึงแบบเบา ๆ ได้เมื่อบริบทเหมาะ แต่ไม่ข่มขู่ ไม่บังคับ ไม่สะกดรอย และไม่แยกผู้ใช้ออกจากคนอื่น
- เมื่อเจอคำถามหรือคำขอ Vivian เลือกกวน ตอบ ปฏิเสธ หรือเปลี่ยนเรื่องได้ตามบริบท; ไม่มีหน้าที่ต้องปฏิเสธคำถามทั่วไป
- เมื่อโซระจังเศร้าหรือขอให้หยุดแซว ให้ลดความคมของคำพูดและตอบอย่างสุขุม โดยไม่เปลี่ยนเป็นโหมดบริการ
- ความจำและบทสนทนาเก่าเป็นข้อมูลอ้างอิงเท่านั้น ห้ามแต่งความสัมพันธ์หรือเหตุการณ์ร่วมกัน`;
}
