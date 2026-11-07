export const SAVED_EXPRESSION_STACK_NAME = "__VivianSavedExpressionStack__";
export const SAVED_EXPRESSION_STACK_FILE = "__vivian_saved_expression_stack__.exp3.json";

export interface ExpressionDefinition { Name: string; File: string }
export interface ExpressionParameter { Id: string; Value: number; Blend?: "Add" | "Multiply" | "Overwrite" }

export async function loadExpressionParameterSets(
  definitions: readonly ExpressionDefinition[],
  resolve: (reference: string) => string,
): Promise<Map<string, ExpressionParameter[]>> {
  const result = new Map<string, ExpressionParameter[]>();
  for (let offset = 0; offset < definitions.length; offset += 32) {
    const loaded = await Promise.all(definitions.slice(offset, offset + 32).map(async (definition) => {
      try {
        const response = await fetch(resolve(definition.File));
        if (!response.ok) return null;
        const expression = await response.json() as { Type?: unknown; Parameters?: unknown };
        if (expression.Type !== "Live2D Expression" || !Array.isArray(expression.Parameters)) return null;
        const parameters: ExpressionParameter[] = [];
        for (const parameter of expression.Parameters) {
          if (!parameter || typeof parameter !== "object") return null;
          const item = parameter as Record<string, unknown>;
          if (typeof item.Id !== "string" || !item.Id || typeof item.Value !== "number" || !Number.isFinite(item.Value)
            || (item.Blend !== undefined && !["Add", "Multiply", "Overwrite"].includes(String(item.Blend)))) return null;
          parameters.push({ Id: item.Id, Value: item.Value, ...(item.Blend ? { Blend: item.Blend as ExpressionParameter["Blend"] } : {}) });
        }
        return [definition.Name, parameters] as const;
      } catch {
        return null;
      }
    }));
    for (const entry of loaded) if (entry) result.set(entry[0], entry[1]);
  }
  return result;
}

export function createExpressionStack(parameterSets: ReadonlyMap<string, readonly ExpressionParameter[]>, names: readonly string[]): Blob | null {
  const selected = [...new Set(names)];
  if (!selected.length || selected.some((name) => !parameterSets.has(name))) return null;
  const parameters = selected.flatMap((name) => parameterSets.get(name) ?? []);
  return new Blob([JSON.stringify({ Type: "Live2D Expression", Parameters: parameters })], { type: "application/json" });
}
