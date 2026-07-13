import { describe, expect, it } from 'vitest';

import { compareTargetRuns, diffJson } from '../src/diff.js';
import { comparableTargetRun, matchesPointer, normalizeJson } from '../src/normalize.js';
import type { CompareRules, JsonValue, OperationObservation, TargetRun } from '../src/types.js';

const noRules: CompareRules = { ignorePaths: [], unorderedPaths: [] };

function observation(overrides: Partial<OperationObservation> = {}): OperationObservation {
  return {
    id: 'call',
    method: 'tools/call',
    status: 'success',
    value: { content: [{ type: 'text', text: 'ok' }] },
    durationMs: 12,
    ...overrides
  };
}

function targetRun(target: string, overrides: Partial<TargetRun> = {}): TargetRun {
  return {
    target,
    url: `http://${target}.test/mcp`,
    status: 'completed',
    protocolVersion: '2025-11-25',
    observations: [observation()],
    transcript: [],
    stdout: `${target} stdout`,
    stderr: '',
    durationMs: 24,
    ...overrides
  };
}

describe('JSON pointer matching', () => {
  it.each([
    ['/items/0/name', '/items/*/name', true],
    ['/items/0/nested/name', '/items/**/name', true],
    ['/items/name', '/items/**/name', true],
    ['/items/0/name/more', '/items/*/name', false],
    ['/a~1b/~0key', '/a~1b/*', true],
    ['/different', '/**', true],
    ['', '', true],
    ['/anything', '', false]
  ])('matches %j against %j as %s', (path, pattern, expected) => {
    expect(matchesPointer(path, pattern)).toBe(expected);
  });
});

describe('normalizeJson', () => {
  it('sorts object keys, removes only opted-in fields, and canonicalizes unordered arrays', () => {
    const value: JsonValue = {
      z: 3,
      rows: [
        { volatile: 'second', id: 2 },
        { volatile: 'first', id: 1 }
      ],
      payload: { requestId: 'domain-value', timestamp: 'also-domain-data' },
      a: 1
    };

    const normalized = normalizeJson(value, {
      ignorePaths: ['/rows/*/volatile'],
      unorderedPaths: ['/rows']
    });

    expect(JSON.stringify(normalized)).toBe(
      '{"a":1,"payload":{"requestId":"domain-value","timestamp":"also-domain-data"},"rows":[{"id":1},{"id":2}],"z":3}'
    );
  });

  it('honors escaped pointer tokens and recursive wildcards', () => {
    const normalized = normalizeJson(
      {
        'a/b': { '~secret': true, keep: true },
        nested: { first: { generated: 1 }, second: { deep: { generated: 2 } } }
      },
      {
        ignorePaths: ['/a~1b/~0secret', '/nested/**/generated'],
        unorderedPaths: []
      }
    );

    expect(normalized).toEqual({ 'a/b': { keep: true }, nested: { first: {}, second: { deep: {} } } });
  });

  it('normalizes array elements before ordering them', () => {
    expect(
      normalizeJson(
        [
          { value: 2, noise: 'a' },
          { value: 1, noise: 'z' }
        ],
        { ignorePaths: ['/*/noise'], unorderedPaths: [''] }
      )
    ).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('uses locale-independent ordering for canonically distinct Unicode strings', () => {
    const rules = { ignorePaths: [], unorderedPaths: [''] };
    expect(normalizeJson(['é', 'é'], rules)).toEqual(normalizeJson(['é', 'é'], rules));
  });
});

describe('comparableTargetRun', () => {
  it('excludes transport diagnostics and durations but keeps payload fields by default', () => {
    const run = targetRun('baseline', {
      sdk: { name: 'fixture-sdk', version: '1.0.0' },
      observations: [
        observation({
          value: { timestamp: 'payload timestamp', requestId: 'business request id' },
          durationMs: 9_999
        })
      ]
    });

    const comparable = comparableTargetRun(run, noRules);

    expect(comparable).toEqual({
      status: 'completed',
      protocolVersion: '2025-11-25',
      observations: [
        {
          id: 'call',
          method: 'tools/call',
          status: 'success',
          value: { requestId: 'business request id', timestamp: 'payload timestamp' }
        }
      ]
    });
    expect(JSON.stringify(comparable)).not.toContain('9999');
    expect(JSON.stringify(comparable)).not.toContain('fixture-sdk');
    expect(JSON.stringify(comparable)).not.toContain('stdout');
  });
});

describe('diffJson', () => {
  it('reports deterministic added, changed, removed, and type-changed entries', () => {
    expect(
      diffJson(
        { changed: 1, removed: true, stable: 'same', typed: '1' },
        { added: false, changed: 2, stable: 'same', typed: 1 }
      )
    ).toEqual([
      { path: '/added', kind: 'added', candidate: false },
      { path: '/changed', kind: 'changed', baseline: 1, candidate: 2 },
      { path: '/removed', kind: 'removed', baseline: true },
      { path: '/typed', kind: 'type-changed', baseline: '1', candidate: 1 }
    ]);
  });

  it('escapes object paths and handles array length changes', () => {
    expect(diffJson({ 'a/b': { '~key': [1, 2] } }, { 'a/b': { '~key': [1, 3, 4] } })).toEqual([
      { path: '/a~1b/~0key/1', kind: 'changed', baseline: 2, candidate: 3 },
      { path: '/a~1b/~0key/2', kind: 'added', candidate: 4 }
    ]);
    expect(diffJson(null, 'value')).toEqual([
      { path: '/', kind: 'type-changed', baseline: null, candidate: 'value' }
    ]);
  });
});

describe('compareTargetRuns', () => {
  it('treats explicitly ignored payload differences as equivalent', () => {
    const baseline = targetRun('baseline', {
      observations: [observation({ value: { stable: true, generated: 'one' } })]
    });
    const candidate = targetRun('candidate', {
      observations: [observation({ value: { stable: true, generated: 'two' } })]
    });

    expect(
      compareTargetRuns(baseline, candidate, {
        ignorePaths: ['/observations/*/value/generated'],
        unorderedPaths: []
      })
    ).toEqual({ baseline: 'baseline', candidate: 'candidate', equivalent: true, differences: [] });
  });

  it.each([
    [
      'timeout',
      targetRun('candidate', { observations: [observation({ status: 'timeout', value: undefined })] }),
      'timeout'
    ],
    ['lifecycle', targetRun('candidate', { status: 'connection-error', observations: [] }), 'lifecycle'],
    [
      'error semantics',
      targetRun('candidate', {
        observations: [
          observation({ status: 'error', value: undefined, error: { name: 'Error', message: 'failed' } })
        ]
      }),
      'error-semantics'
    ],
    [
      'result shape',
      targetRun('candidate', { observations: [observation({ value: { content: [] } })] }),
      'result-shape'
    ],
    ['protocol', targetRun('candidate', { protocolVersion: '2024-11-05' }), 'protocol']
  ])('infers the %s category', (_label, candidate, expectedCategory) => {
    const comparison = compareTargetRuns(targetRun('baseline'), candidate as TargetRun, noRules);

    expect(comparison.equivalent).toBe(false);
    expect(comparison.category).toBe(expectedCategory);
    expect(comparison.differences.length).toBeGreaterThan(0);
  });

  it('uses an explicit case category for semantic diffs without masking protocol failures', () => {
    const comparison = compareTargetRuns(
      targetRun('baseline'),
      targetRun('candidate', { observations: [observation({ value: { content: [] } })] }),
      noRules,
      'schema-acceptance'
    );

    expect(comparison.category).toBe('schema-acceptance');

    const protocol = compareTargetRuns(
      targetRun('baseline'),
      targetRun('candidate', { protocolVersion: '2024-11-05' }),
      noRules,
      'schema-acceptance'
    );
    expect(protocol.category).toBe('protocol');
  });

  it('classifies tools/list drift and tool isError polarity without an override', () => {
    const listBaseline = targetRun('baseline', {
      observations: [observation({ method: 'tools/list', value: { tools: [{ name: 'one' }] } })]
    });
    const listCandidate = targetRun('candidate', {
      observations: [observation({ method: 'tools/list', value: { tools: [{ name: 'two' }] } })]
    });
    expect(compareTargetRuns(listBaseline, listCandidate, noRules).category).toBe('schema-acceptance');

    const errorBaseline = targetRun('baseline', {
      observations: [observation({ value: { content: [], isError: true } })]
    });
    const errorCandidate = targetRun('candidate', {
      observations: [observation({ value: { content: [] } })]
    });
    expect(compareTargetRuns(errorBaseline, errorCandidate, noRules).category).toBe('error-semantics');
  });
});
