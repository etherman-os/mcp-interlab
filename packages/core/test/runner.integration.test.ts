import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCase, runMatrix } from '../src/runner.js';
import type { InteropCase, MatrixConfig, TargetConfig } from '../src/types.js';

const referenceServer = fileURLToPath(
  new URL('../../../examples/servers/reference-server.mjs', import.meta.url)
);

async function reservePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected an allocated TCP port');
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      )
    );
  }
}

async function expectPortsReusable(ports: number[]): Promise<void> {
  const servers: Server[] = [];
  try {
    for (const port of ports) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    }
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      )
    );
  }
}

function target(port: number, profile: string): TargetConfig {
  return {
    command: process.execPath,
    args: [referenceServer, '--port', String(port), '--profile', profile],
    url: `http://127.0.0.1:${port}/mcp`,
    env: { PROFILE_FROM_TEST: profile, Z_LAST: 'last', A_FIRST: 'first' },
    inheritEnv: [],
    recordHttp: true,
    maxResponseBytes: 4 * 1024 * 1024,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 3_000,
    shutdownTimeoutMs: 1_000
  };
}

function interopCase(id: string, operation: InteropCase['operations'][number]): InteropCase {
  return {
    version: 1,
    id,
    title: id,
    expectation: 'regression',
    tags: ['integration'],
    category: 'result-shape',
    sources: [],
    operations: [operation],
    compare: { ignorePaths: [], unorderedPaths: [] }
  };
}

describe('runner with the reference Streamable HTTP server', () => {
  it('executes the same case concurrently, captures target metadata, diffs results, and cleans up', async () => {
    const ports = await reservePorts(2);
    const targets = {
      baseline: target(ports[0] as number, 'baseline'),
      candidate: target(ports[1] as number, 'candidate')
    };
    const testCase: InteropCase = {
      ...interopCase('search-regression', {
        id: 'search',
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'typescript', limit: 1 } }
      }),
      operations: [
        { id: 'discover', method: 'tools/list' },
        {
          id: 'search',
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'typescript', limit: 1 } }
        }
      ]
    };

    const artifact = await runCase(targets, testCase);

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: 'mcp-interlab-case-run',
      case: testCase,
      targetInfo: {
        baseline: {
          url: targets.baseline.url,
          managed: true,
          envKeys: ['A_FIRST', 'PROFILE_FROM_TEST', 'Z_LAST']
        },
        candidate: {
          url: targets.candidate.url,
          managed: true,
          envKeys: ['A_FIRST', 'PROFILE_FROM_TEST', 'Z_LAST']
        }
      }
    });
    expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(Number.isNaN(Date.parse(artifact.startedAt))).toBe(false);
    expect(artifact.durationMs).toBeGreaterThan(0);
    expect(artifact.runs.map((run) => run.target)).toEqual(['baseline', 'candidate']);
    expect(artifact.runs.every((run) => run.status === 'completed')).toBe(true);
    expect(artifact.runs.every((run) => run.observations.every((item) => item.status === 'success'))).toBe(
      true
    );
    expect(artifact.runs[0]?.sdk?.name).toBe('interlab-reference-baseline');
    expect(artifact.runs[1]?.sdk?.name).toBe('interlab-reference-candidate');
    expect(artifact.runs.every((run) => typeof run.protocolVersion === 'string')).toBe(true);
    expect(artifact.runs[0]?.stdout).toContain('reference baseline listening');
    expect(artifact.runs[1]?.stdout).toContain('reference candidate listening');
    for (const run of artifact.runs) {
      expect(run.transcript.length).toBeGreaterThanOrEqual(4);
      expect(run.transcript.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: run.transcript.length }, (_value, index) => index + 1)
      );
      expect(run.transcript.some((entry) => entry.requestBody?.includes('"method":"initialize"'))).toBe(true);
      expect(run.transcript.some((entry) => entry.requestBody?.includes('"method":"tools/call"'))).toBe(true);
      expect(run.transcript.some((entry) => entry.method === 'DELETE')).toBe(true);
      expect(
        run.transcript
          .filter((entry) => 'mcp-session-id' in entry.requestHeaders)
          .every((entry) => entry.requestHeaders['mcp-session-id'] === '[REDACTED]')
      ).toBe(true);
    }
    expect(artifact.comparisons).toHaveLength(1);
    expect(artifact.comparisons[0]).toMatchObject({
      baseline: 'baseline',
      candidate: 'candidate',
      equivalent: false,
      category: 'result-shape'
    });
    expect(
      artifact.comparisons[0]?.differences.some((entry) => entry.path.includes('/observations/1/value'))
    ).toBe(true);

    await expectPortsReusable(ports);
  });

  it('summarizes equivalent and divergent cases and supports case selection', async () => {
    const ports = await reservePorts(2);
    const targets = {
      baseline: target(ports[0] as number, 'baseline'),
      candidate: target(ports[1] as number, 'candidate')
    };
    const echo = interopCase('echo-equivalent', {
      id: 'echo',
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'same' } }
    });
    const search = interopCase('search-divergent', {
      id: 'search',
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'mcp', limit: 1 } }
    });
    const config: MatrixConfig = { version: 1, targets, cases: [echo, search] };

    const suite = await runMatrix(config, [echo, search], {
      matrixPath: '/fixtures/matrix.yml',
      matrixSha256: 'abc123'
    });

    expect(suite.source).toEqual({ matrixPath: '/fixtures/matrix.yml', matrixSha256: 'abc123' });
    expect(suite.cases.map((entry) => entry.case.id)).toEqual(['echo-equivalent', 'search-divergent']);
    expect(suite.summary).toEqual({ total: 2, equivalent: 1, divergent: 1, harnessErrors: 0 });

    const selected = await runMatrix(config, [echo, search], undefined, { caseId: 'echo-equivalent' });
    expect(selected.cases).toHaveLength(1);
    expect(selected.summary).toEqual({ total: 1, equivalent: 1, divergent: 0, harnessErrors: 0 });
    await expect(runMatrix(config, [echo, search], undefined, { caseId: 'missing' })).rejects.toThrow(
      "Case 'missing' was not found"
    );

    await expectPortsReusable(ports);
  });

  it('validates target selection before starting any process', async () => {
    const ports = await reservePorts(2);
    const targets = {
      baseline: target(ports[0] as number, 'baseline'),
      candidate: target(ports[1] as number, 'candidate')
    };
    const echo = interopCase('echo', {
      id: 'echo',
      method: 'tools/call',
      params: { name: 'echo', arguments: { value: 'same' } }
    });

    await expect(runCase(targets, echo, { targetNames: ['baseline'] })).rejects.toThrow(
      'Differential execution requires at least two targets'
    );
    await expect(runCase(targets, echo, { targetNames: ['baseline', 'missing'] })).rejects.toThrow(
      "Unknown target 'missing'"
    );
    await expectPortsReusable(ports);
  });

  it('marks a target that exits after its final response as crashed', async () => {
    const ports = await reservePorts(2);
    const targets = {
      baseline: target(ports[0] as number, 'baseline'),
      candidate: target(ports[1] as number, 'crash-after-call')
    };
    const search = interopCase('late-process-crash', {
      id: 'search',
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'mcp', limit: 1 } }
    });

    const artifact = await runCase(targets, search);

    expect(artifact.runs[0]?.status).toBe('completed');
    expect(artifact.runs[1]?.status).toBe('crash');
    expect(artifact.runs[1]?.error?.message).toContain('code 7');
    expect(artifact.comparisons[0]?.category).toBe('lifecycle');
    await expectPortsReusable(ports);
  });
});
