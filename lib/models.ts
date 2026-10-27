export type ModelKey = "Miss";

export const MODEL_CONFIG: Record<ModelKey, {
  reading: string;
  path: string;
  expressions: string[];
  background: string;
}> = {
  "Miss": { reading: "Miss", path: "/live2d/Miss/Miss.model3.json", expressions: ["#", "M ###", "M ##", "M QAQ", "M lianhong", "M love", "M miyan", "M nu", "M wenhao", "M xingxing", "M xingxing2", "S chabei", "S shouji", "T faxing", "X shetou"], background: "witch-bg" },
};

export const PERSONALITIES = {
  shy: { label: "Quiet", description: "ขี้อาย สุภาพ และเก็บอาการมากขึ้น" },
  playful: { label: "Playful", description: "ขี้เล่นและแอบเขินได้ง่ายขึ้น" },
  elegant: { label: "Elegant", description: "สุขุม สุภาพ และรักษาท่าที" },
  custom: { label: "Custom", description: "น้ำเสียงปากแข็งแบบ tsundere ในระดับที่กำหนดเอง" },
} as const;

export type PersonalityKey = keyof typeof PERSONALITIES;

export function isModelKey(value: string | null): value is ModelKey {
  return value === "Miss";
}

export function isPersonalityKey(value: string | null): value is PersonalityKey {
  return value === "shy" || value === "playful" || value === "elegant" || value === "custom";
}
