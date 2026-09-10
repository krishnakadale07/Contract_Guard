import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import yaml from 'js-yaml';
import type { OpenAPISpec } from './types.js';

export class SpecValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`Invalid OpenAPI spec:\n- ${issues.join('\n- ')}`);
    this.issues = issues;
    this.name = 'SpecValidationError';
  }
}

/**
 * Load a YAML or JSON OpenAPI file from disk.
 */
export function loadSpecFile(filePath: string): OpenAPISpec {
  const raw = readFileSync(filePath, 'utf8');
  return parseSpecString(raw, extname(filePath));
}

export function parseSpecString(raw: string, ext: string): OpenAPISpec {
  let doc: unknown;
  if (ext === '.json') {
    doc = JSON.parse(raw);
  } else {
    // .yaml / .yml, and also fall back to YAML for unknown extensions
    // (YAML is a superset of JSON, so this also handles .json content).
    doc = yaml.load(raw);
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new SpecValidationError(['File did not parse to an object']);
  }
  return doc as OpenAPISpec;
}

/**
 * Minimal structural validation — enough to catch obviously broken specs
 * without pulling in a full JSON-Schema validator for the OpenAPI meta-schema.
 */
export function validateSpec(spec: OpenAPISpec): string[] {
  const issues: string[] = [];

  if (!spec.openapi || typeof spec.openapi !== 'string') {
    issues.push('Missing or invalid "openapi" version field');
  } else if (!/^3\.(0|1)\.\d+$/.test(spec.openapi)) {
    issues.push(
      `Unsupported OpenAPI version "${spec.openapi}" (only 3.0.x and 3.1.x are supported in this MVP)`
    );
  }

  if (!spec.info || typeof spec.info !== 'object') {
    issues.push('Missing "info" object');
  } else {
    if (!spec.info.title) issues.push('Missing "info.title"');
    if (!spec.info.version) issues.push('Missing "info.version"');
  }

  if (!spec.paths || typeof spec.paths !== 'object') {
    issues.push('Missing "paths" object');
  } else if (Object.keys(spec.paths).length === 0) {
    issues.push('"paths" is empty — nothing to test or diff');
  }

  return issues;
}

/**
 * Resolve local `#/components/...` $ref pointers in place, returning a new
 * deep-cloned, fully-resolved spec. Only local refs are supported (no
 * external file or URL refs) — that's a deliberate MVP scope limit.
 */
export function resolveLocalRefs(spec: OpenAPISpec): OpenAPISpec {
  const root = spec as Record<string, unknown>;
  const seen = new WeakSet<object>();

  function resolvePointer(ref: string): unknown {
    if (!ref.startsWith('#/')) {
      throw new SpecValidationError([
        `External or remote $ref "${ref}" is not supported in this MVP — inline it or split diffing per-file`,
      ]);
    }
    const parts = ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let node: unknown = root;
    for (const part of parts) {
      if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[part];
      } else {
        throw new SpecValidationError([`Could not resolve $ref "${ref}"`]);
      }
    }
    return node;
  }

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node && typeof node === 'object') {
      if (seen.has(node)) return node; // avoid infinite recursion on cycles
      seen.add(node);
      const obj = node as Record<string, unknown>;
      if (typeof obj.$ref === 'string') {
        const resolved = resolvePointer(obj.$ref);
        return walk(resolved);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  }

  return walk(JSON.parse(JSON.stringify(spec))) as OpenAPISpec;
}

export function loadAndResolveSpec(filePath: string): OpenAPISpec {
  const spec = loadSpecFile(filePath);
  const issues = validateSpec(spec);
  if (issues.length > 0) {
    throw new SpecValidationError(issues);
  }
  return resolveLocalRefs(spec);
}
