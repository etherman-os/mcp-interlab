import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = resolve(repository, 'node_modules/.bin/tsx');
const cli = resolve(repository, 'packages/cli/src/cli.ts');
const referenceServer = resolve(repository, 'examples/servers/reference-server.mjs');
let directory: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(tsx, [cli, ...args], {
      cwd: repository,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 20_000
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? failed.message
    };
  }
}

function matrix(profile: string, firstPort: number, secondPort: number): string {
  return `
version: 1
targets:
  baseline:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(referenceServer)}, --port, "${firstPort}", --profile, baseline]
    url: http://127.0.0.1:${firstPort}/mcp
  candidate:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(referenceServer)}, --port, "${secondPort}", --profile, ${profile}]
    url: http://127.0.0.1:${secondPort}/mcp
cases:
  - version: 1
    id: cli-search
    title: CLI search
    expectation: regression
    tags: [cli]
    category: result-shape
    sources: []
    operations:
      - id: search
        method: tools/call
        params: { name: search, arguments: { query: mcp, limit: 1 } }
    compare: { ignorePaths: [], unorderedPaths: [] }
`;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mcp-interlab-cli-test-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('CLI process contract', () => {
  it('uses exit 0 for equivalence, 1 for divergence, and 2 for harness/config errors', async () => {
    const equivalentMatrix = join(directory, 'equivalent.yml');
    const divergentMatrix = join(directory, 'divergent.yml');
    const brokenMatrix = join(directory, 'broken.yml');
    const equivalentArtifact = join(directory, 'equivalent.json');
    const divergentArtifact = join(directory, 'divergent.json');
    const ports = await Promise.all(Array.from({ length: 6 }, () => freePort()));
    await writeFile(equivalentMatrix, matrix('baseline', ports[0]!, ports[1]!), 'utf8');
    await writeFile(divergentMatrix, matrix('candidate', ports[2]!, ports[3]!), 'utf8');
    await writeFile(
      brokenMatrix,
      `
version: 1
targets:
  one: { command: __missing_interlab_one__, url: http://127.0.0.1:${ports[4]}/mcp, startupTimeoutMs: 200 }
  two: { command: __missing_interlab_two__, url: http://127.0.0.1:${ports[5]}/mcp, startupTimeoutMs: 200 }
cases:
  - version: 1
    id: broken
    title: Broken
    operations: [{ id: list, method: tools/list }]
`,
      'utf8'
    );

    const equivalent = await runCli(['run', equivalentMatrix, '--output', equivalentArtifact]);
    const divergent = await runCli(['run', divergentMatrix, '--output', divergentArtifact]);
    const broken = await runCli(['run', brokenMatrix, '--output', join(directory, 'broken.json')]);

    expect(equivalent.code).toBe(0);
    expect(equivalent.stdout).toContain('1 equivalent, 0 divergent');
    expect(divergent.code).toBe(1);
    expect(divergent.stdout).toContain('REGRESSION FOUND');
    expect(broken.code).toBe(2);
    expect(broken.stdout).toContain('1 harness error(s)');
    expect(JSON.parse(await readFile(divergentArtifact, 'utf8'))).toMatchObject({
      kind: 'mcp-interlab-suite-run',
      summary: { divergent: 1, harnessErrors: 0 }
    });

    const report = await runCli(['report', divergentArtifact, '--format', 'markdown']);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('# MCP Interlab report');

    const untrustedMinimize = await runCli(['minimize', divergentArtifact]);
    expect(untrustedMinimize.code).toBe(2);
    expect(untrustedMinimize.stderr).toContain("required option '--matrix <path>' not specified");
  });

  it('lists the bundled source corpus and rejects invalid usage with exit 2', async () => {
    const corpus = await runCli(['corpus', 'list', '--dir', resolve(repository, 'corpus')]);
    const invalid = await runCli(['corpus', 'unknown']);
    expect(corpus.code).toBe(0);
    expect(corpus.stdout).toContain('10 case(s), 0 invalid');
    expect(invalid.code).toBe(2);
  });
});
