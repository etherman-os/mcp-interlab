import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, loadCase, loadMatrix } from '../src/config.js';
import { formatValidationError, interopCaseSchema, matrixSchema } from '../src/schema.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-interlab-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function rawCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'search-regression',
    title: 'Search regression',
    operations: [
      {
        id: 'search',
        method: 'tools/call',
        params: { name: 'search' }
      }
    ],
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('interopCaseSchema', () => {
  it('applies conservative defaults to a minimal case and tool call', () => {
    const parsed = interopCaseSchema.parse(rawCase());

    expect(parsed).toMatchObject({
      expectation: 'differential',
      tags: [],
      sources: [],
      compare: { ignorePaths: [], unorderedPaths: [] }
    });
    expect(parsed.operations[0]).toEqual({
      id: 'search',
      method: 'tools/call',
      params: { name: 'search', arguments: {} }
    });
  });

  it('rejects duplicate operation ids with a useful path', () => {
    const result = interopCaseSchema.safeParse(
      rawCase({
        operations: [
          { id: 'same', method: 'tools/list' },
          { id: 'same', method: 'resources/list' }
        ]
      })
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatValidationError(result.error)).toContain("operations: operation id 'same' is duplicated");
    }
  });

  it.each([
    ['invalid identifier', rawCase({ id: 'spaces are invalid' })],
    ['empty operations', rawCase({ operations: [] })],
    ['relative ignore pointer', rawCase({ compare: { ignorePaths: ['timestamp'], unorderedPaths: [] } })],
    ['unknown field', { ...rawCase(), surprise: true }],
    [
      'a source URL containing raw whitespace',
      rawCase({ sources: [{ url: 'https://example.test/path\n\n# injected' }] })
    ],
    ['unknown operation field', rawCase({ operations: [{ id: 'list', method: 'tools/list', params: {} }] })]
  ])('rejects %s', (_label, input) => {
    expect(interopCaseSchema.safeParse(input).success).toBe(false);
  });
});

describe('matrixSchema', () => {
  it('requires two targets and fills target defaults', () => {
    const parsed = matrixSchema.parse({
      version: 1,
      targets: {
        baseline: { url: 'http://127.0.0.1:4001/mcp' },
        candidate: { url: 'http://127.0.0.1:4002/mcp' }
      },
      cases: [rawCase()]
    });

    expect(parsed.targets.baseline).toEqual({
      url: 'http://127.0.0.1:4001/mcp',
      args: [],
      env: {},
      inheritEnv: [],
      recordHttp: false,
      maxResponseBytes: 4 * 1024 * 1024,
      startupTimeoutMs: 10_000,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 2_000
    });
  });

  it.each([
    [
      'one target',
      {
        version: 1,
        targets: { only: { url: 'http://127.0.0.1:4001/mcp' } },
        cases: [rawCase()]
      }
    ],
    [
      'an invalid URL',
      {
        version: 1,
        targets: { a: { url: 'not-a-url' }, b: { url: 'http://127.0.0.1:4002/mcp' } },
        cases: [rawCase()]
      }
    ],
    [
      'a non-HTTP target URL',
      {
        version: 1,
        targets: { a: { url: 'file:///etc/passwd' }, b: { url: 'http://127.0.0.1:4002/mcp' } },
        cases: [rawCase()]
      }
    ],
    [
      'an empty case list',
      {
        version: 1,
        targets: { a: { url: 'http://127.0.0.1:4001/mcp' }, b: { url: 'http://127.0.0.1:4002/mcp' } },
        cases: []
      }
    ]
  ])('rejects %s', (_label, input) => {
    expect(matrixSchema.safeParse(input).success).toBe(false);
  });
});

describe('configuration loading', () => {
  it('loads JSON cases and reports validation failures with their absolute path', async () => {
    const directory = await temporaryDirectory();
    const validPath = join(directory, 'case.json');
    const invalidPath = join(directory, 'invalid.json');
    await writeFile(validPath, JSON.stringify(rawCase()), 'utf8');
    await writeFile(invalidPath, JSON.stringify(rawCase({ operations: [] })), 'utf8');

    await expect(loadCase(validPath)).resolves.toMatchObject({
      id: 'search-regression',
      expectation: 'differential'
    });
    await expect(loadCase(invalidPath)).rejects.toThrow(
      new RegExp(`Invalid case ${invalidPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    );
    await expect(loadCase(invalidPath)).rejects.toThrow('operations: Too small');
  });

  it('distinguishes unreadable and malformed configuration files', async () => {
    const directory = await temporaryDirectory();
    const malformedPath = join(directory, 'malformed.yml');
    await writeFile(malformedPath, 'version: [', 'utf8');

    await expect(loadCase(join(directory, 'missing.yml'))).rejects.toThrow(ConfigError);
    await expect(loadCase(join(directory, 'missing.yml'))).rejects.toThrow('Cannot read');
    await expect(loadCase(malformedPath)).rejects.toThrow('Cannot parse');
  });

  it('resolves case paths and target working directories relative to the matrix', async () => {
    const directory = await temporaryDirectory();
    const casePath = join(directory, 'case.json');
    const matrixPath = join(directory, 'matrix.json');
    const matrixSource = JSON.stringify({
      version: 1,
      targets: {
        baseline: {
          command: 'node',
          cwd: './servers',
          url: 'http://127.0.0.1:4101/mcp'
        },
        candidate: {
          cwd: resolve(directory, 'absolute-server'),
          url: 'http://127.0.0.1:4102/mcp'
        }
      },
      cases: ['./case.json', rawCase({ id: 'inline-case' })]
    });
    await writeFile(casePath, JSON.stringify(rawCase()), 'utf8');
    await writeFile(matrixPath, matrixSource, 'utf8');

    const loaded = await loadMatrix(matrixPath);

    expect(loaded.path).toBe(matrixPath);
    expect(loaded.directory).toBe(directory);
    expect(isAbsolute(loaded.config.targets.baseline?.cwd ?? '')).toBe(true);
    expect(loaded.config.targets.baseline?.cwd).toBe(join(directory, 'servers'));
    expect(loaded.config.targets.candidate?.cwd).toBe(resolve(directory, 'absolute-server'));
    expect(loaded.cases.map((entry) => entry.id)).toEqual(['search-regression', 'inline-case']);
    expect(loaded.sha256).toBe(createHash('sha256').update(matrixSource).digest('hex'));
  });
});
