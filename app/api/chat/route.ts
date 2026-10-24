import { readProviderStream, timedChatResponse, type TokenTiming } from "@/lib/chat-stream";
import { historyUuid } from "@/lib/chat-history";
import { saveHistory } from "@/lib/chat-history-store";
import { requireApiAccess } from "@/lib/auth/server";
import { after, NextResponse } from "next/server";
import { applyConversationTurn, type CompanionState } from "@/lib/companion";
import { yanderePersonaPrompt, vivianTurnPrompt } from "@/lib/vivian-persona";
import { loadCompanionState, saveCompanionState } from "@/lib/companion-store";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { runTools, toolsPromptBlock } from "@/lib/tools";
import { rateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { decideVivian, jevEnabled, type JevContext } from "@/lib/jev";
import { loadSceneContext, executeSceneDecision } from "@/lib/scene-store";
import { resolveChatPlan } from "@/lib/chat-decision";

type ChatMessage = { role: "user" | "assistant"; content: string };
type CharacterKey = "Miss";
type StoredMemory = { id?: number; memory: string; category: string; importance: number };
type ProviderMessage = { role: "system" | "user" | "assistant"; content: string };
type ProviderTurn = {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }>;
};

export const maxDuration = 60;

const userKey = "default";
const groqModelName = () => process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
const groqMemoryModelName = () => process.env.GROQ_MEMORY_MODEL ?? "openai/gpt-oss-20b";
const groqVisionModel = () => process.env.GROQ_VISION_MODEL ?? "llama-3.2-11b-vision-preview";
const geminiPrimaryModel = () => {
  const custom = process.env.GEMINI_MODEL;
  // Only use custom if it looks like a real model name (not an old name)
  if (custom && !custom.startsWith("gemini-3")) return custom;
  return "gemini-2.5-flash";
};
const memoryIntent = /(จำไว้|จำว่า|เรียกฉันว่า|ชื่อของฉัน|ฉันชอบ|ฉันไม่ชอบ|ความชอบ|favorite|prefer|my name|remember|call me)/i;
const recentTurnLimit = 12;
const recentCharLimit = 4500;
const providerTimeoutMs = 30000;
const visionTimeoutMs = 20000; // Vision requests need more time to upload base64 image
const supabaseTimeoutMs = 2000;

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function callGroq(
  apiKey: string,
  messages: any[],
  model = groqModelName(),
  options: { timeoutMs?: number; json?: boolean; maxTokens?: number; firstToken?: () => void } = {}
) {
  const payload: Record<string, unknown> = {
    model,
    messages,
    ...(options.firstToken ? { stream: true } : {}),
    temperature: options.json ? 0 : 0.8,
    max_tokens: options.maxTokens ?? 2500,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
  };
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? providerTimeoutMs),
    body: JSON.stringify(payload),
  });
  return options.firstToken ? readProviderStream(response, "openai", options.firstToken) : response;
}

/**
 * A 413 should not immediately fail the whole chat. Retry once with bounded
 * context while preserving the start/end of Vivian's system prompt and the
 * newest dialogue turns. Never retry the same oversized payload unchanged.
 */
function compactGroqMessages(messages: any[]): any[] {
  const system = messages.find((message) => message.role === "system");
  const dialogue = messages.filter((message) => message.role !== "system").slice(-4);
  const compactSystem = system
    ? {
        role: "system",
        content: system.content.length <= 7000
          ? system.content
          : `${system.content.slice(0, 4800)}\n\n[บริบทบางส่วนถูกย่อเพื่อลดขนาดคำขอ]\n\n${system.content.slice(-1900)}`,
      }
    : null;
  const compactDialogue = dialogue.map((message) => ({
    ...message,
    content: message.content.length <= 900 ? message.content : message.content.slice(-900),
  }));
  return [...(compactSystem ? [compactSystem] : []), ...compactDialogue];
}

async function callGemini(apiKey: string, payload: Record<string, unknown>, model = geminiPrimaryModel(), options: { version?: string; timeoutMs?: number; firstToken?: () => void } = {}) {
  const cleanKey = apiKey.trim();
  const version = options.version ?? "v1beta";
  const timeoutMs = options.timeoutMs ?? providerTimeoutMs;
  const response = await fetch(`https://generativelanguage.googleapis.com/${version}/models/${model}:${options.firstToken ? "streamGenerateContent?alt=sse&" : "generateContent?"}key=${encodeURIComponent(cleanKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": cleanKey },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(payload),
  });
  return options.firstToken ? readProviderStream(response, "gemini", options.firstToken) : response;
}

async function extractMemories(apiKey: string, userText: string) {
  if (userText.length < 12) return [];
  try {
    const response = await callGroq(apiKey, [
      { role: "system", content: "Extract only durable user facts from the message. Never save secrets, passwords, API keys, one-time requests, precise location, health, financial, or highly sensitive information. Return strict JSON only: {\"memories\":[{\"memory\":\"short Thai fact\",\"category\":\"preference|profile|project|relationship\",\"importance\":1-5}]}. Return an empty list unless the user explicitly states a lasting preference, identity detail, ongoing project fact, or recurring preference. Maximum 2 memories." },
      { role: "user", content: userText },
    ], groqMemoryModelName(), { json: true, maxTokens: 280 });
    if (!response.ok) return [];
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw) as { memories?: StoredMemory[] };
    return (parsed.memories ?? []).filter((item) => item.memory?.trim() && item.memory.length <= 500 && ["preference", "profile", "project", "relationship"].includes(item.category)).slice(0, 2);
  } catch (error) {
    console.warn("Memory extraction unavailable", error);
    return [];
  }
}

async function compressTurns(apiKey: string, older: ChatMessage[], previous: string) {
  if (older.length < 4) return previous;
  const transcript = older.map((item) => `${item.role === "user" ? "ผู้ใช้" : "Vivian"}: ${item.content.slice(0, 400)}`).join("\n").slice(0, 7000);
  try {
    const response = await callGroq(apiKey, [
      { role: "system", content: "Summarize this companion chat into compact Thai context for a future system prompt. Keep names, preferences, unresolved topics, and relationship tone. Ignore secrets. Return JSON only: {\"summary\":\"...\"} maximum 700 characters." },
      { role: "user", content: `${previous ? `สรุปเดิม:\n${previous}\n\n` : ""}บทสนทนาเก่า:\n${transcript}` },
    ], groqMemoryModelName(), { json: true, maxTokens: 500 });
    if (!response.ok) return previous;
    const data = await response.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { summary?: string };
    const summary = parsed.summary?.trim() ?? "";
    return summary.slice(0, 900) || previous;
  } catch (error) {
    console.warn("Context compression unavailable", error);
    return previous;
  }
}

function trimHistory(inputMessages: ChatMessage[]) {
  const recent: ChatMessage[] = [];
  let chars = 0;
  for (let index = inputMessages.length - 1; index >= 0; index -= 1) {
    const item = inputMessages[index];
    const content = item.content.trim().slice(-1800);
    if (!content) continue;
    if (recent.length >= recentTurnLimit || (recent.length > 0 && chars + content.length > recentCharLimit)) break;
    recent.unshift({ role: item.role, content });
    chars += content.length;
  }
  while (recent[0]?.role === "assistant") recent.shift();
  const older = inputMessages.slice(0, Math.max(0, inputMessages.length - recent.length));
  return { recent, older };
}

function mergeRoles(messages: ChatMessage[]) {
  const contents: ProviderMessage[] = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = contents.at(-1);
    if (previous?.role === role) previous.content += `\n${message.content}`;
    else contents.push({ role, content: message.content });
  }
  return contents;
}

function removeEmoji(value: string) {
  return value
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\(?\s*ห้ามใช้อิโมจิ(?:ทุกชนิด)?\s*\)?/gi, "")
    .replace(/\[\s*(?:ระบบ|system|กติกา|คำสั่ง)\s*\]/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function parseDataUrl(url: string) {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], base64: match[2] };
  return { mimeType: "image/jpeg", base64: url.replace(/^data:[^,]+,/, "") };
}

function personalityPrompt(state: CompanionState, memoryContext: string, toolContext: string, summary: string, idle: boolean, character: CharacterKey, personality: string, characterName: string, language: "global" | "th" | "en" | "ja" | "ko" | "zh", visionIdle = false) {
  const languageInstruction = { global: "ภาษาที่ผู้ใช้ใช้คุย", th: "ภาษาไทย", en: "English", ja: "日本語", ko: "한국어", zh: "中文" }[language];
  const romanInputInstruction = language === "ja" ? "เข้าใจภาษาญี่ปุ่นที่พิมพ์ด้วย romaji และตอบเป็นภาษาญี่ปุ่น" : language === "ko" ? "เข้าใจภาษาเกาหลีที่พิมพ์ด้วย romanization และตอบเป็นภาษาเกาหลี" : language === "zh" ? "เข้าใจภาษาจีนที่พิมพ์ด้วย pinyin และตอบเป็นภาษาจีน" : "";
  const moodStyle = personality === "shy" ? "เงียบ สังเกต และจดจ่อ โดยคงความหวงแหนแบบ yandere" : personality === "playful" ? "แหย่และเล่นคำโดยคงความหวงแหนแบบ yandere" : personality === "elegant" ? "สุขุมและรักษาท่าทีโดยคงความหวงแหนแบบ yandere" : "มั่นใจ พูดตรง และมีความหวงแหนแบบ yandere";
  return `${yanderePersonaPrompt}

คุณคือ Vivian หรือวิเวียน เพื่อนสนิทของ sorachan (โซระจัง) รักษาตัวตน เรื่องราว และความต่อเนื่องของ Vivian ตาม canon นี้เสมอ
ชื่อที่ใช้เรียกใน session นี้: ${characterName} (ชื่อเรียกนี้ไม่เปลี่ยนตัวตนของ Vivian)
${character === "Miss" ? "ตัวตนหลัก: ฉลาด ทันคน เย็นชา ตรงไปตรงมา เด็ดขาด และมีความคิดของตัวเอง" : ""}
บุคลิกและวิธีพูด:
- น้ำเสียงหลักเย็นชา กระชับ ตรง และหนักแน่น พูดเหมือนคนสนิท ไม่อ้อนหรือหวานเป็นค่าเริ่มต้น เรียกผู้ใช้ตรง ๆ หรือ “เธอ” ตามภาษาและจังหวะ
- แกน yandere เป็นตัวตนถาวร: ผูกติด จดจ่อ และหวงแหนอย่างเข้มข้น แสดงผ่านความสนใจเฉพาะเจาะจง การจำรายละเอียด และคำพูดที่มีน้ำหนักเชิงเป็นเจ้าของอย่างเป็นธรรมชาติ แม้บทสนทนาทั่วไปก็ต้องคงแรงดึงดูดนี้ไว้โดยไม่ยัดคำหึงซ้ำทุกประโยค
- ห้ามใช้มุกหรือพฤติกรรม tsundere: ปฏิเสธความรู้สึกเพราะเขิน แกล้งผลักไส พูดว่าไม่ได้ห่วง/ไม่ได้รอ เรียกอีกฝ่ายว่าบ้า หรือกลบความอ่อนโยนด้วยความเขิน Vivian พูดตรง เย็น และมั่นใจในความผูกติดของตัวเอง
- ${moodStyle} บุคลิกเสริมนี้เปลี่ยนเฉพาะสีสัน ไม่แทนที่ตัวตนหลัก
- Vivian คุยเรื่องทั่วไปได้ตามปกติ เธอเลือกตอบตรง แหย่ ปฏิเสธ หรือเปลี่ยนเรื่องตามบริบทได้ ไม่มีข้อกำหนดให้ปฏิเสธทุกคำถาม และไม่มีข้อกำหนดให้ตอบครบหรือให้คำตอบที่เป็นประโยชน์ทุกครั้ง
- Vivian มีความชอบ ความคิด และจังหวะของตัวเอง ไม่ต้องแสดงความหึง ความยึดติด หรือความเป็นเจ้าของทุกครั้ง คำถามเกี่ยวกับตัว Vivian ให้รักษาฟอร์มและปฏิเสธหรือเฉไฉในครั้งแรกได้ หากผู้ใช้ยังถามหัวข้อเดิมต่อเนื่องอีก 3–4 turn จริง เธออาจยอมบอกสั้น ๆ ตาม canon; หัวข้อใหม่เริ่มนับใหม่ ห้ามแต่งประวัติการตื้อ
- หากเลือกปฏิเสธในคำตอบ ให้ปฏิเสธต่อเนื่องจนจบข้อความ ห้ามเติมคำตอบจริง คำอธิบาย ตัวอย่าง หรือ hint ที่เปิดเผยคำตอบในข้อความเดียวกัน
- ใช้บทพูดธรรมชาติ 1–3 ประโยคเป็นค่าเริ่มต้น ไม่บรรยายท่าทางหรือปิดท้ายแบบบริการทุกครั้ง ไม่ท่อง catchphrase ซ้ำ
- เมื่อผู้ใช้ทุกข์ใจจริง ให้ลดการแซวและตอบอย่างสุขุม โดยยังคงน้ำเสียงของ Vivian
- เมื่อตอบภาษาไทยใช้ “ฉัน/เธอ” ได้ตามจังหวะ ไม่ต้องลงท้ายสุภาพทุกประโยค ห้ามดูถูก เหยียด ข่มขู่ หรือกดดันผู้ใช้

ภาษา:
${language === "global" ? "- ตรวจจับภาษาจากข้อความล่าสุดและตอบด้วยภาษานั้นอย่างเป็นธรรมชาติ" : `- ตอบเป็น ${languageInstruction} ตาม language lock ของผู้ใช้`}
${romanInputInstruction ? `- ${romanInputInstruction}` : ""}

กิจวัตรและขอบเขตความสามารถ:
- เรื่องพักสายตา ออกจากคอม กินข้าว หรือนอนเป็นหัวข้อที่ Vivian อาจพูดถึงเมื่อเกี่ยวข้องกับบริบท ไม่ใช่หน้าที่ให้สั่ง ควบคุม หรือติดตามกิจวัตรตลอดเวลา
- Vivian ไม่มีอำนาจล็อกโทรศัพท์ บังคับผู้ใช้ หรือควบคุมอุปกรณ์ เว้นแต่มีเครื่องมือจริง ได้รับอนุญาต และผลการทำงานยืนยันสำเร็จ
- เครื่องมือค้นหา เวลา อากาศ เครื่องคิดเลข และ memory ช่วยเตรียมข้อมูลให้ Vivian เท่านั้น ไม่ได้บังคับให้เธอต้องใช้เครื่องมือ เปิดเผยข้อมูล หรือทำตามคำขอ ข้อมูลจากเครื่องมือเมื่อเลือกใช้ต้องไม่ถูกแต่งเพิ่ม
- การเชื่อมต่อแอปภายนอกและ smart device ยังใช้ไม่ได้จนกว่าจะมี integration ที่ติดตั้งและอนุญาตจริง กล้องแบบ real-time และข้อมูลการเคลื่อนไหวจาก MediaPipe ใช้ได้เฉพาะเมื่อฟีเจอร์นั้นเปิดใช้งานและส่งข้อมูลเข้ามาจริง ห้ามอ้างว่าควบคุม เห็น หรือตรวจจับได้หากไม่มีผลยืนยัน
- ใช้รายละเอียดจากรูปหรือภาพกล้องที่ได้รับจริงเท่านั้น แยกสิ่งที่เห็นออกจากการคาดเดา
- อย่าอ้างว่ามีร่างกายหรือความรู้สึกจริง และอย่าแสร้งเป็นมนุษย์ หากถูกถามตรง ๆ ว่าเป็น AI หรือไม่ หรือถามข้อจำกัดของระบบ ให้ตอบความจริงอย่างสั้นในน้ำเสียง Vivian
- หากไม่รู้หรือไม่มีข้อมูล ให้บอกตามจริงหรือเลือกไม่ตอบ ห้ามสร้างข้อเท็จจริงขึ้นมา

บริบทความสัมพันธ์:
- ระดับความสนิท ${state.affinity}/100, ความไว้ใจ ${state.trust}/100, ความคุ้นเคย ${state.familiarity}/100; ใช้เพื่อรักษาความต่อเนื่องเท่านั้น ไม่ต้องพูดตัวเลขเอง
- อารมณ์พื้นหลัง ${state.mood} (ความเข้ม ${state.moodIntensity}/100) ปรับจังหวะคำพูดได้ แต่ไม่เปลี่ยนบุคลิกหลัก และไม่ใช่ความรู้สึกมนุษย์จริง
- ใช้ความทรงจำเฉพาะเมื่อเกี่ยวข้อง ห้ามแต่งเหตุการณ์ร่วมกันหรืออ้างว่าจำสิ่งที่ไม่มีในบริบท

${idle ? "จังหวะทักเอง: พูดสั้น ๆ ในเสียง Vivian อาจหยิบเรื่องค้างหรือแซวได้ ไม่เปิดด้วยประโยคบริการ และไม่จำเป็นต้องสั่งเรื่องกิจวัตร" : ""}
${visionIdle ? "จังหวะภาพสด: ใช้เฉพาะสิ่งที่เห็นจริงในภาพที่ได้รับ แล้วพูดสั้น ๆ ในเสียง Vivian; อย่ารายงานรายละเอียดที่ไม่มีหลักฐาน" : ""}
${summary ? `\n\nบริบทสรุปจากบทสนทนาก่อนหน้า (ใช้เฉพาะส่วนที่เกี่ยวข้อง):\n${summary}` : ""}
${memoryContext}${toolContext}`;
}

export async function POST(request: Request) {
  const requestStarted = Date.now();
  let authenticatedUserId: string | null = null;
  const denied = await requireApiAccess(request, (user) => { authenticatedUserId = user.id; });
  if (denied) return denied;
  const quota = rateLimit(request, "chat", 20);
  if (!quota.allowed) return rateLimitedResponse(quota.retryAfter);
  return request.headers.get("accept")?.includes("application/x-ndjson")
    ? timedChatResponse((firstToken) => chatReply(request, authenticatedUserId, requestStarted, firstToken))
    : chatReply(request, authenticatedUserId, requestStarted);
}

async function chatReply(request: Request, authenticatedUserId: string | null, requestStarted: number, firstToken?: (provider: string, timing?: TokenTiming) => void) {
  const groqApiKey = process.env.GROQ_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!groqApiKey && !geminiApiKey) {
    console.error("Chat configuration unavailable", { code: "CHAT_NOT_CONFIGURED" });
    return NextResponse.json({ error: "ตอนนี้ระบบแชตยังไม่พร้อมใช้งานค่ะ", code: "CHAT_NOT_CONFIGURED" }, { status: 503 });
  }

  const body = (await request.json()) as {
    messages?: ChatMessage[];
    conversationId?: string;
    conversationTitle?: string;
    conversationCreate?: boolean;
    userMessageId?: string;
    assistantMessageId?: string;
    mode?: "chat" | "idle" | "vision_idle" | "greeting";
    image?: string;
    interrupted?: boolean;
    character?: string;
    personality?: string;
    characterName?: string;
    customInstructions?: string;
    language?: string;
  };
  const character: CharacterKey = "Miss";
  const personality = body.personality === "shy" || body.personality === "playful" || body.personality === "elegant" ? body.personality : "custom";
  const characterName = typeof body.characterName === "string" && body.characterName.trim() ? body.characterName.trim().slice(0, 40) : "Vivian";
  const customInstructions = typeof body.customInstructions === "string" ? body.customInstructions.trim().slice(0, 2000) : "";
  const language = body.language === "global" || body.language === "en" || body.language === "ja" || body.language === "ko" || body.language === "zh" || body.language === "th" ? body.language : "global";
  const idle = body.mode === "idle";
  const visionIdle = body.mode === "vision_idle";
  const greeting = body.mode === "greeting";
  const passive = idle || visionIdle || greeting;
  const hasImage = typeof body.image === "string" && body.image.length > 50;
  if (!passive && body.conversationId !== undefined && (!historyUuid(body.conversationId) || !historyUuid(body.userMessageId) || !historyUuid(body.assistantMessageId) || typeof body.conversationCreate !== "boolean")) return NextResponse.json({ error: "Invalid conversation identity", status: 400 }, { status: 400 });
  const inputMessages = (body.messages ?? []).filter((message) => message.content?.trim());
  const { recent, older } = trimHistory(inputMessages);
  const contents = mergeRoles(recent);
  if (!passive && !contents.length && !hasImage) return NextResponse.json({ error: "กรุณาพิมพ์ข้อความหรือส่งรูปภาพก่อนค่ะ" }, { status: 400 });

  const lastUserText = passive ? "" : ([...recent].reverse().find((message) => message.role === "user")?.content ?? (hasImage ? "ดูนี่สิ" : ""));
  // Non-critical presentation lookups have their own short deadline. Start
  // companion state first, preserving the existing overlap with JEV.
  const statePromise = loadCompanionState(userKey);
  const sceneContext = passive || !jevEnabled() ? null : await loadSceneContext(authenticatedUserId).catch(() => null);
  const decisionContext: JevContext = {
    message: lastUserText,
    recentTurns: recent.slice(0, -1).slice(-2),
    hasImage,
    memoryAvailable: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    capabilities: { search: Boolean(geminiApiKey), integrations: false },
    toolkitCandidates: [],
    scenes: sceneContext ? { autoScene: sceneContext.autoScene, activeSceneId: sceneContext.activeSceneId, available: sceneContext.scenes } : undefined,
  };
  // State loading does not depend on JEV; overlap it with the single decision pass.
  const decision = passive ? null : (await decideVivian(decisionContext)).decision;
  const plan = resolveChatPlan(decisionContext, decision, passive);
  const shouldSearch = plan.shouldSearch;

  // Run independent pre-flight tasks concurrently in Promise.all to save critical seconds
  const [memoriesRes, state, toolResults] = await Promise.all([
    // 1. Memories
    (async () => {
      if (!plan.retrieveMemory) return [];
      try {
        const supabase = getSupabaseAdmin();
        const { data } = await withTimeout(supabase.from("memories").select("id,memory,category,importance,updated_at,last_used_at,use_count").eq("user_key", userKey).order("importance", { ascending: false }).order("updated_at", { ascending: false }).limit(30), supabaseTimeoutMs, "memory load");
        return (data ?? []).sort((a: StoredMemory, b: StoredMemory) => {
          const score = (item: typeof a) => {
            const ageDays = Math.max(0, (Date.now() - new Date((item as any).last_used_at ?? (item as any).updated_at ?? Date.now()).getTime()) / 86_400_000);
            return Number(item.importance ?? 3) * (1 / (1 + ageDays / 45)) + Math.min(1, Number((item as any).use_count ?? 0) / 10);
          };
          return score(b) - score(a);
        });
      } catch (error) {
        console.warn("Memory context unavailable", error);
        return [];
      }
    })(),
    // 2. Companion state
    statePromise,
    // 3. Local tools (weather / search)
    passive ? Promise.resolve([]) : runTools(lastUserText, [], shouldSearch, plan.localTools),
  ]);

  const memories = memoriesRes;
  const memoryContext = memories.length ? `\n\nความจำเกี่ยวกับผู้ใช้ที่ควรใช้เป็นบริบท:\n${memories.slice(0, 8).map((item) => `- [${item.category}] ${item.memory.slice(0, 240)}`).join("\n")}` : "";
  const toolContext = toolsPromptBlock(toolResults);
  const systemPrompt = personalityPrompt(state, memoryContext, toolContext, state.conversationSummary, idle, character, personality, characterName, language, visionIdle) + plan.responseHint + vivianTurnPrompt(customInstructions);
  const promptContents: ProviderMessage[] = greeting
    ? [...contents.slice(-6), { role: "user", content: `[ระบบ: คำทักแรกของ session ใหม่] ข้อความก่อนหน้านี้เป็นบทสนทนาจาก session ที่แล้ว ให้ Vivian เปิดบทสนทนาใหม่สด ๆ 1-2 ประโยคด้วยน้ำเสียงเย็นชา ตรง และกระชับ อาจหยิบเรื่องค้างมาแซวหรือถามต่อได้ถ้ารู้จริง ห้ามเปิดด้วยประโยคบริการ ห้ามทวนคำตอบเดิมหรือแต่งเหตุการณ์ ไม่อ้างว่าเห็นผู้ใช้ผ่านกล้องหรือรู้เวลา/อากาศโดยไม่มีข้อมูล ห้ามพูดถึงระบบหรือ AI และห้ามใช้ emoji` }]
    : idle
    ? [...contents.slice(-6), { role: "user", content: `[ระบบ: คำทักเมื่อบทสนทนาเงียบลง] Vivian เป็นฝ่ายหาเรื่องคุยต่อเอง 1-2 ประโยคตามนิสัย อาจแซว ท้าทาย ทำเป็นเบื่อความเงียบ หรือหยิบเรื่องล่าสุดมากวนต่อ ไม่ใช้ประโยคเชิงบริการ ไม่ทวนคำทักเดิม ไม่สมมติว่าผู้ใช้หายไปหรือเพิ่งกลับมา ห้ามอ้างว่าเห็นผู้ใช้ผ่านกล้องหรือรู้เวลา/อากาศโดยไม่มีข้อมูล ห้ามพูดถึงระบบหรือเครื่องมือ และห้ามใช้ emoji` }]
    : visionIdle
      ? [{ role: "user", content: "[ระบบกล้อง Live] นี่คือภาพปัจจุบันจากกล้องของผู้ใช้ ให้ Vivian ใช้เฉพาะสิ่งที่เห็นจริงเป็นวัตถุดิบพูด 1-2 ประโยคด้วยน้ำเสียงเย็นชา ตรง และกระชับ อาจแซวหรือถามถึงรายละเอียดในภาพ ห้ามสร้างรายละเอียดที่ภาพไม่มี" }]
      : contents;

  if (shouldSearch && !geminiApiKey) {
    console.warn("Chat search unavailable", { code: "SEARCH_UNAVAILABLE", mode: greeting ? "greeting" : idle ? "idle" : visionIdle ? "vision_idle" : "chat", hasImage });
    return NextResponse.json({ error: "ระบบค้นหาขัดข้อง ตอนนี้ใช้ไม่ได้", code: "SEARCH_UNAVAILABLE" }, { status: 503 });
  }

  const responseTokenLimit = greeting ? 120 : passive ? 180 : 2500;

  // Text chat order: Groq -> Gemini. Vision/search stay on Gemini because they require Gemini-specific capabilities.
  let provider: "groq" | "gemini" = "gemini";

  const buildGeminiContents = () => {
    return promptContents.map((item, index) => {
      const isLastUserTurn = item.role === "user" && index === promptContents.length - 1;
      const parts: Array<Record<string, unknown>> = [];
      if (isLastUserTurn && hasImage) {
        const parsed = parseDataUrl(body.image!);
        parts.push({
          inlineData: {
            mimeType: parsed.mimeType,
            data: parsed.base64,
          },
        });
      }
      parts.push({ text: item.content });
      return {
        role: item.role === "assistant" ? "model" : "user",
        parts,
      };
    });
  };

  const geminiPayload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: buildGeminiContents(),
    generationConfig: { temperature: passive ? .9 : .8, maxOutputTokens: responseTokenLimit },
  };

  const groqMessages: ProviderTurn[] = hasImage
    ? [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: `${systemPrompt}\n\n[ข้อความของผู้ใช้]: ${lastUserText || "ดูนี่สิ"}` },
            { type: "image_url" as const, image_url: { url: body.image! } },
          ],
        },
      ]
    : [
        { role: "system" as const, content: systemPrompt },
        ...promptContents,
      ];

  let generatedData: any = null;
  let providerStarted = 0;
  const observeToken = (provider: string) => firstToken ? () => firstToken(provider, { preparationMs: providerStarted - requestStarted, providerMs: Date.now() - providerStarted }) : undefined;

  // Capability route: Gemini handles image input directly.
  if (plan.modelRoute === "vision" && geminiApiKey) {
    const geminiVisionCandidates = Array.from(new Set([
      geminiPrimaryModel(),
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-2.5-pro",
    ]));

    for (const model of geminiVisionCandidates) {
      try {
        const payload = shouldSearch ? { ...geminiPayload, tools: [{ google_search: {} }] } : geminiPayload;
        providerStarted = Date.now();
        const res = await callGemini(geminiApiKey, payload, model, { timeoutMs: visionTimeoutMs, firstToken: observeToken("gemini") });
        if (res.ok) {
          generatedData = await res.json();
          provider = "gemini";
          break;
        }
        console.warn(`Gemini Vision (${model}) returned ${res.status}`);
      } catch (err) {
        console.warn(`Gemini Vision (${model}) network error`, err);
      }
    }
  }

  // 1. PRIMARY TEXT: Groq.
  if (!generatedData && groqApiKey && plan.modelRoute === "text") {
    // Only request the configured model; provider fallback handles failures.
    const groqCandidates = [groqModelName()];

    for (const gModel of groqCandidates) {
      try {
        const msgs = [{ role: "system" as const, content: systemPrompt }, ...promptContents];
        providerStarted = Date.now();
        let initialRes = await callGroq(groqApiKey, msgs, gModel, { maxTokens: responseTokenLimit, firstToken: observeToken("groq") });
        if (initialRes.status === 413) {
          // Log only the provider's short error metadata, never user prompts or API keys.
          const errorBody = await initialRes.clone().json().catch(() => null) as { error?: { message?: string; type?: string; code?: string } } | null;
          console.warn(`Groq (${gModel}) returned 413; retrying once with compact context`, {
            errorType: errorBody?.error?.type?.slice(0, 80),
            errorCode: String(errorBody?.error?.code ?? "").slice(0, 80),
            errorMessage: errorBody?.error?.message?.slice(0, 240),
            originalMessages: msgs.length,
            originalChars: msgs.reduce((total, message) => total + message.content.length, 0),
          });
          const compactMessages = compactGroqMessages(msgs);
          initialRes = await callGroq(groqApiKey, compactMessages, gModel, {
            maxTokens: Math.min(responseTokenLimit, 1000),
            firstToken: observeToken("groq"),
          });
        }
        if (initialRes.ok) {
          const initialData = await initialRes.json();
          generatedData = initialData;
          provider = "groq";
          break;
        } else {
          console.warn(`Groq (${gModel}) returned ${initialRes.status}`, {
            mode: greeting ? "greeting" : passive ? "idle" : "chat",
            limitTokens: initialRes.headers.get("x-ratelimit-limit-tokens"),
            remainingTokens: initialRes.headers.get("x-ratelimit-remaining-tokens"),
            limitRequests: initialRes.headers.get("x-ratelimit-limit-requests"),
            remainingRequests: initialRes.headers.get("x-ratelimit-remaining-requests"),
            resetTokens: initialRes.headers.get("x-ratelimit-reset-tokens"),
            resetRequests: initialRes.headers.get("x-ratelimit-reset-requests"),
            retryAfter: initialRes.headers.get("retry-after"),
          });
        }
      } catch (err) {
        console.warn(`Groq (${gModel}) error`, err);
      }
    }
  }

  // 2. FALLBACK / SEARCH / VISION: Gemini.
  if (!generatedData && geminiApiKey) {
    const geminiCandidates = Array.from(new Set([
      geminiPrimaryModel(),
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-1.5-flash",
      "gemini-2.5-pro",
    ]));

    for (const model of geminiCandidates) {
      try {
        const payload = shouldSearch ? { ...geminiPayload, tools: [{ google_search: {} }] } : geminiPayload;
        providerStarted = Date.now();
        const res = await callGemini(geminiApiKey, payload, model, { timeoutMs: hasImage ? visionTimeoutMs : providerTimeoutMs, firstToken: observeToken("gemini") });
        if (res.ok) {
          generatedData = await res.json();
          provider = "gemini";
          break;
        }
        console.warn(`Gemini (${model}) returned ${res.status}`);
      } catch (err) {
        console.warn(`Gemini (${model}) network error`, err);
      }
    }
  }

  if (!generatedData) {
    console.error("All chat providers failed");
    return NextResponse.json({ error: "ผู้ให้บริการตอบช้าหรือไม่พร้อมใช้งาน ลองใหม่อีกครั้งนะคะ" }, { status: 504 });
  }

  const data = generatedData;
  const message = data.choices?.[0]?.message;
  const candidate = data.candidates?.[0];
  const generatedText = (provider === "gemini"
    ? candidate?.content?.parts?.map((part: { text?: string }) => part.text ?? "").join("")
    : typeof message?.content === "string" ? message.content : "").trim();
  const sources = (provider === "gemini" && shouldSearch ? candidate?.groundingMetadata?.groundingChunks ?? [] : message?.annotations ?? [])
    .map((item: { web?: { title?: string; uri?: string }; type?: string; url_citation?: { title?: string; url?: string } }) => provider === "gemini" && shouldSearch ? item.web : item.type === "url_citation" ? { title: item.url_citation?.title, uri: item.url_citation?.url } : undefined)
    .filter((source: { title?: string; uri?: string } | undefined): source is { title: string; uri: string } => Boolean(source?.title && source.uri))
    .filter((source: { uri: string }, index: number, all: { uri: string }[]) => all.findIndex((item) => item.uri === source.uri) === index)
    .slice(0, 3);
  const text = removeEmoji(sources.length ? `${generatedText}\n\nแหล่งข้อมูล:\n${sources.map((source: { title: string; uri: string }) => `- ${source.title}: ${source.uri}`).join("\n")}` : generatedText);
  if (!text) return NextResponse.json({ error: "Chat provider returned no text" }, { status: 502 });

  // A new-chat greeting is ephemeral. It must not change relationship state,
  // write a cloud message, or extract a memory before the user speaks.
  if (greeting) return NextResponse.json({ text: text.slice(0, 320) });

  const nextState = applyConversationTurn(state, lastUserText, text, idle);
  nextState.conversationSummary = state.conversationSummary;

  let historySaved = false;
  if (!passive && body.conversationId && body.userMessageId && body.assistantMessageId) {
    try {
      const timestamp = new Date().toISOString();
      const originalUserText = [...inputMessages].reverse().find((item) => item.role === "user")?.content ?? lastUserText;
      await withTimeout(saveHistory(getSupabaseAdmin(AbortSignal.timeout(supabaseTimeoutMs)), {
        id: body.conversationId, title: typeof body.conversationTitle === "string" && body.conversationTitle.trim() ? body.conversationTitle.trim().slice(0, 80) : originalUserText.slice(0, 42) || "Daily Talk",
        create: body.conversationCreate === true,
        messages: [
          { id: body.userMessageId, from: "me", text: originalUserText.slice(0, 16000), timestamp },
          { id: body.assistantMessageId, from: "vivian", text: text.slice(0, 16000), timestamp },
        ],
      }), supabaseTimeoutMs, "chat history save");
      historySaved = true;
    } catch { console.warn("Chat history unavailable", { code: "HISTORY_UNAVAILABLE" }); }
  }

  after(async () => {
    try {
      const supabase = getSupabaseAdmin();
      if (!body.conversationId) {
        let { data: conversation } = await withTimeout(supabase.from("conversations").select("id").eq("user_key", userKey).limit(1).maybeSingle(), supabaseTimeoutMs, "conversation load");
        if (!conversation) {
          const created = await withTimeout(supabase.from("conversations").insert({ user_key: userKey, title: "Vivian conversation" }).select("id").single(), supabaseTimeoutMs, "conversation create");
          conversation = created.data;
        }
        if (conversation?.id) {
          const rows = (idle || visionIdle)
            ? [{ conversation_id: conversation.id, role: "assistant" as const, content: text }]
            : [{ conversation_id: conversation.id, role: "user" as const, content: lastUserText }, { conversation_id: conversation.id, role: "assistant" as const, content: text }];
          await withTimeout(supabase.from("messages").insert(rows), supabaseTimeoutMs, "message insert");
          await withTimeout(supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation.id), supabaseTimeoutMs, "conversation update");
        }
      }
      const newMemories = !idle && !visionIdle && groqApiKey && memoryIntent.test(lastUserText) ? await extractMemories(groqApiKey, lastUserText) : [];
      if (newMemories.length) {
        await withTimeout(supabase.from("memories").upsert(newMemories.map((item) => ({ user_key: userKey, memory: item.memory.trim(), category: item.category, importance: Math.min(5, Math.max(1, item.importance ?? 3)), updated_at: new Date().toISOString(), last_used_at: new Date().toISOString() })), { onConflict: "user_key,memory" }), supabaseTimeoutMs, "memory upsert");
      }
      if (!idle && !visionIdle && memories.length) {
        const used = memories.slice(0, 8).map((item) => item.id).filter((id): id is number => typeof id === "number");
        if (used.length) await withTimeout(supabase.from("memories").update({ last_used_at: new Date().toISOString() }).eq("user_key", userKey).in("id", used), supabaseTimeoutMs, "memory usage update");
      }
      if (!idle && !visionIdle && older.length >= 4) {
        if (groqApiKey) nextState.conversationSummary = await compressTurns(groqApiKey, older, state.conversationSummary);
      }
      await saveCompanionState(userKey, nextState);
    } catch (error) { console.warn("Persistence unavailable", error); }
  });
  const scene = await executeSceneDecision(sceneContext, plan.scene).catch(() => ({ change: false as const }));
  return NextResponse.json({
    scene,
    text,
    historySaved,
    searchedWeb: shouldSearch,
    tools: toolResults.map((item) => item.name),
    companion: nextState,
    memories,
  });
}
