import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runRuntimeTests, buildRequestUrl } from '../src/core/runtime.js';
import type { OpenAPISpec } from '../src/core/types.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: '1', email: 'a@b.com' }));
    } else if (req.url === '/missing-field') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: '1' })); // email is required by the spec below
    } else if (req.url === '/wrong-status') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    } else if (req.url?.startsWith('/items/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: req.url.split('/')[2] }));
    } else if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: '1' }));
      }, 200);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

function specWith(paths: OpenAPISpec['paths']): OpenAPISpec {
  return { openapi: '3.0.3', info: { title: 't', version: '1' }, paths };
}

describe('buildRequestUrl', () => {
  it('resolves a path param from an example', () => {
    const result = buildRequestUrl('http://x/', '/items/{id}', {
      parameters: [{ name: 'id', in: 'path', required: true, example: 42 }],
    } as any);
    expect(result).toEqual({ url: 'http://x/items/42' });
  });

  it('skips when a required path param has no example', () => {
    const result = buildRequestUrl('http://x/', '/items/{id}', {
      parameters: [{ name: 'id', in: 'path', required: true }],
    } as any);
    expect('skipReason' in result).toBe(true);
  });
});

describe('runRuntimeTests', () => {
  it('passes an endpoint whose response matches the schema', async () => {
    const spec = specWith({
      '/ok': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'email'],
                    properties: { id: { type: 'string' }, email: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const { results, summary } = await runRuntimeTests(spec, { baseUrl });
    expect(summary).toEqual({ passed: 1, failed: 0, skipped: 0, total: 1 });
    expect(results[0].status).toBe('passed');
  });

  it('fails an endpoint missing a required response field', async () => {
    const spec = specWith({
      '/missing-field': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'email'],
                    properties: { id: { type: 'string' }, email: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const { results, summary } = await runRuntimeTests(spec, { baseUrl });
    expect(summary.failed).toBe(1);
    expect(results[0].failures[0]).toContain('response field "$.email"');
  });

  it('fails an endpoint that returns an undocumented status', async () => {
    const spec = specWith({
      '/wrong-status': { get: { responses: { '200': { content: {} } } } },
    });
    const { results, summary } = await runRuntimeTests(spec, { baseUrl });
    expect(summary.failed).toBe(1);
    expect(results[0].failures[0]).toContain('unexpected HTTP status 500');
  });

  it('skips an operation whose required path param has no example', async () => {
    const spec = specWith({
      '/items/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true }],
          responses: { '200': { content: {} } },
        },
      },
    });
    const { results, summary } = await runRuntimeTests(spec, { baseUrl });
    expect(summary.skipped).toBe(1);
    expect(results[0].status).toBe('skipped');
  });

  it('resolves and passes a path param supplied via example', async () => {
    const spec = specWith({
      '/items/{id}': {
        get: {
          parameters: [{ name: 'id', in: 'path', required: true, example: '7' }],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    });
    const { results, summary } = await runRuntimeTests(spec, { baseUrl });
    expect(summary.passed).toBe(1);
    expect(results[0].url).toBe(`${baseUrl}/items/7`);
  });

  it('times out slow requests', async () => {
    const spec = specWith({ '/slow': { get: { responses: { '200': { content: {} } } } } });
    const { results, summary } = await runRuntimeTests(spec, { baseUrl, timeoutMs: 50 });
    expect(summary.failed).toBe(1);
    expect(results[0].failures[0]).toContain('timed out');
  });

  it('never calls non-GET methods (only GET operations are collected)', async () => {
    const spec = specWith({
      '/ok': {
        get: { responses: { '200': { content: {} } } },
        post: { responses: { '201': { content: {} } } },
      },
    });
    const { results } = await runRuntimeTests(spec, { baseUrl });
    expect(results).toHaveLength(1);
    expect(results[0].operation).toBe('GET /ok');
  });
});
