import {
  HTTP_METHODS,
  type Finding,
  type HttpMethod,
  type Operation,
  type OpenAPISpec,
  type ParameterObject,
  type ResponseObject,
  type SchemaObject,
  type SecurityRequirement,
} from './types.js';

interface FlatOperation {
  key: string; // "GET /users"
  method: HttpMethod;
  path: string;
  op: Operation;
}

function flattenOperations(spec: OpenAPISpec): Map<string, FlatOperation> {
  const out = new Map<string, FlatOperation>();
  const paths = spec.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (op && typeof op === 'object') {
        const key = `${method.toUpperCase()} ${path}`;
        out.set(key, { key, method, path, op: op as Operation });
      }
    }
  }
  return out;
}

function finding(
  severity: Finding['severity'],
  category: Finding['category'],
  operation: string,
  message: string,
  location: string,
  suggestion: string
): Finding {
  return { severity, category, operation, message, location, suggestion };
}

function is2xx(status: string): boolean {
  return /^2\d\d$/.test(status);
}

export function diffSpecs(oldSpec: OpenAPISpec, newSpec: OpenAPISpec): Finding[] {
  const findings: Finding[] = [];
  const oldOps = flattenOperations(oldSpec);
  const newOps = flattenOperations(newSpec);

  // --- Endpoint / method level ---
  for (const [key, oldFlat] of oldOps) {
    const newFlat = newOps.get(key);
    if (!newFlat) {
      findings.push(
        finding(
          'breaking',
          'endpoint',
          key,
          `Operation "${key}" was removed`,
          key,
          'Deprecate the operation for at least one version before removing it, or introduce a new API version.'
        )
      );
      continue;
    }
    findings.push(...compareOperation(key, oldFlat.op, newFlat.op));
  }

  for (const [key] of newOps) {
    if (!oldOps.has(key)) {
      findings.push(
        finding(
          'info',
          'endpoint',
          key,
          `New operation "${key}" was added`,
          key,
          'No action needed — additive change.'
        )
      );
    }
  }

  // --- Global security (top-level `security`) ---
  findings.push(
    ...compareSecurity(
      'API-wide',
      oldSpec.security,
      newSpec.security,
      'security (top-level)'
    )
  );

  return findings;
}

function compareOperation(opKey: string, oldOp: Operation, newOp: Operation): Finding[] {
  const findings: Finding[] = [];

  findings.push(...compareParameters(opKey, oldOp.parameters ?? [], newOp.parameters ?? []));
  findings.push(...compareResponses(opKey, oldOp.responses ?? {}, newOp.responses ?? {}));

  if (oldOp.security || newOp.security) {
    findings.push(
      ...compareSecurity(opKey, oldOp.security, newOp.security, `${opKey} → security`)
    );
  }

  return findings;
}

function compareParameters(
  opKey: string,
  oldParams: ParameterObject[],
  newParams: ParameterObject[]
): Finding[] {
  const findings: Finding[] = [];
  const oldByKey = new Map(oldParams.map((p) => [`${p.in}:${p.name}`, p]));
  const newByKey = new Map(newParams.map((p) => [`${p.in}:${p.name}`, p]));

  for (const [key, newParam] of newByKey) {
    const oldParam = oldByKey.get(key);
    const loc = `${opKey} → parameter "${newParam.name}" (${newParam.in})`;

    if (!oldParam) {
      if (newParam.required) {
        findings.push(
          finding(
            'breaking',
            'request',
            opKey,
            `New required parameter "${newParam.name}" was added`,
            loc,
            'Add the parameter as optional first, then require it in a later major version.'
          )
        );
      } else {
        findings.push(
          finding(
            'info',
            'request',
            opKey,
            `New optional parameter "${newParam.name}" was added`,
            loc,
            'No action needed — additive change.'
          )
        );
      }
      continue;
    }

    if (!oldParam.required && newParam.required) {
      findings.push(
        finding(
          'breaking',
          'request',
          opKey,
          `Parameter "${newParam.name}" changed from optional to required`,
          loc,
          'Keep the parameter optional, or version the endpoint before requiring it.'
        )
      );
    }

    const oldType = oldParam.schema?.type;
    const newType = newParam.schema?.type;
    if (oldType && newType && oldType !== newType) {
      findings.push(
        finding(
          'breaking',
          'request',
          opKey,
          `Parameter "${newParam.name}" type changed from "${oldType}" to "${newType}"`,
          loc,
          'Introduce a new parameter name instead of changing the type of an existing one.'
        )
      );
    }

    const removedEnums = diffEnumRemoved(oldParam.schema?.enum, newParam.schema?.enum);
    if (removedEnums.length > 0) {
      findings.push(
        finding(
          'breaking',
          'request',
          opKey,
          `Parameter "${newParam.name}" removed accepted value(s): ${removedEnums.join(', ')}`,
          loc,
          'Clients may still send removed enum values — keep accepting them or version the endpoint.'
        )
      );
    }
  }

  for (const [key, oldParam] of oldByKey) {
    if (!newByKey.has(key)) {
      findings.push(
        finding(
          'breaking',
          'request',
          opKey,
          `Parameter "${oldParam.name}" (${oldParam.in}) was removed`,
          `${opKey} → parameter "${oldParam.name}" (${oldParam.in})`,
          'Removing a parameter can break clients that still send it under strict validation — deprecate first.'
        )
      );
    }
  }

  return findings;
}

function compareResponses(
  opKey: string,
  oldResponses: Record<string, ResponseObject>,
  newResponses: Record<string, ResponseObject>
): Finding[] {
  const findings: Finding[] = [];

  for (const [status, oldResp] of Object.entries(oldResponses)) {
    const newResp = newResponses[status];
    const loc = `${opKey} → ${status} response`;

    if (!newResp) {
      findings.push(
        finding(
          is2xx(status) ? 'breaking' : 'warning',
          'response',
          opKey,
          `Response status "${status}" was removed`,
          loc,
          is2xx(status)
            ? 'Clients rely on documented success statuses — keep it or version the endpoint.'
            : 'Removing a documented error status is usually safe but confirm no client branches on it.'
        )
      );
      continue;
    }

    const oldSchema = firstJsonSchema(oldResp);
    const newSchema = firstJsonSchema(newResp);
    if (oldSchema || newSchema) {
      findings.push(...compareSchema(opKey, loc, oldSchema, newSchema));
    }
  }

  for (const [status] of Object.entries(newResponses)) {
    if (!oldResponses[status]) {
      findings.push(
        finding(
          'info',
          'response',
          opKey,
          `New response status "${status}" was added`,
          `${opKey} → ${status} response`,
          'No action needed — additive change.'
        )
      );
    }
  }

  return findings;
}

function firstJsonSchema(resp: ResponseObject): SchemaObject | undefined {
  const content = resp.content ?? {};
  const json = content['application/json'];
  if (json?.schema) return json.schema;
  const firstKey = Object.keys(content)[0];
  return firstKey ? content[firstKey].schema : undefined;
}

function compareSchema(
  opKey: string,
  baseLoc: string,
  oldSchema: SchemaObject | undefined,
  newSchema: SchemaObject | undefined,
  path: string[] = []
): Finding[] {
  const findings: Finding[] = [];
  if (!oldSchema || !newSchema) return findings;
  const loc = path.length ? `${baseLoc} → schema.${path.join('.')}` : `${baseLoc} → schema`;

  if (oldSchema.type && newSchema.type && oldSchema.type !== newSchema.type) {
    findings.push(
      finding(
        'breaking',
        'response',
        opKey,
        `Field type changed from "${oldSchema.type}" to "${newSchema.type}"`,
        loc,
        'Type changes break clients that deserialize the response strictly — add a new field instead.'
      )
    );
  }

  const removedEnums = diffEnumRemoved(oldSchema.enum, newSchema.enum);
  if (removedEnums.length > 0) {
    findings.push(
      finding(
        'breaking',
        'response',
        opKey,
        `Removed possible value(s) from enum: ${removedEnums.join(', ')}`,
        loc,
        'Clients may match on removed enum values — keep them or version the schema.'
      )
    );
  }

  // Arrays: recurse into the item schema under a synthetic "[]" path segment
  // so nested object changes inside list items are still detected.
  if (oldSchema.items || newSchema.items) {
    findings.push(...compareSchema(opKey, baseLoc, oldSchema.items, newSchema.items, [...path, '[]']));
  }

  const oldProps = oldSchema.properties ?? {};
  const newProps = newSchema.properties ?? {};
  const oldRequired = new Set(oldSchema.required ?? []);
  const newRequired = new Set(newSchema.required ?? []);

  for (const [propName, oldProp] of Object.entries(oldProps)) {
    const newProp = newProps[propName];
    const propPath = [...path, propName];
    if (!newProp) {
      findings.push(
        finding(
          'breaking',
          'response',
          opKey,
          `Response property "${propName}" was removed`,
          `${baseLoc} → schema.${propPath.join('.')}`,
          'Clients reading this field will break — keep it or version the endpoint.'
        )
      );
      continue;
    }
    if (!oldRequired.has(propName) && newRequired.has(propName)) {
      findings.push(
        finding(
          'breaking',
          'response',
          opKey,
          `Response property "${propName}" became required`,
          `${baseLoc} → schema.${propPath.join('.')}`,
          'A newly-required response field can be fine (server always sets it now), but flag it for review since strict client validators may still reject older cached responses.'
        )
      );
    }
    findings.push(...compareSchema(opKey, baseLoc, oldProp, newProp, propPath));
  }

  for (const [propName, newProp] of Object.entries(newProps)) {
    if (!oldProps[propName]) {
      findings.push(
        finding(
          'info',
          'response',
          opKey,
          `New response property "${propName}" was added${
            newRequired.has(propName) ? ' (required)' : ''
          }`,
          `${baseLoc} → schema.${[...path, propName].join('.')}`,
          newRequired.has(propName)
            ? 'A new required response field is technically additive for JSON consumers, but confirm downstream schema validators allow unknown-then-required fields.'
            : 'No action needed — additive change.'
        )
      );
    }
  }

  return findings;
}

function diffEnumRemoved(oldEnum?: unknown[], newEnum?: unknown[]): string[] {
  if (!oldEnum || !newEnum) return [];
  const newSet = new Set(newEnum.map(String));
  return oldEnum.filter((v) => !newSet.has(String(v))).map(String);
}

function compareSecurity(
  opKey: string,
  oldSec: SecurityRequirement[] | undefined,
  newSec: SecurityRequirement[] | undefined,
  loc: string
): Finding[] {
  const findings: Finding[] = [];
  const hadNone = !oldSec || oldSec.length === 0;
  const hasNone = !newSec || newSec.length === 0;

  if (hadNone && !hasNone) {
    findings.push(
      finding(
        'breaking',
        'security',
        opKey,
        'Authentication is now required where it previously was not',
        loc,
        'Existing unauthenticated clients will start failing — announce and version this change.'
      )
    );
  } else if (!hadNone && !hasNone) {
    const oldSchemes = new Set(oldSec!.flatMap((r) => Object.keys(r)));
    const newSchemes = new Set(newSec!.flatMap((r) => Object.keys(r)));
    const added = [...newSchemes].filter((s) => !oldSchemes.has(s));
    if (added.length > 0 && newSchemes.size >= oldSchemes.size) {
      // A stricter posture: existing scheme(s) still required AND new one(s) added
      const stillRequiresOld = [...oldSchemes].every((s) => newSchemes.has(s));
      if (stillRequiresOld) {
        findings.push(
          finding(
            'breaking',
            'security',
            opKey,
            `Additional authentication scheme(s) now required: ${added.join(', ')}`,
            loc,
            'Clients authenticating only with the old scheme will be rejected — phase this in gradually.'
          )
        );
      }
    }
  }

  return findings;
}
