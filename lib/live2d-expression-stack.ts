export const SAVED_EXPRESSION_STACK_NAME = "__VivianSavedExpressionStack__";
export const SAVED_EXPRESSION_STACK_FILE = "__vivian_saved_expression_stack__.exp3.json";

interface ExpressionDefinition { Name: string; File: string }
interface ExpressionParameter { Id: string; Value: number; Blend?: "Add" | "Multiply" | "Overwrite" }

export async function createSavedExpressionStack(
  definitions: readonly ExpressionDefinition[],
  selected: readonly string[],
  resolve: (reference: string) => string,
): Promise<Blob | null> {
  const selectedNames = new Set(selected);
  const files = definitions.filter((definition) => selectedNames.has(definition.Name));
  if (!files.length) return null;
  const parameters: ExpressionParameter[] = [];
  for (const definition of files) {
    const response = await fetch(resolve(definition.File));
    if (!response.ok) throw new Error(`Could not load expression: ${definition.Name}`);
    const expression = await response.json() as { Type?: unknown; Parameters?: unknown };
    if (expression.Type !== "Live2D Expression" || !Array.isArray(expression.Parameters)) throw new Error(`Invalid expression: ${definition.Name}`);
    for (const parameter of expression.Parameters) {
      if (!parameter || typeof parameter !== "object") throw new Error(`Invalid expression: ${definition.Name}`);
      const item = parameter as Record<string, unknown>;
      if (typeof item.Id !== "string" || !item.Id || typeof item.Value !== "number" || !Number.isFinite(item.Value)
        || (item.Blend !== undefined && !["Add", "Multiply", "Overwrite"].includes(String(item.Blend)))) {
        throw new Error(`Invalid expression parameter: ${definition.Name}`);
      }
      parameters.push({ Id: item.Id, Value: item.Value, ...(item.Blend ? { Blend: item.Blend as ExpressionParameter["Blend"] } : {}) });
    }
  }
  return new Blob([JSON.stringify({ Type: "Live2D Expression", Parameters: parameters })], { type: "application/json" });
}
