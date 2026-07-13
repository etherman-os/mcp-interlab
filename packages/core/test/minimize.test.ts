import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CaseRunArtifact,
  InteropCase,
  InteropOperation,
  JsonValue,
  OperationObservation,
  TargetRun
} from '../src/types.js';

const mocks = vi.hoisted(() => ({
  runCase: vi.fn()
}));

vi.mock('../src/runner.js', () => ({
  runCase: mocks.runCase
}));

import { minimizeFailure } from '../src/minimize.js';

const targets = {
  baseline: {
    url: 'http://baseline.test/mcp',
    args: [],
    env: {},
    inheritEnv: [],
    recordHttp: false,
    maxResponseBytes: 4 * 1024 * 1024,
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 100
  },
  candidate: {
    url: 'http://candidate.test/mcp',
    args: [],
    env: {},
    inheritEnv: [],
    recordHttp: false,
    maxResponseBytes: 4 * 1024 * 1024,
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 100
  }
};

function testCase(): InteropCase {
  return {
    version: 1,
    id: 'minimize-search',
    title: 'Minimize search divergence',
    expectation: 'regression',
    tags: [],
    category: 'result-shape',
    sources: [],
    operations: [
      { id: 'discover', method: 'tools/list' },
      {
        id: 'irrelevant',
        method: 'tools/call',
        params: { name: 'echo', arguments: { value: 'noise' } }
      },
      {
        id: 'trigger',
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'typescript', limit: 7, noise: 'remove me' } }
      },
      { id: 'tail', method: 'resources/list' }
    ],
    compare: { ignorePaths: [], unorderedPaths: [] }
  };
}

const searchSchema: JsonValue = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1 },
    noise: { type: 'string' }
  },
  required: ['query', 'limit'],
  additionalProperties: false
};

const complexSchema: JsonValue = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1 },
    enabled: { type: 'boolean' },
    items: { type: 'array', items: { type: 'string' } },
    options: { type: 'object', additionalProperties: { type: 'string' } }
  },
  required: ['query', 'limit', 'enabled', 'items', 'options'],
  additionalProperties: false
};

function observation(
  operation: InteropOperation,
  target: string,
  inputSchema: JsonValue
): OperationObservation {
  let value: JsonValue = { ok: true };
  if (operation.method === 'tools/list') {
    value = { tools: [{ name: 'search', inputSchema }] };
  } else if (operation.id === 'trigger') {
    value = target === 'baseline' ? { items: [{ title: 'match' }] } : { items: [] };
  }
  return {
    id: operation.id,
    method: operation.method,
    status: 'success',
    value,
    durationMs: 1
  };
}

function targetRun(target: string, test: InteropCase): TargetRun {
  const inputSchema = test.id === 'minimize-complex' ? complexSchema : searchSchema;
  return {
    target,
    url: targets[target as keyof typeof targets].url,
    status: 'completed',
    observations: test.operations.map((operation) => observation(operation, target, inputSchema)),
    transcript: [],
    stdout: '',
    stderr: '',
    durationMs: 1
  };
}

function artifact(
  test: InteropCase,
  divergent = test.operations.some((operation) => operation.id === 'trigger')
): CaseRunArtifact {
  const triggerIndex = test.operations.findIndex((operation) => operation.id === 'trigger');
  return {
    schemaVersion: 1,
    kind: 'mcp-interlab-case-run',
    id: 'run-original',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    case: structuredClone(test),
    targetInfo: {
      baseline: { url: targets.baseline.url, managed: false, httpRecorded: false, envKeys: [] },
      candidate: { url: targets.candidate.url, managed: false, httpRecorded: false, envKeys: [] }
    },
    runs: [targetRun('baseline', test), targetRun('candidate', test)],
    comparisons: [
      {
        baseline: 'baseline',
        candidate: 'candidate',
        equivalent: !divergent,
        ...(divergent ? { category: 'result-shape' as const } : {}),
        differences: divergent
          ? [
              {
                path: `/observations/${triggerIndex}/value/items`,
                kind: 'changed',
                baseline: [{ title: 'match' }],
                candidate: []
              }
            ]
          : []
      }
    ]
  };
}

beforeEach(() => {
  mocks.runCase.mockReset();
  mocks.runCase.mockImplementation(async (_targetConfig, candidate: InteropCase) => artifact(candidate));
});

describe('minimizeFailure', () => {
  it('uses session ddmin and schema-aware value simplification to produce a minimal reproducer', async () => {
    const original = artifact(testCase());
    const originalSnapshot = structuredClone(original.case);
    const observedAttempts: Array<{ description: string; preserved: boolean; executions: number }> = [];

    const minimized = await minimizeFailure(original, targets, {
      onAttempt: (attempt, executions) => observedAttempts.push({ ...attempt, executions })
    });

    expect(minimized).toMatchObject({
      schemaVersion: 1,
      kind: 'mcp-interlab-minimized-case',
      originalRunId: 'run-original',
      category: 'result-shape',
      baseline: 'baseline',
      candidate: 'candidate'
    });
    expect(minimized.originalCase).toEqual(original.case);
    expect(minimized.originalCase).toBe(original.case);
    expect(original.case).toEqual(originalSnapshot);
    expect(minimized.minimizedCase).not.toBe(original.case);
    expect(minimized.minimizedCase.operations).toEqual([
      {
        id: 'trigger',
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'a', limit: 1 } }
      }
    ]);
    expect(minimized.attempts.some((attempt) => attempt.description.startsWith('session:'))).toBe(true);
    expect(
      minimized.attempts.some((attempt) => attempt.description.includes('schema validity changed'))
    ).toBe(true);
    expect(minimized.attempts.some((attempt) => attempt.description.includes('simplify string'))).toBe(true);
    expect(minimized.attempts.some((attempt) => attempt.description.includes('simplify number'))).toBe(true);
    expect(minimized.executions).toBe(mocks.runCase.mock.calls.length);
    expect(minimized.executions).toBeGreaterThan(0);
    expect(observedAttempts).toHaveLength(minimized.attempts.length);
    expect(observedAttempts.at(-1)?.executions).toBeLessThanOrEqual(minimized.executions);
    expect(minimized.complete).toBe(true);
    expect(minimized.stopReason).not.toBe('evaluation-budget');
    expect(minimized.attempts.slice(0, 2).map((attempt) => attempt.description)).toEqual([
      'preflight reproduction 1/2',
      'preflight reproduction 2/2'
    ]);
    expect(minimized.attempts.slice(-2).map((attempt) => attempt.description)).toEqual([
      'final reproduction 1/2',
      'final reproduction 2/2'
    ]);
  });

  it('honors the execution budget and reports an incomplete minimization', async () => {
    const original = artifact(testCase());
    const onAttempt = vi.fn();

    const minimized = await minimizeFailure(original, targets, { maxAttempts: 4, onAttempt });

    expect(minimized.executions).toBe(4);
    expect(mocks.runCase).toHaveBeenCalledTimes(4);
    expect(minimized.complete).toBe(false);
    expect(minimized.stopReason).toBe('evaluation-budget');
    expect(onAttempt).toHaveBeenCalledTimes(minimized.attempts.length);
    expect(minimized.minimizedCase.operations.length).toBeLessThan(original.case.operations.length);
  });

  it('shrinks required arrays and nested objects and simplifies booleans without changing schema validity', async () => {
    const complex = testCase();
    complex.id = 'minimize-complex';
    complex.operations = [
      { id: 'discover', method: 'tools/list' },
      {
        id: 'trigger',
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: {
            query: 'query',
            limit: 4,
            enabled: true,
            items: ['alpha', 'beta', 'gamma'],
            options: { first: 'one', second: 'two' }
          }
        }
      }
    ];

    const minimized = await minimizeFailure(artifact(complex), targets);

    expect(minimized.complete).toBe(true);
    expect(minimized.minimizedCase.operations).toEqual([
      {
        id: 'trigger',
        method: 'tools/call',
        params: {
          name: 'search',
          arguments: { query: 'a', limit: 1, enabled: false, items: [], options: {} }
        }
      }
    ]);
    expect(minimized.attempts.some((attempt) => attempt.description.includes('simplify boolean'))).toBe(true);
    expect(minimized.attempts.some((attempt) => attempt.description.includes('array: remove items'))).toBe(
      true
    );
    expect(
      minimized.attempts.some((attempt) => attempt.description.includes('nested object: remove items'))
    ).toBe(true);
  });

  it('rejects an evaluation budget too small for preflight and final verification', async () => {
    await expect(minimizeFailure(artifact(testCase()), targets, { maxAttempts: 3 })).rejects.toThrow(
      'Minimization requires an evaluation budget of at least 4'
    );
    expect(mocks.runCase).not.toHaveBeenCalled();
  });

  it('minimizes one comparison from an artifact that contains three target runs', async () => {
    const original = artifact(testCase());
    original.runs.push({
      ...targetRun('baseline', original.case),
      target: 'third',
      url: 'http://third.test/mcp'
    });
    original.targetInfo.third = {
      url: 'http://third.test/mcp',
      managed: false,
      httpRecorded: false,
      envKeys: []
    };
    const targetsWithThird = {
      ...targets,
      third: { ...targets.baseline, url: 'http://third.test/mcp' }
    };

    const minimized = await minimizeFailure(original, targetsWithThird);

    expect(minimized.complete).toBe(true);
    expect(minimized.baseline).toBe('baseline');
    expect(minimized.candidate).toBe('candidate');
    expect(mocks.runCase.mock.calls.every((call) => call[2]?.targetNames.length === 2)).toBe(true);
  });

  it('rejects artifacts without a categorized divergence', async () => {
    const equivalent = artifact(testCase(), false);

    await expect(minimizeFailure(equivalent, targets)).rejects.toThrow(
      'Artifact does not contain a divergent comparison'
    );
    expect(mocks.runCase).not.toHaveBeenCalled();
  });
});
