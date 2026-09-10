import type { SchemaObject } from './types.js';

export interface SchemaFailure {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeOf(value) === 'object';
    case 'null':
      return value === null;
    default:
      return true; // unknown/unsupported type keyword — don't fail on it
  }
}

/**
 * Validate a JSON value against the subset of JSON Schema our SchemaObject
 * type models (type, properties, required, enum, items). Not a full
 * JSON-Schema implementation — intentionally scoped to what OpenAPI
 * response schemas typically use.
 */
export function validateAgainstSchema(
  schema: SchemaObject | undefined,
  value: unknown,
  path = '$'
): SchemaFailure[] {
  if (!schema) return [];
  const failures: SchemaFailure[] = [];

  if (schema.type && !matchesType(value, schema.type)) {
    failures.push({
      path,
      message: `expected type "${schema.type}" but got "${typeOf(value)}"`,
    });
    return failures; // further checks on a mis-typed value aren't meaningful
  }

  if (schema.enum && !schema.enum.some((v) => String(v) === String(value))) {
    failures.push({
      path,
      message: `value "${String(value)}" is not one of the allowed enum values`,
    });
  }

  const effectiveType = schema.type ?? (schema.properties ? 'object' : undefined);

  if (effectiveType === 'object' && typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const requiredProp of schema.required ?? []) {
      if (!(requiredProp in obj)) {
        failures.push({
          path: `${path}.${requiredProp}`,
          message: 'required field is missing',
        });
      }
    }
    for (const [propName, propSchema] of Object.entries(schema.properties ?? {})) {
      if (propName in obj) {
        failures.push(...validateAgainstSchema(propSchema, obj[propName], `${path}.${propName}`));
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      failures.push(...validateAgainstSchema(schema.items, item, `${path}[${i}]`));
    });
  }

  return failures;
}
