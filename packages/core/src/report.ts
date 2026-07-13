import type { CaseRunArtifact, DiffEntry, JsonValue, SuiteRunArtifact } from './types.js';

function safeTerminal(value: string): string {
  return value
    .replaceAll(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replaceAll(/[\r\n]+/g, ' ');
}

function safeMarkdown(value: string): string {
  return value
    .replaceAll(/[\r\n]+/g, ' ')
    .replaceAll(/([\\`*_{}\[\]()#+\-.!])/g, '\\$1')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('@', '&#64;');
}

function markdownCode(value: string): string {
  return `<code>${safeMarkdown(value)}</code>`;
}

function displayValue(value: JsonValue | undefined, maxLength = 180): string {
  if (value === undefined) return '∅';
  const rendered = JSON.stringify(value);
  return rendered.length <= maxLength ? rendered : `${rendered.slice(0, maxLength - 1)}…`;
}

function terminalDiff(difference: DiffEntry): string {
  return safeTerminal(
    `    ${difference.kind.padEnd(12)} ${difference.path}\n      baseline: ${displayValue(difference.baseline)}\n      candidate: ${displayValue(difference.candidate)}`
  );
}

export function renderCaseTerminal(artifact: CaseRunArtifact): string {
  const lines = [`CASE ${safeTerminal(artifact.case.id)} — ${safeTerminal(artifact.case.title)}`];
  for (const run of artifact.runs) {
    const sdk = run.sdk ? ` (${run.sdk.name}@${run.sdk.version})` : '';
    lines.push(
      `  ${safeTerminal(run.target)}: ${run.status}${safeTerminal(sdk)}, ${run.observations.length} operation(s)`
    );
    if (run.error) lines.push(`    ${safeTerminal(run.error.name)}: ${safeTerminal(run.error.message)}`);
  }
  for (const comparison of artifact.comparisons) {
    if (comparison.equivalent) {
      lines.push(`  ✓ ${safeTerminal(comparison.baseline)} = ${safeTerminal(comparison.candidate)}`);
      continue;
    }
    const label = artifact.case.expectation === 'regression' ? 'REGRESSION FOUND' : 'DIFFERENCE FOUND';
    lines.push(
      `  ✗ ${label}: ${safeTerminal(comparison.baseline)} ≠ ${safeTerminal(comparison.candidate)} [${comparison.category ?? 'protocol'}]`
    );
    lines.push(...comparison.differences.slice(0, 12).map(terminalDiff));
    if (comparison.differences.length > 12) {
      lines.push(`    … ${comparison.differences.length - 12} more difference(s)`);
    }
  }
  return lines.join('\n');
}

export function renderSuiteTerminal(artifact: SuiteRunArtifact): string {
  const header = [
    'MCP Interlab',
    `Run ${safeTerminal(artifact.id)}`,
    `${artifact.summary.total} case(s): ${artifact.summary.equivalent} equivalent, ${artifact.summary.divergent} divergent, ${artifact.summary.harnessErrors} harness error(s)`,
    ''
  ];
  return [...header, ...artifact.cases.map(renderCaseTerminal)].join('\n\n');
}

function markdownDiff(difference: DiffEntry): string {
  return `| ${markdownCode(difference.path)} | ${difference.kind} | ${markdownCode(displayValue(difference.baseline))} | ${markdownCode(displayValue(difference.candidate))} |`;
}

export function renderSuiteMarkdown(artifact: SuiteRunArtifact): string {
  const lines = [
    '# MCP Interlab report',
    '',
    `- Run: ${markdownCode(artifact.id)}`,
    `- Cases: ${artifact.summary.total}`,
    `- Equivalent: ${artifact.summary.equivalent}`,
    `- Divergent: ${artifact.summary.divergent}`,
    `- Harness errors: ${artifact.summary.harnessErrors}`,
    ''
  ];

  for (const caseArtifact of artifact.cases) {
    lines.push(`## ${safeMarkdown(caseArtifact.case.id)}: ${safeMarkdown(caseArtifact.case.title)}`, '');
    if (caseArtifact.case.sources.length > 0) {
      lines.push(
        `Sources: ${caseArtifact.case.sources
          .map((source) => {
            const url = new URL(source.url).href.replaceAll('(', '%28').replaceAll(')', '%29');
            return `[link](${url})`;
          })
          .join(', ')}`,
        ''
      );
    }
    for (const comparison of caseArtifact.comparisons) {
      if (comparison.equivalent) {
        lines.push(
          `✅ **${safeMarkdown(comparison.baseline)}** and **${safeMarkdown(comparison.candidate)}** are equivalent.`,
          ''
        );
        continue;
      }
      lines.push(
        `❌ **${safeMarkdown(comparison.baseline)}** and **${safeMarkdown(comparison.candidate)}** diverged (${comparison.category ?? 'protocol'}).`,
        '',
        '| Path | Change | Baseline | Candidate |',
        '| --- | --- | --- | --- |',
        ...comparison.differences.map(markdownDiff),
        ''
      );
    }
  }
  return lines.join('\n');
}
