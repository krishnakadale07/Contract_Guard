import type { Finding, Severity } from './types.js';
import type { RuntimeTestResult, RuntimeTestSummary } from './runtime.js';
import { redactUrl } from './redact.js';

export interface DiffReport {
  generatedAt: string;
  base: string;
  current: string;
  summary: {
    breaking: number;
    warning: number;
    info: number;
    total: number;
  };
  findings: Finding[];
}

export function buildReport(base: string, current: string, findings: Finding[]): DiffReport {
  const summary = { breaking: 0, warning: 0, info: 0, total: findings.length };
  for (const f of findings) summary[f.severity]++;
  return {
    generatedAt: new Date().toISOString(),
    base,
    current,
    summary,
    findings,
  };
}

const SEVERITY_ICON: Record<Severity, string> = {
  breaking: '✗',
  warning: '⚠',
  info: '✓',
};

export function formatText(report: DiffReport): string {
  const lines: string[] = [];
  lines.push(`ContractGuard diff: ${report.base} → ${report.current}`, '');

  if (report.findings.length === 0) {
    lines.push('No differences detected.');
  } else {
    for (const f of report.findings) {
      lines.push(`${SEVERITY_ICON[f.severity]} [${f.severity.toUpperCase()}] ${f.location}`);
      lines.push(`    ${f.message}`);
      lines.push(`    → ${f.suggestion}`);
      lines.push('');
    }
  }

  lines.push(
    `Summary: ${report.summary.breaking} breaking, ${report.summary.warning} warning, ${report.summary.info} info (${report.summary.total} total)`
  );
  return lines.join('\n');
}

export function formatMarkdown(report: DiffReport): string {
  const lines: string[] = [];
  lines.push(`# ContractGuard diff report`, '');
  lines.push(`**Base:** \`${report.base}\`  `);
  lines.push(`**Current:** \`${report.current}\`  `);
  lines.push(`**Generated:** ${report.generatedAt}`, '');
  lines.push(
    `| Breaking | Warning | Info | Total |`,
    `|---|---|---|---|`,
    `| ${report.summary.breaking} | ${report.summary.warning} | ${report.summary.info} | ${report.summary.total} |`,
    ''
  );

  if (report.findings.length === 0) {
    lines.push('No differences detected.');
    return lines.join('\n');
  }

  const bySeverity: Record<Severity, Finding[]> = { breaking: [], warning: [], info: [] };
  for (const f of report.findings) bySeverity[f.severity].push(f);

  for (const severity of ['breaking', 'warning', 'info'] as Severity[]) {
    const items = bySeverity[severity];
    if (items.length === 0) continue;
    lines.push(`## ${severity[0].toUpperCase()}${severity.slice(1)} (${items.length})`, '');
    for (const f of items) {
      lines.push(`- **${f.location}** — ${f.message}`);
      lines.push(`  - _Suggestion:_ ${f.suggestion}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function formatJson(report: DiffReport): string {
  return JSON.stringify(report, null, 2);
}

// --- Runtime test reports -------------------------------------------------

export interface TestReport {
  generatedAt: string;
  spec: string;
  baseUrl: string;
  summary: RuntimeTestSummary;
  results: RuntimeTestResult[];
}

export function buildTestReport(
  spec: string,
  baseUrl: string,
  results: RuntimeTestResult[],
  summary: RuntimeTestSummary
): TestReport {
  return {
    generatedAt: new Date().toISOString(),
    spec,
    baseUrl: redactUrl(baseUrl),
    summary,
    results: results.map((result) => ({ ...result, url: redactUrl(result.url) })),
  };
}

const TEST_ICON: Record<RuntimeTestResult['status'], string> = {
  passed: '✓',
  failed: '✗',
  skipped: '○',
};

export function formatTestText(report: TestReport): string {
  const lines: string[] = [];
  lines.push('ContractGuard v0.2 — runtime contract test', '');

  for (const r of report.results) {
    const label = r.httpStatus ? `${r.operation} (${r.httpStatus})` : r.operation;
    if (r.status === 'passed') {
      lines.push(`${TEST_ICON.passed} ${label} — contract valid`);
    } else if (r.status === 'skipped') {
      lines.push(`${TEST_ICON.skipped} ${label} — skipped: ${r.failures[0]}`);
    } else {
      lines.push(`${TEST_ICON.failed} ${label} — ${r.failures[0]}`);
      for (const extra of r.failures.slice(1)) lines.push(`    also: ${extra}`);
    }
  }

  lines.push(
    '',
    `Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`
  );
  return lines.join('\n');
}

export function formatTestMarkdown(report: TestReport): string {
  const lines: string[] = [];
  lines.push('# ContractGuard runtime test report', '');
  lines.push(`**Spec:** \`${report.spec}\`  `);
  lines.push(`**Base URL:** \`${report.baseUrl}\`  `);
  lines.push(`**Generated:** ${report.generatedAt}`, '');
  lines.push(
    '| Passed | Failed | Skipped | Total |',
    '|---|---|---|---|',
    `| ${report.summary.passed} | ${report.summary.failed} | ${report.summary.skipped} | ${report.summary.total} |`,
    ''
  );

  for (const r of report.results) {
    const icon = TEST_ICON[r.status];
    lines.push(`- ${icon} **${r.operation}**${r.httpStatus ? ` (${r.httpStatus})` : ''}`);
    for (const f of r.failures) lines.push(`  - ${f}`);
  }

  return lines.join('\n');
}

export function formatTestJson(report: TestReport): string {
  return JSON.stringify(report, null, 2);
}
