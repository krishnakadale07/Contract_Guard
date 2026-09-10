#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import {
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
} from '../core/index.js';

const program = new Command();

program
  .name('contractguard')
  .description('Detect breaking OpenAPI changes and validate contracts')
  .version('0.1.0');

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
      printError(err);
      process.exitCode = 1;
    }
  });

program
  .command('diff')
  .description('Compare two OpenAPI specs and report breaking changes')
  .requiredOption('--base <path>', 'path to the base (old) spec')
  .requiredOption('--current <path>', 'path to the current (new) spec')
  .option('--format <format>', 'output format: text | json | markdown', 'text')
  .option('--fail-on <severity>', 'exit 1 if a finding at this severity or above exists', 'breaking')
  .option('--out <path>', 'write the report to a file instead of / in addition to stdout')
  .action(
    (opts: {
      base: string;
      current: string;
      format: string;
      failOn: string;
      out?: string;
    }) => {
      try {
        const oldSpec = loadAndResolveSpec(opts.base);
        const newSpec = loadAndResolveSpec(opts.current);
        const findings = diffSpecs(oldSpec, newSpec);
        const report = buildReport(opts.base, opts.current, findings);

        const output =
          opts.format === 'json'
            ? formatJson(report)
            : opts.format === 'markdown'
              ? formatMarkdown(report)
              : formatText(report);

        console.log(output);
        if (opts.out) {
          writeFileSync(opts.out, output, 'utf8');
        }

        process.exitCode = shouldFail(opts.failOn as Severity | 'none', report.summary) ? 1 : 0;
      } catch (err) {
        printError(err);
        process.exitCode = 1;
      }
    }
  );

program
  .command('test')
  .description('Run safe GET requests against a live base URL and validate responses against the spec')
  .requiredOption('--spec <path>', 'path to OpenAPI YAML/JSON file')
  .requiredOption('--base-url <url>', 'base URL of the running API to test against')
  .option('--format <format>', 'output format: text | json | markdown', 'text')
  .option('--report <path>', 'write the report to a file (in addition to stdout)')
  .option('--timeout <ms>', 'per-request timeout in milliseconds', '5000')
  .option('--concurrency <n>', 'max concurrent requests', '4')
  .option('--fail-on <mode>', 'failed | none — exit 1 when true', 'failed')
  .action(
    async (opts: {
      spec: string;
      baseUrl: string;
      format: string;
      report?: string;
      timeout: string;
      concurrency: string;
      failOn: string;
    }) => {
      try {
        const spec = loadAndResolveSpec(opts.spec);
        const { results, summary } = await runRuntimeTests(spec, {
          baseUrl: opts.baseUrl,
          timeoutMs: Number(opts.timeout),
          concurrency: Number(opts.concurrency),
        });
        const report = buildTestReport(opts.spec, opts.baseUrl, results, summary);

        const output =
          opts.format === 'json'
            ? formatTestJson(report)
            : opts.format === 'markdown'
              ? formatTestMarkdown(report)
              : formatTestText(report);

        console.log(output);
        if (opts.report) {
          writeFileSync(opts.report, output, 'utf8');
        }

        process.exitCode = opts.failOn === 'failed' && summary.failed > 0 ? 1 : 0;
      } catch (err) {
        printError(err);
        process.exitCode = 1;
      }
    }
  );

function shouldFail(
  failOn: Severity | 'none',
  summary: { breaking: number; warning: number; info: number }
): boolean {
  if (failOn === 'none') return false;
  if (failOn === 'breaking') return summary.breaking > 0;
  if (failOn === 'warning') return summary.breaking > 0 || summary.warning > 0;
  return summary.breaking > 0 || summary.warning > 0 || summary.info > 0;
}

function printError(err: unknown) {
  if (err instanceof SpecValidationError) {
    console.error(err.message);
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(String(err));
  }
}

await program.parseAsync();
