import { describe, expect, it } from 'vitest';

import { caseRunArtifactSchema, suiteRunArtifactSchema } from '../src/artifact.js';
import { compareTargetRuns } from '../src/diff.js';
import { renderSuiteMarkdown, renderSuiteTerminal } from '../src/report.js';
import type { CaseRunArtifact, SuiteRunArtifact, TargetRun } from '../src/types.js';

function target(target: string, value: string): TargetRun {
  return {
    target,
    url: `http://${target}.test/mcp`,
    status: 'completed',
    observations: [
      {
        id: 'call',
        method: 'tools/call',
        status: 'success',
        value: { content: [{ type: 'text', text: value }] },
        durationMs: 1
      }
    ],
    transcript: [],
    stdout: '',
    stderr: '',
    durationMs: 2
  };
}

function artifact(): SuiteRunArtifact {
  const baseline = target('baseline', 'left|\u001b[31m');
  const candidate = target('candidate', 'right');
  const caseRun: CaseRunArtifact = {
    schemaVersion: 1,
    kind: 'mcp-interlab-case-run',
    id: 'case-run',
    startedAt: '2026-07-12T00:00:00.000Z',
    durationMs: 5,
    case: {
      version: 1,
      id: 'safe-id',
      title: '<script>\u001b[31m\u009b31m| [click](https://evil.test) @maintainer',
      expectation: 'differential',
      tags: [],
      sources: [],
      operations: [{ id: 'call', method: 'tools/call', params: { name: 'probe', arguments: {} } }],
      compare: { ignorePaths: [], unorderedPaths: [] }
    },
    targetInfo: {
      baseline: { url: baseline.url, managed: false, httpRecorded: false, envKeys: [] },
      candidate: { url: candidate.url, managed: false, httpRecorded: false, envKeys: [] }
    },
    runs: [baseline, candidate],
    comparisons: [
      {
        baseline: 'baseline',
        candidate: 'candidate',
        equivalent: false,
        category: 'result-shape',
        differences: [
          {
            path: '/observations/0/value/content/0/text',
            kind: 'changed',
            baseline: 'left|\u001b[31m',
            candidate: 'right'
          }
        ]
      }
    ]
  };
  return {
    schemaVersion: 1,
    kind: 'mcp-interlab-suite-run',
    id: 'suite',
    startedAt: '2026-07-12T00:00:00.000Z',
    durationMs: 5,
    cases: [caseRun],
    summary: { total: 1, equivalent: 0, divergent: 1, harnessErrors: 0 }
  };
}

describe('run artifact validation', () => {
  it('accepts a complete artifact and rejects partial or unsafe URL shapes', () => {
    const value = artifact();
    expect(suiteRunArtifactSchema.safeParse(value).success).toBe(true);
    expect(caseRunArtifactSchema.safeParse({ schemaVersion: 1, kind: 'mcp-interlab-case-run' }).success).toBe(
      false
    );

    const unsafe = structuredClone(value.cases[0]!);
    unsafe.runs[0]!.url = 'file:///etc/passwd';
    expect(caseRunArtifactSchema.safeParse(unsafe).success).toBe(false);
  });

  it('rejects internally inconsistent summaries, comparisons, and transcripts', () => {
    const wrongSummary = artifact();
    wrongSummary.summary.divergent = 0;
    expect(suiteRunArtifactSchema.safeParse(wrongSummary).success).toBe(false);

    const wrongComparison = artifact();
    wrongComparison.cases[0]!.comparisons[0]!.equivalent = true;
    expect(suiteRunArtifactSchema.safeParse(wrongComparison).success).toBe(false);

    const wrongTarget = artifact();
    wrongTarget.cases[0]!.comparisons[0]!.candidate = 'missing';
    expect(suiteRunArtifactSchema.safeParse(wrongTarget).success).toBe(false);

    const wrongSequence = artifact();
    wrongSequence.cases[0]!.runs[0]!.transcript = [
      {
        sequence: 2,
        method: 'POST',
        url: 'http://baseline.test/mcp',
        requestHeaders: {},
        durationMs: 1
      }
    ];
    expect(suiteRunArtifactSchema.safeParse(wrongSequence).success).toBe(false);
  });

  it('rejects a self-consistent but forged comparison that disagrees with its target runs', () => {
    const forged = artifact();
    const caseArtifact = forged.cases[0]!;
    const actual = compareTargetRuns(
      caseArtifact.runs[0]!,
      caseArtifact.runs[1]!,
      caseArtifact.case.compare,
      caseArtifact.case.category
    );
    expect(actual.equivalent).toBe(false);
    expect(actual.differences.length).toBeGreaterThan(0);

    caseArtifact.comparisons[0] = {
      baseline: 'baseline',
      candidate: 'candidate',
      equivalent: true,
      differences: []
    };
    forged.summary = { total: 1, equivalent: 1, divergent: 0, harnessErrors: 0 };

    const result = suiteRunArtifactSchema.safeParse(forged);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['cases', 0, 'comparisons', 0],
            message: 'must match the comparison recomputed from the target runs'
          })
        ])
      );
    }
  });

  it('rejects observations and target runs whose status disagrees with their payload', () => {
    const missingObservationError = artifact();
    const failedObservation = missingObservationError.cases[0]!.runs[0]!.observations[0]!;
    failedObservation.status = 'error';
    delete failedObservation.value;
    expect(suiteRunArtifactSchema.safeParse(missingObservationError).success).toBe(false);

    const errorOnSuccess = artifact();
    errorOnSuccess.cases[0]!.runs[0]!.observations[0]!.error = {
      name: 'Error',
      message: 'impossible success error'
    };
    expect(suiteRunArtifactSchema.safeParse(errorOnSuccess).success).toBe(false);

    const missingRunError = artifact();
    missingRunError.cases[0]!.runs[0]!.status = 'crash';
    expect(suiteRunArtifactSchema.safeParse(missingRunError).success).toBe(false);

    const errorOnCompletedRun = artifact();
    errorOnCompletedRun.cases[0]!.runs[0]!.error = {
      name: 'Error',
      message: 'impossible completed-run error'
    };
    expect(suiteRunArtifactSchema.safeParse(errorOnCompletedRun).success).toBe(false);
  });
});

describe('safe report rendering', () => {
  it('strips terminal controls and escapes Markdown table/title content', () => {
    const value = artifact();
    const terminal = renderSuiteTerminal(value);
    const markdown = renderSuiteMarkdown(value);
    expect(terminal).toContain('DIFFERENCE FOUND');
    expect(terminal).not.toContain('REGRESSION FOUND');
    expect(terminal).not.toContain('\u001b');
    expect(terminal).not.toContain('\u009b');
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).toContain('&#124;');
    expect(markdown).toContain('&#64;maintainer');
    expect(markdown).not.toContain('[click](https://evil.test)');
  });
});
