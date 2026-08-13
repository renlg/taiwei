export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface OpenAIToolSchema {
  type: 'function';
  function: ToolDefinition;
}

export function toOpenAITool(definition: ToolDefinition): OpenAIToolSchema {
  return { type: 'function', function: definition };
}
