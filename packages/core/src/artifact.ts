import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { compareTargetRuns } from './diff.js';
import { formatValidationError, interopCaseSchema } from './schema.js';
import type { CaseRunArtifact, SuiteRunArtifact } from './types.js';

export type RunArtifact = CaseRunArtifact | SuiteRunArtifact;

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const httpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return !/[\s\u0000-\u001F\u007F]/.test(value) && ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });

const errorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.union([z.string(), z.number()]).optional(),
    data: z.json().optional()
  })
  .strict();

const observationSchema = z
  .object({
    id: z.string(),
    method: z.enum([
      'tools/list',
      'tools/call',
      'resources/list',
      'resources/read',
      'prompts/list',
      'prompts/get'
    ]),
    status: z.enum(['success', 'error', 'timeout', 'crash']),
    value: z.json().optional(),
    error: errorSchema.optional(),
    durationMs: z.number().nonnegative()
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.status === 'success') {
      if (observation.value === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['value'],
          message: 'is required for a successful observation'
        });
      }
      if (observation.error !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['error'],
          message: 'must be absent for a successful observation'
        });
      }
      return;
    }
    if (observation.value !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'must be absent for an unsuccessful observation'
      });
    }
    if (observation.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'is required for an unsuccessful observation'
      });
    }
  });

const transcriptSchema = z
  .object({
    sequence: z.number().int().positive(),
    method: z.string(),
    url: httpUrl,
    requestHeaders: z.record(z.string(), z.string()),
    requestBody: z.string().optional(),
    responseStatus: z.number().int().min(100).max(599).optional(),
    responseHeaders: z.record(z.string(), z.string()).optional(),
    responseBody: z.string().optional(),
    durationMs: z.number().nonnegative(),
    error: errorSchema.optional()
  })
  .strict();

const targetRunSchema = z
  .object({
    target: z.string(),
    url: httpUrl,
    status: z.enum(['completed', 'startup-error', 'connection-error', 'crash']),
    sdk: z.object({ name: z.string(), version: z.string() }).strict().optional(),
    protocolVersion: z.string().optional(),
    initialization: z
      .object({
        capabilities: z.json(),
        instructions: z.string().optional()
      })
      .strict()
      .optional(),
    observations: z.array(observationSchema),
    transcript: z.array(transcriptSchema),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().nonnegative(),
    error: errorSchema.optional()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.status === 'completed' && run.error !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'must be absent for a completed target run'
      });
    }
    if (run.status !== 'completed' && run.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'is required for a non-completed target run'
      });
    }
  });

const diffEntrySchema = z
  .object({
    path: z.string().startsWith('/'),
    kind: z.enum(['added', 'removed', 'changed', 'type-changed']),
    baseline: z.json().optional(),
    candidate: z.json().optional()
  })
  .strict();

const comparisonSchema = z
  .object({
    baseline: z.string(),
    candidate: z.string(),
    equivalent: z.boolean(),
    category: z
      .enum(['protocol', 'schema-acceptance', 'result-shape', 'error-semantics', 'lifecycle', 'timeout'])
      .optional(),
    differences: z.array(diffEntrySchema)
  })
  .strict();

export const caseRunArtifactSchema: z.ZodType<CaseRunArtifact> = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('mcp-interlab-case-run'),
    id: z.string().min(1),
    startedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    case: interopCaseSchema,
    targetInfo: z.record(
      z.string(),
      z
        .object({
          url: httpUrl,
          managed: z.boolean(),
          httpRecorded: z.boolean(),
          envKeys: z.array(z.string())
        })
        .strict()
    ),
    runs: z.array(targetRunSchema).min(2),
    comparisons: z.array(comparisonSchema).min(1)
  })
  .strict()
  .superRefine((artifact, context) => {
    const runNames = artifact.runs.map((run) => run.target);
    if (new Set(runNames).size !== runNames.length) {
      context.addIssue({ code: 'custom', path: ['runs'], message: 'target names must be unique' });
    }
    const infoNames = Object.keys(artifact.targetInfo).sort();
    if (JSON.stringify([...runNames].sort()) !== JSON.stringify(infoNames)) {
      context.addIssue({
        code: 'custom',
        path: ['targetInfo'],
        message: 'must describe exactly the target runs'
      });
    }

    for (const [runIndex, run] of artifact.runs.entries()) {
      const sequences = run.transcript.map((entry) => entry.sequence);
      const expectedSequences = sequences.map((_value, index) => index + 1);
      if (JSON.stringify(sequences) !== JSON.stringify(expectedSequences)) {
        context.addIssue({
          code: 'custom',
          path: ['runs', runIndex, 'transcript'],
          message: 'sequence numbers must be contiguous and ordered from one'
        });
      }
      if (run.observations.length > artifact.case.operations.length) {
        context.addIssue({
          code: 'custom',
          path: ['runs', runIndex, 'observations'],
          message: 'cannot contain more observations than case operations'
        });
      }
      for (const [observationIndex, observation] of run.observations.entries()) {
        const operation = artifact.case.operations[observationIndex];
        if (!operation || operation.id !== observation.id || operation.method !== observation.method) {
          context.addIssue({
            code: 'custom',
            path: ['runs', runIndex, 'observations', observationIndex],
            message: 'must align with the case operation at the same index'
          });
        }
      }
      if (run.status === 'completed' && run.observations.length !== artifact.case.operations.length) {
        context.addIssue({
          code: 'custom',
          path: ['runs', runIndex, 'observations'],
          message: 'a completed run must contain every case operation'
        });
      }
    }

    const expectedComparisons = artifact.runs.slice(1).map((run) => ({
      baseline: artifact.runs[0]?.target,
      candidate: run.target
    }));
    if (artifact.comparisons.length !== expectedComparisons.length) {
      context.addIssue({
        code: 'custom',
        path: ['comparisons'],
        message: 'must contain one baseline comparison for every candidate run'
      });
    }
    for (const [index, comparison] of artifact.comparisons.entries()) {
      const expected = expectedComparisons[index];
      if (
        !expected ||
        comparison.baseline !== expected.baseline ||
        comparison.candidate !== expected.candidate
      ) {
        context.addIssue({
          code: 'custom',
          path: ['comparisons', index],
          message: 'must reference the first run as baseline and the corresponding candidate run'
        });
      }
      if (comparison.equivalent !== (comparison.differences.length === 0)) {
        context.addIssue({
          code: 'custom',
          path: ['comparisons', index, 'equivalent'],
          message: 'must agree with whether differences are empty'
        });
      }
      if (comparison.equivalent === (comparison.category !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['comparisons', index, 'category'],
          message: 'must be absent for equivalent runs and present for divergent runs'
        });
      }
      const baselineRun = artifact.runs[0];
      const candidateRun = artifact.runs[index + 1];
      if (baselineRun && candidateRun) {
        const recomputed = compareTargetRuns(
          baselineRun,
          candidateRun,
          artifact.case.compare,
          artifact.case.category
        );
        if (!isDeepStrictEqual(comparison, recomputed)) {
          context.addIssue({
            code: 'custom',
            path: ['comparisons', index],
            message: 'must match the comparison recomputed from the target runs'
          });
        }
      }
    }
  });

export const suiteRunArtifactSchema: z.ZodType<SuiteRunArtifact> = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('mcp-interlab-suite-run'),
    id: z.string().min(1),
    startedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    source: z
      .object({
        matrixPath: z.string().min(1),
        matrixSha256: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
      .optional(),
    cases: z.array(caseRunArtifactSchema).min(1),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        equivalent: z.number().int().nonnegative(),
        divergent: z.number().int().nonnegative(),
        harnessErrors: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()
  .superRefine((artifact, context) => {
    const caseIds = artifact.cases.map((entry) => entry.case.id);
    if (new Set(caseIds).size !== caseIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['cases'],
        message: 'case ids must be unique within a suite'
      });
    }
    const divergent = artifact.cases.filter((entry) =>
      entry.comparisons.some((comparison) => !comparison.equivalent)
    ).length;
    const harnessErrors = artifact.cases.filter((entry) =>
      entry.runs.some((run) => run.status !== 'completed')
    ).length;
    const expected = {
      total: artifact.cases.length,
      equivalent: artifact.cases.length - divergent,
      divergent,
      harnessErrors
    };
    for (const key of ['total', 'equivalent', 'divergent', 'harnessErrors'] as const) {
      if (artifact.summary[key] !== expected[key]) {
        context.addIssue({
          code: 'custom',
          path: ['summary', key],
          message: `must equal recomputed value ${expected[key]}`
        });
      }
    }
  });

const runArtifactSchema = z.union([caseRunArtifactSchema, suiteRunArtifactSchema]);

export async function readRunArtifact(path: string): Promise<RunArtifact> {
  const metadata = await stat(path);
  if (metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`${path} exceeds the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MiB artifact limit`);
  }
  const content = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = runArtifactSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid MCP Interlab artifact ${path}:\n${formatValidationError(result.error)}`);
  }
  return result.data;
}

export async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact exceeds the ${MAX_ARTIFACT_BYTES / 1024 / 1024} MiB limit; reduce captured output`
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
