import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../src/core/diff.js';
import type { OpenAPISpec, Finding } from '../src/core/types.js';

function base(overrides: Partial<OpenAPISpec> = {}): OpenAPISpec {
  return {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/things': {
        get: {
          parameters: [
            { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    ...overrides,
  };
}

function findBy(findings: Finding[], substring: string) {
  return findings.find((f) => f.message.includes(substring));
}

describe('endpoint-level rules', () => {
  it('flags a removed operation as breaking', () => {
    const oldSpec = base();
    const newSpec: OpenAPISpec = { ...base(), paths: {} };
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'was removed');
    expect(f?.severity).toBe('breaking');
    expect(f?.operation).toBe('GET /things');
  });

  it('flags a new operation as info', () => {
    const oldSpec = base();
    const newSpec = base();
    (newSpec.paths as any)['/things'].post = { responses: { '201': {} } };
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'New operation');
    expect(f?.severity).toBe('info');
  });
});

describe('request parameter rules', () => {
  it('flags a new required parameter as breaking', () => {
    const oldSpec = base();
    const newSpec = base();
    (newSpec.paths as any)['/things'].get.parameters.push({
      name: 'token',
      in: 'query',
      required: true,
      schema: { type: 'string' },
    });
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'New required parameter');
    expect(f?.severity).toBe('breaking');
  });

  it('flags optional-to-required as breaking', () => {
    const oldSpec = base();
    const newSpec = base();
    (newSpec.paths as any)['/things'].get.parameters[0].required = true;
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'optional to required');
    expect(f?.severity).toBe('breaking');
  });

  it('flags a parameter type change as breaking', () => {
    const oldSpec = base();
    const newSpec = base();
    (newSpec.paths as any)['/things'].get.parameters[0].schema.type = 'integer';
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'type changed');
    expect(f?.severity).toBe('breaking');
  });

  it('flags a new optional parameter as info', () => {
    const oldSpec = base();
    const newSpec = base();
    (newSpec.paths as any)['/things'].get.parameters.push({
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer' },
    });
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'New optional parameter');
    expect(f?.severity).toBe('info');
  });
});

describe('response schema rules', () => {
  it('flags a removed response property as breaking', () => {
    const oldSpec = base();
    const newSpec = base();
    delete (newSpec.paths as any)['/things'].get.responses['200'].content['application/json']
      .schema.properties.label;
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'property "label" was removed');
    expect(f?.severity).toBe('breaking');
  });

  it('flags a removed successful response status as breaking', () => {
    const oldSpec = base();
    const newSpec = base();
    delete (newSpec.paths as any)['/things'].get.responses['200'];
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'Response status "200" was removed');
    expect(f?.severity).toBe('breaking');
  });

  it('flags removed enum values as breaking', () => {
    const oldSpec = base();
    (oldSpec.paths as any)['/things'].get.parameters[0].schema.enum = ['a', 'b', 'c'];
    const newSpec = base();
    (newSpec.paths as any)['/things'].get.parameters[0].schema.enum = ['a', 'b'];
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'removed accepted value');
    expect(f?.severity).toBe('breaking');
  });

  it('recurses into array items', () => {
    const oldSpec = base();
    (oldSpec.paths as any)['/things'].get.responses['200'].content['application/json'].schema = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } } },
    };
    const newSpec = base();
    (newSpec.paths as any)['/things'].get.responses['200'].content['application/json'].schema = {
      type: 'array',
      items: { type: 'object', properties: {} },
    };
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'property "id" was removed');
    expect(f).toBeDefined();
    expect(f?.location).toContain('[].id');
  });
});

describe('security rules', () => {
  it('flags newly-required auth as breaking', () => {
    const oldSpec = base();
    const newSpec = base({ security: [{ apiKey: [] }] });
    const findings = diffSpecs(oldSpec, newSpec);
    const f = findBy(findings, 'Authentication is now required');
    expect(f?.severity).toBe('breaking');
  });
});
