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
  shy: { label: "Shy", description: "เก็บอาการและสุขุมขึ้น โดยยังคงความหวงแหนแบบ yandere" },
  playful: { label: "Playful", description: "ขี้เล่นขึ้น แต่ยังคงความผูกติดแบบ yandere" },
  elegant: { label: "Elegant", description: "สุขุมและวางท่าที โดยยังคงบุคลิก yandere" },
  custom: { label: "Custom", description: "น้ำเสียง yandere แบบตรงและเย็นชา" },
} as const;

export type PersonalityKey = keyof typeof PERSONALITIES;

export function isModelKey(value: string | null): value is ModelKey {
  return value === "Miss";
}

export function isPersonalityKey(value: string | null): value is PersonalityKey {
  return value === "shy" || value === "playful" || value === "elegant" || value === "custom";
}
