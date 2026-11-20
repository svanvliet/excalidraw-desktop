/**
 * Minimal JSON Schema validator for extension `paramsSchema`s. Supports the subset extensions
 * use (type, enum, const, minimum/maximum, properties/required/additionalProperties, items,
 * oneOf/anyOf) so params coming from the agent are checked before an extension sees them.
 */
type Schema = Record<string, unknown>;

function typeOk(type: unknown, v: unknown): boolean {
  switch (type) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return true;
  }
}

/** Returns the first validation error ("params.shape must be one of …"), or null. */
export function validateSchema(schema: Schema, value: unknown, path = "params"): string | null {
  const alts = (schema.oneOf ?? schema.anyOf) as Schema[] | undefined;
  if (Array.isArray(alts)) {
    const errors = alts.map((s) => validateSchema(s, value, path));
    if (!errors.some((e) => e === null)) return errors[0] ?? `${path} is invalid`;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) return `${path} must be ${types.join(" or ")}`;
  }
  if ("const" in schema && value !== schema.const) {
    return `${path} must be ${JSON.stringify(schema.const)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}`;
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (const [i, item] of value.entries()) {
      const err = validateSchema(schema.items as Schema, item, `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (typeOk("object", value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj)) return `${path}.${key} is required`;
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) {
        const err = validateSchema(props[key], v, `${path}.${key}`);
        if (err) return err;
      } else if (schema.additionalProperties === false) {
        return `${path}.${key} is not allowed (allowed: ${Object.keys(props).join(", ") || "none"})`;
      }
    }
  }
  return null;
}
