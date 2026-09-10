import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

export type StringMap = Record<string, string>;

export interface ContractGuardConfig {
  diff?: Record<string, unknown>;
  test?: Record<string, unknown> & { headers?: StringMap };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Replaces ${VARIABLE_NAME} with a value from the current environment. Missing
 * values fail fast, without including any other environment values in the error.
 */
function interpolateEnvironment(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
      const environmentValue = process.env[name];
      if (environmentValue === undefined) {
        throw new ConfigError(`Environment variable ${name} is required by the ContractGuard config but is not set`);
      }
      return environmentValue;
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnvironment);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, interpolateEnvironment(child)])
    );
  }
  return value;
}

function readConfig(path: string): ContractGuardConfig {
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(path, 'utf8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not read config file ${path}: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(`Config file ${path} must contain a YAML or JSON object`);
  }

  const config = interpolateEnvironment(parsed);
  if (!isRecord(config)) {
    throw new ConfigError(`Config file ${path} must contain a YAML or JSON object`);
  }
  for (const section of ['diff', 'test']) {
    if (config[section] !== undefined && !isRecord(config[section])) {
      throw new ConfigError(`Config property "${section}" must be an object`);
    }
  }
  return config as ContractGuardConfig;
}

/**
 * Uses an explicit --config value first, then CONTRACTGUARD_CONFIG, then a
 * conventional config file in the working directory. Returning an empty
 * config when no conventional file exists keeps existing CLI usage unchanged.
 */
export function loadCliConfig(explicitPath?: string): { config: ContractGuardConfig; path?: string } {
  const requestedPath = explicitPath ?? process.env.CONTRACTGUARD_CONFIG;
  if (requestedPath) {
    const path = resolve(requestedPath);
    if (!existsSync(path)) throw new ConfigError(`Config file does not exist: ${path}`);
    return { config: readConfig(path), path };
  }

  for (const candidate of ['contractguard.config.yaml', 'contractguard.config.yml', 'contractguard.config.json']) {
    const path = resolve(candidate);
    if (existsSync(path)) return { config: readConfig(path), path };
  }
  return { config: {} };
}

export function configString(
  section: Record<string, unknown> | undefined,
  property: string
): string | undefined {
  const value = section?.[property];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new ConfigError(`Config property "${property}" must be a string, number, or boolean`);
  }
  return String(value);
}

export function configHeaders(section: Record<string, unknown> | undefined): StringMap {
  const value = section?.headers;
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ConfigError('Config property "test.headers" must be an object');

  const headers: StringMap = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') {
      throw new ConfigError(`Header "${name}" in test.headers must have a string value`);
    }
    headers[name] = headerValue;
  }
  return headers;
}
