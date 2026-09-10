import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, configHeaders, configString, loadCliConfig } from '../src/core/config.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.CONTRACTGUARD_TEST_TOKEN;
});

function makeConfig(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'contractguard-config-'));
  directories.push(directory);
  const file = join(directory, 'contractguard.config.yaml');
  writeFileSync(file, contents, 'utf8');
  return file;
}

describe('ContractGuard config', () => {
  it('loads test settings and interpolates environment variables in headers', () => {
    process.env.CONTRACTGUARD_TEST_TOKEN = 'example-token';
    const path = makeConfig(`
test:
  spec: demo/openapi.yaml
  baseUrl: https://api.example.test
  timeout: 2000
  headers:
    Authorization: "Bearer \${CONTRACTGUARD_TEST_TOKEN}"
`);

    const { config } = loadCliConfig(path);
    expect(configString(config.test, 'spec')).toBe('demo/openapi.yaml');
    expect(configString(config.test, 'timeout')).toBe('2000');
    expect(configHeaders(config.test)).toEqual({ Authorization: 'Bearer example-token' });
  });

  it('fails without exposing a missing environment value', () => {
    const path = makeConfig(`
test:
  headers:
    Authorization: "Bearer \${CONTRACTGUARD_TEST_TOKEN}"
`);

    expect(() => loadCliConfig(path)).toThrow(ConfigError);
    expect(() => loadCliConfig(path)).toThrow('CONTRACTGUARD_TEST_TOKEN');
  });
});
