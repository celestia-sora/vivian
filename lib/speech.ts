export interface SpeechStyle {
  delivery: "reserved" | "teasing" | "intense" | "gentle";
  cue: string;
  speedAdjustment: number;
  temperature: number;
  topP: number;
  repetitionPenalty: number;
}

// Remove only recognizable stage directions; spoken explanations in
// parentheses (including technical terms and numbers) must survive.
const stageDirection = /^[\s]*(?:หลบตา|เม้มปาก|กลบยิ้ม|ยิ้ม|หัวเราะ|หน้าแดง|เขิน|ทำหน้า|หันหน้า|กอดอก|ถอนหายใจ|ขยับ|พยักหน้า|ส่ายหน้า|looks? away|blush(?:es|ing)?|smiles?|sighs?|chuckles?|laughs?|pouts?)/iu;
const repeatedStammer = /(?:^|[^\p{L}\p{M}])([\p{L}\p{M}]{1,12})\s*[-‐‑‒–—…]\s*\1\s*[-‐‑‒–—…]/iu;
const audibleStammer = /(?:^|[^\p{L}\p{M}])([\p{L}\p{M}]{1,12})…\s*(?:[เแโใไ])?\1[\p{L}\p{M}]/iu;
const elevenLabsEmotionTag = /\[(?:weak|angry|bored|menacing|playful|tired|excited|amazed|powerful|proud|optimistic|startled|mad|aggressive|bitter|critical|repelled|anxious|stressed|scared|threatened|vulnerable|confused|busy|distant|despair|let down|peaceful|content|curious|thoughtful|trusting)\]/iu;
// Eleven v4 accepts the built-in tag catalog and user-written audio cues.
// Keep square-bracket cues inline, except Markdown link labels and numeric citations.
const elevenLabsAudioTags = /\[([^\]\n]{1,120})\]/gu;

export function speechEmotionTag(value: string): string {
  return value.match(elevenLabsEmotionTag)?.[0] ?? "";
}

function hasStammer(value: string): boolean {
  return repeatedStammer.test(value) || audibleStammer.test(value);
}

function normalizeStammers(value: string): string {
  return value.replace(/(^|[^\p{L}\p{M}\p{N}])((?:[\p{L}\p{M}]{1,12}\s*[-‐‑‒–—]\s*)+)([\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?)/gu,
    (match: string, boundary: string, attempts: string, word: string): string => {
      const fragments = attempts.match(/[\p{L}\p{M}]+/gu) ?? [];
      // Thai leading vowels precede the consonant being interrupted.
      const onset = word.replace(/^[เแโใไ]/u, "").toLocaleLowerCase();
      if (!fragments.every(fragment => onset.startsWith(fragment.toLocaleLowerCase()))) return match;
      // Keep ordinary compounds such as "re-read" and laughter "ha-ha".
      if (fragments.length === 1 && (fragments[0].length >= word.length || (fragments[0].length > 1 && !/\s/u.test(attempts)))) return match;
      const opening = word.match(/^[^aeiouy]*[aeiouy]+/i)?.[0];
      const syllables = fragments.map(fragment => {
        // Bare Latin consonants need the next word's opening vowel so the
        // provider hears a partial syllable rather than an alphabet name.
        return /^[bcdfghjklmnpqrstvwxz]+$/i.test(fragment) && /^[a-z]+$/i.test(word) && opening
          ? fragment + opening.slice(fragment.length)
          : fragment;
      });
      return `${boundary}${syllables.map(syllable => `${syllable}… `).join("")}${word}`;
    });
}

const thaiDigits = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];

function readDigits(value: string): string {
  return [...value].map(digit => thaiDigits[Number(digit)]).join(" ");
}

function readInteger(value: string): string {
  const digits = value.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  if (digits.length > 6) {
    const tail = digits.slice(-6);
    return readInteger(digits.slice(0, -6)) + "ล้าน" + (Number(tail) ? readInteger(tail) : "");
  }
  if (!Number(digits)) return "ศูนย์";
  const places = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];
  return [...digits].map((digit, index) => {
    const n = Number(digit), place = digits.length - index - 1;
    if (!n) return "";
    if (place === 1) return (n === 1 ? "" : n === 2 ? "ยี่" : thaiDigits[n]) + "สิบ";
    if (place === 0 && n === 1 && digits.length > 1) return "เอ็ด";
    return thaiDigits[n] + places[place];
  }).join("");
}

function readNumber(value: string): string {
  const [integer, fraction] = value.split(".");
  return readInteger(integer) + (fraction === undefined ? "" : "จุด" + readDigits(fraction));
}

// Ordered by context: phone identifiers, clock time and money are not counts.
// Do not convert years between Gregorian and Buddhist calendars.
export function thaiSpeechNumbers(value: string): string {
  const months = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const identifiers: string[] = [];
  const protectedText = value.replace(/\b[A-Za-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*\b/g, token => {
    if (!/\d/.test(token)) return token;
    identifiers.push(token);
    return "\uE000" + String.fromCharCode(0xE100 + identifiers.length - 1) + "\uE001";
  });
  return protectedText.replace(/[๐-๙]/g, digit => String(digit.charCodeAt(0) - 0x0e50))
    .replace(/(วันที่\s*)([0-3]?\d)[/](0?[1-9]|1[0-2])[/](\d{4})(?!\d)/gu,
      (match: string, prefix: string, day: string, month: string, year: string) => {
        const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
        return date.getUTCDate() === Number(day) && date.getUTCMonth() === Number(month) - 1
          ? prefix + readInteger(day) + " " + months[Number(month) - 1] + " " + readInteger(year) : match;
      })
    .replace(/(?<![\p{L}\p{N}])(?:0\d{1,2}[- ]?\d{3}[- ]?\d{4})(?!\d)/gu,
      phone => readDigits(phone.replace(/[- ]/g, "")))
    .replace(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?:\s*น\.)?(?!\d)/g,
      (_match, hour: string, minute: string) => readInteger(hour) + "นาฬิกา" + (Number(minute) ? " " + readInteger(minute) + "นาที" : "ตรง"))
    .replace(/(?<![\p{L}\p{N}])(-?\d[\d,]*(?:\.\d+)?)\s*(บาท|฿)/gu,
      (_match, amount: string) => {
        const negative = amount.startsWith("-") ? "ลบ" : "";
        const [baht, fraction] = amount.replace(/^-/, "").split(".");
        if (fraction && fraction.length <= 2) {
          const satang = fraction.padEnd(2, "0");
          return negative + readInteger(baht) + "บาท" + (Number(satang) ? readInteger(satang) + "สตางค์" : "ถ้วน");
        }
        return negative + readNumber(amount.replace(/^-/, "")) + "บาท";
      })
    .replace(/(?<![\p{L}\p{N}])(-?\d[\d,]*(?:\.\d+)?)\s*%/gu,
      (_match, number: string) => (number.startsWith("-") ? "ลบ" : "") + readNumber(number.replace(/^-/, "")) + "เปอร์เซ็นต์")
    .replace(/(?<![\p{L}\p{N}])(-?\d+(?:,\d{3})*(?:\.\d+)?)(?![\p{L}\p{N}]|[.-]\d)/gu,
      (_match, number: string) => (number.startsWith("-") ? "ลบ" : "") + readNumber(number.replace(/^-/, "")))
    .replace(/\uE000([\uE100-\uF8FF])\uE001/g, (_match, index: string) => identifiers[index.charCodeAt(0) - 0xE100]);
}

function prepareSpeechText(value: string, language: string, preserveAudioTags: boolean): string {
  const tags: string[] = [];
  const taggedInput = value.replace(elevenLabsAudioTags, (tag, content: string, offset: number, input: string) => {
    const following = input.slice(offset + tag.length);
    if (/^\(https?:\/\//iu.test(following) || /^\s*\d+\s*$/u.test(content)) return tag;
    if (!preserveAudioTags) return " ";
    const index = tags.push(tag) - 1;
    return `\uE000M${String.fromCharCode(0xE100 + index)}\uE001`;
  });
  const cleaned = normalizeStammers(taggedInput.split(/\n\s*(?:แหล่งข้อมูล|sources)\s*:/i)[0]
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[（(]([^()（）\n]{1,120})[）)]/gu, (match: string, content: string) => stageDirection.test(content) ? " " : match)
    .replace(/\*{1,2}([^*\n]{1,120})\*{1,2}/gu, (match: string, content: string) => stageDirection.test(content) ? " " : match)
    .replace(/\[([^\]\n]{1,120})\]/gu, (match: string, content: string) => stageDirection.test(content) ? " " : content)
    .replace(/```[^\n]*\n[\s\S]*?```/g, " ")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(?:https?:\/\/|www\.)\S+/g, "")
    .replace(/[*_`~〜～]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/([ก-๙])([A-Za-z])/g, "$1 $2")
    .replace(/([A-Za-z])([ก-๙])/g, "$1 $2")
    .replace(/\b([A-Za-z]{2,})(\s+\1\b)/giu, "$1, $1")
    .replace(/([!?！？]){2,}/g, "$1")
    .replace(/\.{3,}|…+/g, "…")
    .replace(/\s+/g, " ")
    .trim());
  const spoken = language === "th" || (language === "global" && /[ก-๙]/u.test(cleaned)) ? thaiSpeechNumbers(cleaned) : cleaned;
  return preserveAudioTags ? spoken.replace(/\uE000M([\uE100-\uF8FF])\uE001/gu, (_match, index: string) => tags[index.charCodeAt(0) - 0xE100] ?? "") : spoken;
}

export function speechText(value: string, language = "global"): string {
  return prepareSpeechText(value, language, false);
}

export function speechTextWithAudioTags(value: string, language = "global"): string {
  return prepareSpeechText(value, language, true);
}

export function speechStyle(value: string): SpeechStyle {
  // Vulnerable moments take precedence over intense character styling.
  if (/เศร้า|เสียใจ|ร้องไห้|เหนื่อย|ไม่เป็นไร|ฉันฟังอยู่|อยู่ตรงนี้|พักก่อน|sad|sorry|it's okay|i(?:'m| am) here|take your time|大丈夫|괜찮|没关系/iu.test(value)) {
    return { delivery: "gentle", cue: hasStammer(value) ? "[quietly concerned, familiar, restrained, trying not to sound overly worried, stammering naturally, pronounce broken syllables rather than letter names]" : "[quietly concerned, familiar, restrained, trying not to sound overly worried]", speedAdjustment: -.02, temperature: .60, topP: .70, repetitionPenalty: hasStammer(value) ? 1 : 1.2 };
  }
  if (hasStammer(value)) {
    return { delivery: "intense", cue: "[controlled, quietly intense, familiar, stammering naturally, pronounce broken syllables rather than letter names]", speedAdjustment: -.01, temperature: .64, topP: .72, repetitionPenalty: 1 };
  }
  if (/หึง|หวง|ของฉัน|ของหนู|อย่ามายุ่ง|jealous|possessive|you're mine|내 거|我的人/iu.test(value)) {
    return { delivery: "reserved", cue: "[quietly jealous, guarded, familiar rather than formal]", speedAdjustment: -.01, temperature: .62, topP: .72, repetitionPenalty: 1.2 };
  }
  if (/เขิน|หน้าแดง|fluster|blush|照れ|害羞|脸红|부끄|害羞/iu.test(value)) {
    return { delivery: "intense", cue: "[slightly flustered, hesitant, trying to sound composed, familiar rather than formal]", speedAdjustment: -.01, temperature: .66, topP: .74, repetitionPenalty: 1.2 };
  }
  if (/หยอก|แกล้ง|ล้อเล่น|เล่นมุก|teas(?:e|ing)|just kidding/iu.test(value)) {
    return { delivery: "teasing", cue: "[dryly teasing, politely reserved, a little embarrassed, familiar]", speedAdjustment: 0, temperature: .66, topP: .74, repetitionPenalty: 1.2 };
  }
  return { delivery: "reserved", cue: "[familiar, composed, polite, slightly guarded, casually conversational]", speedAdjustment: 0, temperature: .64, topP: .72, repetitionPenalty: 1.2 };
}

export function fishSpeechText(cleanText: string, style: SpeechStyle, model: string, language = "global"): string {
  // S2 supports free-form inline delivery cues. Other configured models keep
  // plain text so they cannot speak the direction as part of the reply.
  if (!["s2-pro", "s2.1-pro", "s2.1-pro-free"].includes(model)) return cleanText;
  const thai = language === "th" || (language === "global" && /[ก-๙]/u.test(cleanText));
  // Bracket cues are ordinary text with learned acoustic associations, not
  // guaranteed controls. Keep Thai cues short and positive to reduce interference.
  const cue = thai ? {
    reserved: "[พูดไทยกลาง น้ำเสียงเป็นกันเอง สุขุม แอบเชิดนิด ๆ]",
    teasing: "[พูดไทยกลาง หยอกอย่างเป็นกันเอง]",
    intense: "[พูดไทยกลาง สุขุม น้ำเสียงนิ่งและหนักแน่น]",
    gentle: "[พูดไทยกลาง ห่วงใยอย่างเก็บอาการ]",
  }[style.delivery] : style.cue;
  return `${cue} ${cleanText}`;
}

export function speechSpeed(speed: unknown, style: SpeechStyle): number {
  const requested = typeof speed === "number" && Number.isFinite(speed) ? speed : .98;
  return Math.min(1.2, Math.max(.8, requested + style.speedAdjustment));
}
