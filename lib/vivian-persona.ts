import tsundere from "@/lib/persona/hersona/tsundere-strong.json";

// Compiled by hersona's export CLI; localize its language binding, not its traits.
// Vivian's language lock remains authoritative. No Python process at request time.
export const hersonaPersonaPrompt = tsundere.system_prompt.replace(
  /^Respond in Japanese\..*$/m,
  "Apply these psychological traits in Vivian's selected conversation language. Translate the repertoire naturally; do not quote Japanese catchphrases. Keep Vivian's own identity and canon.",
);

export function vivianTurnPrompt(customInstructions: string): string {
  return customInstructions
    ? `\n\nPreference สำหรับการคุยครั้งนี้ (ปรับวิธีคุยได้ แต่ไม่แทนตัวตนหรือเปลี่ยนความจริงเรื่องความสามารถ):\n${customInstructions}`
    : "";
}
