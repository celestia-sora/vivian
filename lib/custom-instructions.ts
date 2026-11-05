export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 2000;

export function validCustomInstructions(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= MAX_CUSTOM_INSTRUCTIONS_LENGTH;
}

export function normalizeCustomInstructions(value: string): string {
  return value.trim().slice(0, MAX_CUSTOM_INSTRUCTIONS_LENGTH);
}
