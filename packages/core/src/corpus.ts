import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadCase } from './config.js';
import type { InteropCase } from './types.js';

export interface CorpusEntry {
  path: string;
  case?: InteropCase;
  error?: string;
}

async function yamlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return yamlFiles(path);
      return /\.ya?ml$/i.test(entry.name) && !/^matrix\./i.test(entry.name) ? [path] : [];
    })
  );
  return nested.flat().sort();
}

export async function listCorpus(directory: string): Promise<CorpusEntry[]> {
  const files = await yamlFiles(resolve(directory));
  return Promise.all(
    files.map(async (path) => {
      try {
        return { path, case: await loadCase(path) };
      } catch (error) {
        return { path, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}
