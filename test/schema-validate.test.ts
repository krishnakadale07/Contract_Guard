import { describe, it, expect } from 'vitest';
import { validateAgainstSchema } from '../src/core/schema-validate.js';

describe('validateAgainstSchema', () => {
  it('passes a matching object', () => {
    const schema = {
      type: 'object',
      required: ['id', 'email'],
      properties: { id: { type: 'string' }, email: { type: 'string' } },
    };
    const failures = validateAgainstSchema(schema, { id: '1', email: 'a@b.com' });
    expect(failures).toEqual([]);
  });

  it('flags a missing required field', () => {
    const schema = {
      type: 'object',
      required: ['id', 'email'],
      properties: { id: { type: 'string' }, email: { type: 'string' } },
    };
    const failures = validateAgainstSchema(schema, { id: '1' });
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe('$.email');
    expect(failures[0].message).toContain('missing');
  });

  it('flags a type mismatch', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer' } } };
    const failures = validateAgainstSchema(schema, { count: 'not a number' });
    expect(failures[0].message).toContain('expected type "integer"');
  });

  it('treats floats as not integers', () => {
    const schema = { type: 'integer' };
    const failures = validateAgainstSchema(schema, 1.5);
    expect(failures).toHaveLength(1);
  });

  it('recurses into array items', () => {
    const schema = {
      type: 'array',
      items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    };
    const failures = validateAgainstSchema(schema, [{ id: 'a' }, {}]);
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe('$[1].id');
  });

  it('flags a disallowed enum value', () => {
    const schema = { type: 'string', enum: ['active', 'inactive'] };
    const failures = validateAgainstSchema(schema, 'pending');
    expect(failures[0].message).toContain('not one of the allowed enum values');
  });
});
