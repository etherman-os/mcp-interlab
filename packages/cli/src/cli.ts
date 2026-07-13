#!/usr/bin/env node

import { access, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  listCorpus,
  loadMatrix,
  minimizeFailure,
  readRunArtifact,
  renderSuiteMarkdown,
  renderSuiteTerminal,
  runMatrix,
  stopAllManagedTargets,
  writeJsonArtifact,
  type CaseRunArtifact,
  type SuiteRunArtifact
} from '@mcp-interlab/core';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { stringify as stringifyYaml } from 'yaml';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = packageJson.version;
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();

function invocationPath(path: string): string {
  return resolve(invocationDirectory, path);
}

let terminating = false;
for (const [signal, exitCode] of [
  ['SIGINT', 130],
  ['SIGTERM', 143]
] as const) {
  process.once(signal, () => {
    if (terminating) return;
    terminating = true;
    void stopAllManagedTargets().finally(() => process.exit(exitCode));
  });
}

function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new InvalidArgumentError('must be a positive integer');
  return parsed;
}

function asSuite(artifact: CaseRunArtifact): SuiteRunArtifact {
  const divergent = artifact.comparisons.some((comparison) => !comparison.equivalent) ? 1 : 0;
  const harnessErrors = artifact.runs.some((run) => run.status !== 'completed') ? 1 : 0;
  return {
    schemaVersion: 1,
    kind: 'mcp-interlab-suite-run',
    id: artifact.id,
    startedAt: artifact.startedAt,
    durationMs: artifact.durationMs,
    cases: [artifact],
    summary: { total: 1, equivalent: 1 - divergent, divergent, harnessErrors }
  };
}

function printArtifact(artifact: SuiteRunArtifact, format: string): void {
  if (format === 'json') console.log(JSON.stringify(artifact, null, 2));
  else if (format === 'markdown') console.log(renderSuiteMarkdown(artifact));
  else console.log(renderSuiteTerminal(artifact));
}

async function runCommand(
  matrixPath: string,
  options: { case?: string; format: string; output?: string }
): Promise<void> {
  const loaded = await loadMatrix(invocationPath(matrixPath));
  const artifact = await runMatrix(
    loaded.config,
    loaded.cases,
    { matrixPath: loaded.path, matrixSha256: loaded.sha256 },
    options.case ? { caseId: options.case } : {}
  );
  const output = invocationPath(
    options.output ?? `results/run-${timestamp()}-${artifact.id.slice(0, 8)}.json`
  );
  if (artifact.source) artifact.source.matrixPath = relative(dirname(output), loaded.path);
  await writeJsonArtifact(output, artifact);
  printArtifact(artifact, options.format);
  console.error(`\nArtifact: ${output}`);
  process.exitCode = artifact.summary.harnessErrors > 0 ? 2 : artifact.summary.divergent > 0 ? 1 : 0;
}

async function reportCommand(path: string, options: { format: string }): Promise<void> {
  const artifact = await readRunArtifact(invocationPath(path));
  const suite = artifact.kind === 'mcp-interlab-suite-run' ? artifact : asSuite(artifact);
  printArtifact(suite, options.format);
}

async function minimizeCommand(
  path: string,
  options: {
    case?: string;
    matrix: string;
    allowMatrixChange?: boolean;
    output?: string;
    maxAttempts: number;
  }
): Promise<void> {
  const artifactPath = invocationPath(path);
  const artifact = await readRunArtifact(artifactPath);
  const source = artifact.kind === 'mcp-interlab-suite-run' ? artifact.source : undefined;
  const matrixPath = invocationPath(options.matrix);
  const matrix = await loadMatrix(matrixPath);
  if (source && source.matrixSha256 !== matrix.sha256 && !options.allowMatrixChange) {
    throw new ConfigError(
      `Selected matrix does not match the run checksum (${source.matrixSha256.slice(0, 12)} != ${matrix.sha256.slice(0, 12)}); rerun the case or pass --allow-matrix-change after reviewing it`
    );
  }

  const cases = artifact.kind === 'mcp-interlab-suite-run' ? artifact.cases : [artifact];
  const failure = options.case
    ? cases.find((entry) => entry.case.id === options.case)
    : cases.find((entry) => entry.comparisons.some((comparison) => !comparison.equivalent));
  if (!failure)
    throw new ConfigError(
      options.case ? `Divergent case '${options.case}' not found` : 'No divergent case found'
    );

  console.error(`Minimizing ${failure.case.id} across fresh target processes…`);
  const result = await minimizeFailure(failure, matrix.config.targets, {
    maxAttempts: options.maxAttempts,
    onAttempt(attempt, executions) {
      const marker = attempt.preserved ? '✓' : '·';
      console.error(`${marker} [${executions}/${options.maxAttempts}] ${attempt.description}`);
    }
  });

  const defaultBase = resolve(
    dirname(artifactPath),
    `${basename(artifactPath, extname(artifactPath))}.min.yml`
  );
  const output = options.output ? invocationPath(options.output) : defaultBase;
  await writeFile(output, stringifyYaml(result.minimizedCase, { lineWidth: 100 }), 'utf8');
  await writeJsonArtifact(`${output}.history.json`, result);
  console.log(`Minimal reproducer: ${output}`);
  console.log(
    `Operations: ${result.originalCase.operations.length} → ${result.minimizedCase.operations.length}`
  );
  console.log(`Predicate executions: ${result.executions}`);
  if (!result.complete)
    console.log('Stopped at the evaluation budget; this is the smallest result found, not proven minimal.');
}

async function corpusCommand(options: { dir?: string; json?: boolean }): Promise<void> {
  let directory: string;
  if (options.dir) {
    directory = invocationPath(options.dir);
  } else {
    const localCorpus = invocationPath('corpus');
    try {
      await access(localCorpus);
      directory = localCorpus;
    } catch {
      directory = fileURLToPath(new URL('./corpus', import.meta.url));
    }
  }
  const entries = await listCorpus(directory);
  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  for (const entry of entries) {
    if (entry.case)
      console.log(`${entry.case.id.padEnd(36)} ${entry.case.expectation.padEnd(12)} ${entry.case.title}`);
    else console.log(`INVALID ${entry.path}\n  ${entry.error}`);
  }
  const invalid = entries.filter((entry) => entry.error).length;
  console.log(`\n${entries.length} case(s), ${invalid} invalid`);
  if (invalid > 0) process.exitCode = 2;
}

const program = new Command()
  .name('mcp-interlab')
  .description('Find and minimize behavioral differences across MCP implementations')
  .version(VERSION)
  .showHelpAfterError()
  .exitOverride();

program
  .command('run')
  .description('Run a differential target matrix')
  .argument('<matrix>', 'matrix YAML or JSON file')
  .option('--case <id>', 'run one corpus case')
  .addOption(
    new Option('--format <format>', 'terminal output format')
      .choices(['terminal', 'json', 'markdown'])
      .default('terminal')
  )
  .option('-o, --output <path>', 'JSON artifact output path')
  .action(runCommand);

program
  .command('report')
  .description('Render an existing run artifact')
  .argument('<artifact>', 'run artifact JSON file')
  .addOption(
    new Option('--format <format>', 'report format')
      .choices(['terminal', 'json', 'markdown'])
      .default('markdown')
  )
  .action(reportCommand);

program
  .command('minimize')
  .description('Reduce a divergent session while preserving its failure class')
  .argument('<artifact>', 'run artifact JSON file')
  .option('--case <id>', 'select a divergent case from a suite')
  .requiredOption('--matrix <path>', 'trusted local matrix whose target commands may be executed')
  .option('--allow-matrix-change', 'accept a reviewed matrix whose checksum differs from the run')
  .option('-o, --output <path>', 'minimized YAML output path')
  .option('--max-attempts <number>', 'predicate evaluation budget', parsePositiveInteger, 100)
  .action(minimizeCommand);

program
  .command('corpus')
  .description('Inspect the local regression corpus')
  .argument('[action]', 'action to perform', 'list')
  .option('--dir <path>', 'corpus directory; defaults to ./corpus or the bundled corpus')
  .option('--json', 'emit machine-readable output')
  .action(async (action: string, options: { dir?: string; json?: boolean }) => {
    if (action !== 'list') throw new ConfigError(`Unknown corpus action '${action}'`);
    await corpusCommand(options);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : 2;
  } else {
    const prefix = error instanceof ConfigError ? 'Configuration error' : 'Error';
    console.error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
