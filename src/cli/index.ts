#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import {
  ConfigError,
  configHeaders,
  configString,
  loadCliConfig,
  loadAndResolveSpec,
  SpecValidationError,
  diffSpecs,
  buildReport,
  formatText,
  formatMarkdown,
  formatJson,
  runRuntimeTests,
  buildTestReport,
  formatTestText,
  formatTestMarkdown,
  formatTestJson,
  type Severity,
  type StringMap,
} from '../core/index.js';

const program = new Command();

class CliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliInputError';
  }
}

type OutputFormat = 'text' | 'json' | 'markdown';

program
  .name('contractguard')
  .description('Detect breaking OpenAPI changes and validate live API contracts')
  .version('0.2.0')
  .showHelpAfterError();

program
  .command('validate')
  .description('Validate that an OpenAPI spec is well-formed')
  .argument('<spec>', 'path to OpenAPI YAML/JSON file')
  .action((specPath: string) => {
    try {
      loadAndResolveSpec(specPath);
      console.log(`✓ ${specPath} is a valid OpenAPI 3.0/3.1 spec`);
      process.exitCode = 0;
    } catch (err) {
      failCommand(err);
    }
  });

program
  .command('diff')
  .description('Compare two OpenAPI specs and report breaking changes')
  .option('--config <path>', 'path to a ContractGuard YAML or JSON config file')
  .option('--base <path>', 'path to the base (old) spec')
  .option('--current <path>', 'path to the current (new) spec')
  .option('--format <format>', 'output format: text | json | markdown')
  .option('--fail-on <severity>', 'breaking | warning | info | none')
  .option('--out <path>', 'write the report to a file in addition to stdout')
  .action((opts: DiffOptions) => {
    try {
      const { config } = loadCliConfig(opts.config);
      const section = config.diff;
      const base = requiredSetting(
        opts.base,
        'CONTRACTGUARD_DIFF_BASE',
        configString(section, 'base'),
        '--base (or diff.base in config)'
      );
      const current = requiredSetting(
        opts.current,
        'CONTRACTGUARD_DIFF_CURRENT',
        configString(section, 'current'),
        '--current (or diff.current in config)'
      );
      const format = outputFormat(setting(opts.format, 'CONTRACTGUARD_DIFF_FORMAT', configString(section, 'format'), 'text'));
      const failOn = diffFailOn(
        setting(opts.failOn, 'CONTRACTGUARD_DIFF_FAIL_ON', configString(section, 'failOn'), 'breaking')
      );
      const out = setting(opts.out, 'CONTRACTGUARD_DIFF_OUT', configString(section, 'out'));

      const oldSpec = loadAndResolveSpec(base);
      const newSpec = loadAndResolveSpec(current);
      const findings = diffSpecs(oldSpec, newSpec);
      const report = buildReport(base, current, findings);
      const output = formatDiffReport(format, report);

      console.log(output);
      if (out) writeFileSync(out, output, 'utf8');
      process.exitCode = shouldFail(failOn, report.summary) ? 1 : 0;
    } catch (err) {
      failCommand(err);
    }
  });

program
  .command('test')
  .description('Run safe GET requests against a live API and validate responses against the spec')
  .option('--config <path>', 'path to a ContractGuard YAML or JSON config file')
  .option('--spec <path>', 'path to OpenAPI YAML/JSON file')
  .option('--base-url <url>', 'base URL of the running API to test against')
  .option('--format <format>', 'output format: text | json | markdown')
  .option('--report <path>', 'write the report to a file in addition to stdout')
  .option('--timeout <ms>', 'per-request timeout in milliseconds')
  .option('--concurrency <n>', 'maximum concurrent requests')
  .option('--fail-on <mode>', 'failed | none')
  .option('-H, --header <name:value>', 'request header; repeat for multiple headers', collectHeader, [])
  .action(async (opts: TestOptions) => {
    try {
      const { config } = loadCliConfig(opts.config);
      const section = config.test;
      const specPath = requiredSetting(
        opts.spec,
        'CONTRACTGUARD_TEST_SPEC',
        configString(section, 'spec'),
        '--spec (or test.spec in config)'
      );
      const baseUrl = requiredSetting(
        opts.baseUrl,
        'CONTRACTGUARD_TEST_BASE_URL',
        configString(section, 'baseUrl'),
        '--base-url (or test.baseUrl in config)'
      );
      const format = outputFormat(setting(opts.format, 'CONTRACTGUARD_TEST_FORMAT', configString(section, 'format'), 'text'));
      const timeoutMs = positiveInteger(
        setting(opts.timeout, 'CONTRACTGUARD_TEST_TIMEOUT', configString(section, 'timeout'), '5000'),
        'timeout'
      );
      const concurrency = positiveInteger(
        setting(opts.concurrency, 'CONTRACTGUARD_TEST_CONCURRENCY', configString(section, 'concurrency'), '4'),
        'concurrency'
      );
      const failOn = testFailOn(
        setting(opts.failOn, 'CONTRACTGUARD_TEST_FAIL_ON', configString(section, 'failOn'), 'failed')
      );
      const reportPath = setting(opts.report, 'CONTRACTGUARD_TEST_REPORT', configString(section, 'report'));
      const headers = resolveHeaders(configHeaders(section), opts.header);

      const spec = loadAndResolveSpec(specPath);
      const { results, summary } = await runRuntimeTests(spec, {
        baseUrl,
        timeoutMs,
        concurrency,
        headers,
        redactValues: Object.values(headers),
      });
      const report = buildTestReport(specPath, baseUrl, results, summary);
      const output = formatTestReport(format, report);

      console.log(output);
      if (reportPath) writeFileSync(reportPath, output, 'utf8');
      process.exitCode = failOn === 'failed' && summary.failed > 0 ? 1 : 0;
    } catch (err) {
      failCommand(err);
    }
  });

interface DiffOptions {
  config?: string;
  base?: string;
  current?: string;
  format?: string;
  failOn?: string;
  out?: string;
}

interface TestOptions {
  config?: string;
  spec?: string;
  baseUrl?: string;
  format?: string;
  report?: string;
  timeout?: string;
  concurrency?: string;
  failOn?: string;
  header: string[];
}

function setting(
  commandLineValue: string | undefined,
  environmentName: string,
  configValue: string | undefined,
  fallback?: string
): string | undefined {
  return commandLineValue ?? process.env[environmentName] ?? configValue ?? fallback;
}

function requiredSetting(
  commandLineValue: string | undefined,
  environmentName: string,
  configValue: string | undefined,
  description: string
): string {
  const value = setting(commandLineValue, environmentName, configValue);
  if (!value) throw new CliInputError(`Missing ${description}. Environment variable ${environmentName} is also supported.`);
  return value;
}

function outputFormat(value: string | undefined): OutputFormat {
  if (value === 'text' || value === 'json' || value === 'markdown') return value;
  throw new CliInputError(`Invalid format "${value}". Use text, json, or markdown.`);
}

function diffFailOn(value: string | undefined): Severity | 'none' {
  if (value === 'breaking' || value === 'warning' || value === 'info' || value === 'none') return value;
  throw new CliInputError(`Invalid --fail-on value "${value}". Use breaking, warning, info, or none.`);
}

function testFailOn(value: string | undefined): 'failed' | 'none' {
  if (value === 'failed' || value === 'none') return value;
  throw new CliInputError(`Invalid --fail-on value "${value}". Use failed or none.`);
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliInputError(`${label} must be a positive integer; received "${value}".`);
  }
  return parsed;
}

function collectHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseHeaderEntries(entries: string[]): StringMap {
  const headers: StringMap = {};
  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator <= 0) throw new CliInputError('Headers must use the format "Name: value".');
    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new CliInputError('Header names and values cannot be empty or contain line breaks.');
    }
    headers[name] = value;
  }
  return headers;
}

function environmentHeaders(): StringMap {
  const raw = process.env.CONTRACTGUARD_HEADERS;
  const headers: StringMap = {};
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliInputError('CONTRACTGUARD_HEADERS must be a JSON object of header names and values.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new CliInputError('CONTRACTGUARD_HEADERS must be a JSON object of header names and values.');
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new CliInputError('CONTRACTGUARD_HEADERS values must all be strings.');
      }
      headers[name] = value;
    }
  }

  const token = process.env.CONTRACTGUARD_API_TOKEN;
  if (token) {
    const scheme = process.env.CONTRACTGUARD_AUTH_SCHEME || 'Bearer';
    headers.Authorization = `${scheme} ${token}`;
  }
  return headers;
}

/** Per-header precedence: CLI flag > environment > config file. */
function resolveHeaders(configured: StringMap, commandLineEntries: string[]): StringMap {
  return { ...configured, ...environmentHeaders(), ...parseHeaderEntries(commandLineEntries) };
}

function formatDiffReport(format: OutputFormat, report: ReturnType<typeof buildReport>): string {
  if (format === 'json') return formatJson(report);
  if (format === 'markdown') return formatMarkdown(report);
  return formatText(report);
}

function formatTestReport(format: OutputFormat, report: ReturnType<typeof buildTestReport>): string {
  if (format === 'json') return formatTestJson(report);
  if (format === 'markdown') return formatTestMarkdown(report);
  return formatTestText(report);
}

function shouldFail(
  failOn: Severity | 'none',
  summary: { breaking: number; warning: number; info: number }
): boolean {
  if (failOn === 'none') return false;
  if (failOn === 'breaking') return summary.breaking > 0;
  if (failOn === 'warning') return summary.breaking > 0 || summary.warning > 0;
  return summary.breaking > 0 || summary.warning > 0 || summary.info > 0;
}

/** Exit 2 means setup, config, or input is invalid; exit 1 is a contract finding. */
function failCommand(err: unknown): void {
  if (err instanceof ConfigError || err instanceof CliInputError || err instanceof SpecValidationError) {
    console.error(`Error: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(String(err));
  }
  process.exitCode = 2;
}

await program.parseAsync();
