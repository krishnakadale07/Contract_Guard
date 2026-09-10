import { lookup as dnsLookup } from 'node:dns/promises';
import type { OpenAPISpec, Operation, ParameterObject } from './types.js';
import { validateAgainstSchema } from './schema-validate.js';
import { redactText } from './redact.js';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface RuntimeTestResult {
  operation: string; // "GET /users/{id}"
  url: string;
  status: TestStatus;
  httpStatus?: number;
  durationMs: number;
  failures: string[]; // human-readable reasons, empty when passed
}

export interface RuntimeTestSummary {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface RuntimeTestOptions {
  baseUrl: string;
  timeoutMs?: number;
  concurrency?: number;
  /** Request headers are accepted but never included in results or reports. */
  headers?: Record<string, string>;
  /** Known values that must be removed from unexpected network error messages. */
  redactValues?: string[];
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONCURRENCY = 4;

// --- Egress guard (NOT a full SSRF guard) --------------------------------
// This blocks link-local / cloud-metadata addresses (169.254.0.0/16, most
// commonly 169.254.169.254 — the AWS/GCP/Azure/DigitalOcean metadata IP) by
// resolving the hostname and checking the *resolved* address, so a DNS
// rebind to that range is caught too, not just a literal IP in the URL.
//
// It does NOT block loopback or other private ranges (10.x, 172.16-31.x,
// 192.168.x) — that's a deliberate scope choice for a CLI where the
// developer supplies --base-url themselves, most often pointing at their
// own local dev server. That also means this is NOT sufficient SSRF
// protection on its own: it must not be reused as-is behind a service that
// accepts an arbitrary base URL from an untrusted caller (e.g. a future
// hosted/web version of ContractGuard) — that would need to also block
// loopback and private ranges, and likely allow-list or authenticate the
// target instead of trusting user input.

function isLinkLocal(ip: string): boolean {
  if (ip.startsWith('169.254.')) return true;
  if (ip === '::1') return false; // loopback, fine
  if (ip.toLowerCase().startsWith('fe80:')) return true; // IPv6 link-local
  return false;
}

async function assertNotBlockedHost(urlStr: string): Promise<void> {
  const url = new URL(urlStr);
  let address: string;
  try {
    const result = await dnsLookup(url.hostname);
    address = result.address;
  } catch {
    // Can't resolve — let the actual request fail with a clearer network error.
    return;
  }
  if (isLinkLocal(address)) {
    throw new Error(
      `Refusing to call ${url.hostname} (resolves to ${address}) — link-local/cloud-metadata addresses are blocked by the egress guard`
    );
  }
}

// --- Safe GET-only operation discovery --------------------------------

interface FlatGetOperation {
  key: string;
  path: string;
  op: Operation;
}

function flattenGetOperations(spec: OpenAPISpec): FlatGetOperation[] {
  const out: FlatGetOperation[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const op = (item as Record<string, unknown>)?.get;
    if (op && typeof op === 'object') {
      out.push({ key: `GET ${path}`, path, op: op as Operation });
    }
  }
  return out;
}

// --- Request building ---------------------------------------------------

function resolveParamValue(param: ParameterObject): unknown {
  if (param.example !== undefined) return param.example;
  if (param.schema?.example !== undefined) return param.schema.example;
  if (param.schema?.default !== undefined) return param.schema.default;
  if (param.schema?.enum && param.schema.enum.length > 0) return param.schema.enum[0];
  return undefined;
}

/**
 * Build a concrete request URL for an operation, or return a skip reason
 * if a required parameter has no example/default value we can safely use.
 */
export function buildRequestUrl(
  baseUrl: string,
  path: string,
  op: Operation
): { url: string } | { skipReason: string } {
  let resolvedPath = path;
  const params = op.parameters ?? [];

  for (const param of params.filter((p) => p.in === 'path')) {
    const value = resolveParamValue(param);
    if (value === undefined) {
      return { skipReason: `no example/default value available for required path parameter "${param.name}"` };
    }
    resolvedPath = resolvedPath.replace(`{${param.name}}`, encodeURIComponent(String(value)));
  }

  if (resolvedPath.includes('{')) {
    return { skipReason: `unresolved path template segment remains in "${resolvedPath}"` };
  }

  const url = new URL(resolvedPath.replace(/^\//, ''), baseUrl.replace(/\/?$/, '/'));

  for (const param of params.filter((p) => p.in === 'query' && p.required)) {
    const value = resolveParamValue(param);
    if (value === undefined) {
      return { skipReason: `no example/default value available for required query parameter "${param.name}"` };
    }
    url.searchParams.set(param.name, String(value));
  }

  return { url: url.toString() };
}

// --- Single-operation execution -----------------------------------------

async function runOne(
  flat: FlatGetOperation,
  baseUrl: string,
  timeoutMs: number,
  headers: Record<string, string>,
  redactValues: string[]
): Promise<RuntimeTestResult> {
  const started = Date.now();
  const built = buildRequestUrl(baseUrl, flat.path, flat.op);

  if ('skipReason' in built) {
    return {
      operation: flat.key,
      url: '',
      status: 'skipped',
      durationMs: 0,
      failures: [built.skipReason],
    };
  }

  const { url } = built;

  try {
    await assertNotBlockedHost(url);
  } catch (err) {
    return {
      operation: flat.key,
      url,
      status: 'skipped',
      durationMs: Date.now() - started,
      failures: [(err as Error).message],
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const durationMs = Date.now() - started;
    const failures: string[] = [];

    const responses = flat.op.responses ?? {};
    const statusKey = String(res.status);
    const expected = responses[statusKey] ?? responses.default;

    if (!expected) {
      failures.push(
        `unexpected HTTP status ${res.status} — spec only documents: ${Object.keys(responses).join(', ') || '(none)'}`
      );
    } else {
      const contentType = res.headers.get('content-type') ?? '';
      const expectedMediaTypes = Object.keys(expected.content ?? {});
      const wantsJson = expectedMediaTypes.some((mt) => mt.includes('json'));

      if (wantsJson) {
        if (!contentType.includes('json')) {
          failures.push(`expected a JSON response (Content-Type "application/json") but got "${contentType || '(none)'}"`);
        } else {
          const schema = expected.content?.['application/json']?.schema;
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            failures.push('response body was not valid JSON');
          }
          if (schema && body !== undefined) {
            const schemaFailures = validateAgainstSchema(schema, body);
            for (const f of schemaFailures) {
              failures.push(`response field "${f.path}" ${f.message}`);
            }
          }
        }
      }
    }

    return {
      operation: flat.key,
      url,
      status: failures.length === 0 ? 'passed' : 'failed',
      httpStatus: res.status,
      durationMs,
      failures,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    const message =
      (err as Error).name === 'AbortError'
        ? `request timed out after ${timeoutMs}ms`
        : `request failed: ${redactText((err as Error).message, redactValues)}`;
    return { operation: flat.key, url, status: 'failed', durationMs, failures: [message] };
  } finally {
    clearTimeout(timer);
  }
}

// --- Bounded-concurrency runner ------------------------------------------

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runNext(): Promise<void> {
    const i = next++;
    if (i >= items.length) return;
    results[i] = await worker(items[i]);
    await runNext();
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

export async function runRuntimeTests(
  spec: OpenAPISpec,
  options: RuntimeTestOptions
): Promise<{ results: RuntimeTestResult[]; summary: RuntimeTestSummary }> {
  const ops = flattenGetOperations(spec);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const headers = options.headers ?? {};
  const redactValues = options.redactValues ?? Object.values(headers);

  const results = await runWithConcurrency(ops, concurrency, (op) =>
    runOne(op, options.baseUrl, timeoutMs, headers, redactValues)
  );

  const summary = results.reduce(
    (acc, r) => {
      acc[r.status]++;
      acc.total++;
      return acc;
    },
    { passed: 0, failed: 0, skipped: 0, total: 0 } as RuntimeTestSummary
  );

  return { results, summary };
}
