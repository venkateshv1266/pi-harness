/**
 * JSON-Schema → Typebox converter for MCP tool input schemas.
 *
 * MCP tools declare inputs as JSON-Schema. pi's registerTool wants a typebox
 * schema. We convert the common subset. Anything exotic ($ref/oneOf/anyOf/
 * allOf) degrades to Type.Any so the tool still registers and the model can
 * pass best-effort args.
 *
 * Security: a depth limit prevents stack overflow from maliciously nested
 * schemas. String enums use StringEnum (Google-compatible).
 */
import { Type, type TSchema, type TObject } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

type JsonSchema = { [k: string]: unknown };

function isSchema(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Convert a single JSON-Schema node to a typebox schema. */
function convert(node: JsonSchema, depth: number, maxDepth: number): TSchema {
  if (!isSchema(node)) return Type.Unknown();
  if (node["$ref"] || node["oneOf"] || node["anyOf"] || node["allOf"]) {
    return Type.Unknown();
  }
  if (depth > maxDepth) {
    return Type.Unknown();
  }

  const desc =
    typeof node["description"] === "string" ? (node["description"] as string) : undefined;

  const enumVals = node["enum"];
  if (Array.isArray(enumVals) && enumVals.every((v) => typeof v === "string")) {
    return StringEnum(enumVals as unknown as [string, ...string[]], { description: desc }) as TSchema;
  }

  switch (node["type"]) {
    case "string":
      return Type.String({ description: desc });
    case "integer":
    case "number":
      return Type.Number({ description: desc });
    case "boolean":
      return Type.Boolean({ description: desc });
    case "array": {
      const items = node["items"];
      const itemSchema = isSchema(items) ? convert(items, depth + 1, maxDepth) : Type.Unknown();
      return Type.Array(itemSchema, { description: desc });
    }
    case "object":
      return convertObject(node, desc, depth, maxDepth);
    case "null":
      return Type.Null({ description: desc });
    default:
      return Type.Unknown({ description: desc });
  }
}

/** Convert a JSON-Schema object node into a typebox Type.Object. */
function convertObject(
  node: JsonSchema,
  desc: string | undefined,
  depth: number,
  maxDepth: number
): TObject {
  const props = isSchema(node["properties"])
    ? (node["properties"] as Record<string, JsonSchema>)
    : {};
  const required = Array.isArray(node["required"]) ? (node["required"] as string[]) : [];
  const out: Record<string, TSchema> = {};
  for (const [k, v] of Object.entries(props)) {
    const s = convert(v, depth + 1, maxDepth);
    out[k] = required.includes(k) ? s : Type.Optional(s);
  }
  return Type.Object(out, { description: desc, additionalProperties: true });
}

/**
 * Convert an MCP tool inputSchema (always an object schema at top level) to a
 * typebox Type.Object. Falls back to a permissive empty object schema.
 *
 * @param inputSchema - The MCP tool's inputSchema (JSON-Schema object).
 * @param maxDepth - Maximum nesting depth before degrading to Type.Any
 *                   (default 32, prevents stack overflow from nested schemas).
 */
export function convertInputSchema(inputSchema: unknown, maxDepth = 32): TObject {
  if (!isSchema(inputSchema) || inputSchema["type"] !== "object") {
    return Type.Object({}, { additionalProperties: true });
  }
  return convertObject(inputSchema, undefined, 0, maxDepth);
}
