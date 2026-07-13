import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { parse as parseYaml } from 'yaml';

import { formatValidationError, interopCaseSchema, matrixSchema } from './schema.js';
import type { InteropCase, MatrixConfig, TargetConfig } from './types.js';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

async function parseDataFile(path: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return path.endsWith('.json') ? JSON.parse(source) : parseYaml(source);
  } catch (error) {
    throw new ConfigError(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const source = await readFile(path);
  return createHash('sha256').update(source).digest('hex');
}

export async function loadCase(path: string): Promise<InteropCase> {
  const absolutePath = resolve(path);
  const result = interopCaseSchema.safeParse(await parseDataFile(absolutePath));
  if (!result.success) {
    throw new ConfigError(`Invalid case ${absolutePath}:\n${formatValidationError(result.error)}`);
  }
  return result.data;
}

export interface LoadedMatrix {
  path: string;
  sha256: string;
  directory: string;
  config: MatrixConfig;
  cases: InteropCase[];
}

export async function loadMatrix(path: string): Promise<LoadedMatrix> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const result = matrixSchema.safeParse(await parseDataFile(absolutePath));
  if (!result.success) {
    throw new ConfigError(`Invalid matrix ${absolutePath}:\n${formatValidationError(result.error)}`);
  }

  const config = result.data;
  const resolvedTargets = Object.fromEntries(
    Object.entries(config.targets).map(([name, target]) => [
      name,
      {
        ...target,
        ...(target.cwd ? { cwd: isAbsolute(target.cwd) ? target.cwd : resolve(directory, target.cwd) } : {})
      } satisfies TargetConfig
    ])
  );

  const cases = await Promise.all(
    config.cases.map((entry) =>
      typeof entry === 'string' ? loadCase(isAbsolute(entry) ? entry : resolve(directory, entry)) : entry
    )
  );

  return {
    path: absolutePath,
    sha256: await sha256File(absolutePath),
    directory,
    config: { ...config, targets: resolvedTargets },
    cases
  };
}
