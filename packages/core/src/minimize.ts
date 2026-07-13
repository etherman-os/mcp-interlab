import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

import { runCase } from './runner.js';
import type {
  CallToolOperation,
  CaseRunArtifact,
  DifferenceCategory,
  InteropCase,
  JsonValue,
  MinimizedArtifact,
  MinimizationAttempt,
  TargetComparison
} from './types.js';
import type { TargetConfig } from './types.js';

export interface MinimizeOptions {
  maxAttempts?: number;
  onAttempt?: (attempt: MinimizationAttempt, executions: number) => void;
}

function divergentComparison(artifact: CaseRunArtifact): TargetComparison {
  const comparison = artifact.comparisons.find((item) => !item.equivalent);
  if (!comparison || !comparison.category)
    throw new Error('Artifact does not contain a divergent comparison');
  return comparison;
}

function cloneCase(testCase: InteropCase): InteropCase {
  return structuredClone(testCase);
}

function statusSignature(artifact: CaseRunArtifact, operationIds: Set<string>): string {
  return artifact.runs
    .map((run) =>
      run.observations
        .filter((observation) => operationIds.has(observation.id))
        .map((observation) => `${observation.id}:${observation.status}`)
        .join(',')
    )
    .join('|');
}

interface FailureFingerprint {
  operationId: string;
  pathSuffix: string;
  kind: string;
  baselineStatus: string;
  candidateStatus: string;
}

function failureFingerprint(artifact: CaseRunArtifact, comparison: TargetComparison): FailureFingerprint {
  const baselineRun = artifact.runs.find((run) => run.target === comparison.baseline);
  const candidateRun = artifact.runs.find((run) => run.target === comparison.candidate);
  if (!baselineRun || !candidateRun) throw new Error('Failure target runs are missing from the artifact');

  for (const difference of comparison.differences) {
    const match = /^\/observations\/(\d+)(.*)$/.exec(difference.path);
    if (!match) continue;
    const index = Number(match[1]);
    const baselineObservation = baselineRun.observations[index];
    const candidateObservation = candidateRun.observations[index];
    if (!baselineObservation || !candidateObservation || baselineObservation.id !== candidateObservation.id)
      continue;
    return {
      operationId: baselineObservation.id,
      pathSuffix: match[2] || '/',
      kind: difference.kind,
      baselineStatus: baselineObservation.status,
      candidateStatus: candidateObservation.status
    };
  }
  throw new Error('Divergence has no operation-level difference to minimize');
}

function preservesFingerprint(
  artifact: CaseRunArtifact,
  comparison: TargetComparison,
  fingerprint: FailureFingerprint
): boolean {
  const baselineRun = artifact.runs.find((run) => run.target === comparison.baseline);
  const candidateRun = artifact.runs.find((run) => run.target === comparison.candidate);
  if (!baselineRun || !candidateRun) return false;
  const baselineIndex = baselineRun.observations.findIndex(
    (observation) => observation.id === fingerprint.operationId
  );
  const candidateIndex = candidateRun.observations.findIndex(
    (observation) => observation.id === fingerprint.operationId
  );
  if (baselineIndex < 0 || candidateIndex < 0 || baselineIndex !== candidateIndex) return false;
  if (
    baselineRun.observations[baselineIndex]?.status !== fingerprint.baselineStatus ||
    candidateRun.observations[candidateIndex]?.status !== fingerprint.candidateStatus
  ) {
    return false;
  }
  return comparison.differences.some((difference) => {
    const match = /^\/observations\/(\d+)(.*)$/.exec(difference.path);
    return (
      match !== null &&
      Number(match[1]) === baselineIndex &&
      (match[2] || '/') === fingerprint.pathSuffix &&
      difference.kind === fingerprint.kind
    );
  });
}

function scalarComplexity(value: string | number | boolean): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(value) * 10 + String(value).length;
}

function extractToolSchemas(artifact: CaseRunArtifact): Map<string, JsonValue> {
  const schemas = new Map<string, JsonValue>();
  const baseline = artifact.runs[0];
  if (!baseline) return schemas;
  for (const observation of baseline.observations) {
    if (observation.method !== 'tools/list' || observation.status !== 'success') continue;
    const value = observation.value as
      { tools?: Array<{ name?: unknown; inputSchema?: unknown }> } | undefined;
    for (const tool of value?.tools ?? []) {
      if (typeof tool.name === 'string' && tool.inputSchema !== undefined) {
        schemas.set(tool.name, tool.inputSchema as JsonValue);
      }
    }
  }
  return schemas;
}

function buildSchemaGuards(
  artifact: CaseRunArtifact
): Map<string, (argumentsValue: Record<string, JsonValue>) => boolean> {
  const schemas = extractToolSchemas(artifact);
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const guards = new Map<string, (argumentsValue: Record<string, JsonValue>) => boolean>();
  for (const operation of artifact.case.operations) {
    if (operation.method !== 'tools/call') continue;
    const schema = schemas.get(operation.params.name);
    if (!schema) continue;
    try {
      const validate: ValidateFunction = ajv.compile(schema as object);
      const originalValidity = validate(operation.params.arguments);
      guards.set(operation.id, (candidate) => Boolean(validate(candidate)) === originalValidity);
    } catch {
      // Some SDKs expose schemas from drafts AJV cannot compile; minimization still works without a guard.
    }
  }
  return guards;
}

async function ddmin<T>(
  items: T[],
  minimumLength: number,
  tryItems: (candidate: T[], description: string) => Promise<boolean>,
  label: string
): Promise<T[]> {
  let current = items;
  let granularity = 2;
  while (current.length > minimumLength) {
    const chunkSize = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunkSize) {
      const candidate = [...current.slice(0, start), ...current.slice(start + chunkSize)];
      if (candidate.length < minimumLength) continue;
      if (
        await tryItems(
          candidate,
          `${label}: remove items ${start}..${Math.min(start + chunkSize, current.length) - 1}`
        )
      ) {
        current = candidate;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }
  return current;
}

export async function minimizeFailure(
  original: CaseRunArtifact,
  targets: Record<string, TargetConfig>,
  options: MinimizeOptions = {}
): Promise<MinimizedArtifact> {
  const comparison = divergentComparison(original);
  const fingerprint = failureFingerprint(original, comparison);
  const category = comparison.category as DifferenceCategory;
  const targetNames = [comparison.baseline, comparison.candidate];
  const maxAttempts = options.maxAttempts ?? 100;
  if (maxAttempts < 4) throw new Error('Minimization requires an evaluation budget of at least 4');
  const attempts: MinimizationAttempt[] = [];
  const cache = new Map<string, boolean>();
  const schemaGuards = buildSchemaGuards(original);
  let executions = 0;
  let budgetExhausted = false;

  const evaluate = async (candidate: InteropCase): Promise<boolean> => {
    if (executions >= maxAttempts) {
      budgetExhausted = true;
      return false;
    }
    executions += 1;
    const rerun = await runCase(targets, candidate, { targetNames });
    const nextComparison = rerun.comparisons[0];
    const candidateIds = new Set(candidate.operations.map((operation) => operation.id));
    const originalRelevantStatus = targetNames
      .map((targetName) => {
        const run = original.runs.find((entry) => entry.target === targetName);
        if (!run) return '<missing-target>';
        return run.observations
          .filter((observation) => candidateIds.has(observation.id))
          .map((observation) => `${observation.id}:${observation.status}`)
          .join(',');
      })
      .join('|');
    return Boolean(
      nextComparison &&
      !nextComparison.equivalent &&
      nextComparison.category === category &&
      rerun.runs.every((run) => run.status === 'completed') &&
      statusSignature(rerun, candidateIds) === originalRelevantStatus &&
      preservesFingerprint(rerun, nextComparison, fingerprint)
    );
  };

  for (let verification = 1; verification <= 2; verification += 1) {
    const preserved = await evaluate(original.case);
    const attempt = { description: `preflight reproduction ${verification}/2`, preserved };
    attempts.push(attempt);
    options.onAttempt?.(attempt, executions);
    if (!preserved)
      throw new Error(
        'Original divergence is not reproducible in two fresh runs; refusing to minimize a flaky failure'
      );
  }

  const predicate = async (candidate: InteropCase, description: string): Promise<boolean> => {
    if (executions >= maxAttempts) {
      budgetExhausted = true;
      return false;
    }
    for (const operation of candidate.operations) {
      if (operation.method === 'tools/call') {
        const guard = schemaGuards.get(operation.id);
        if (guard && !guard(operation.params.arguments)) {
          const attempt = { description: `${description} (schema validity changed)`, preserved: false };
          attempts.push(attempt);
          options.onAttempt?.(attempt, executions);
          return false;
        }
      }
    }
    const key = JSON.stringify(candidate);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const preserved = await evaluate(candidate);
    cache.set(key, preserved);
    const attempt = { description, preserved };
    attempts.push(attempt);
    options.onAttempt?.(attempt, executions);
    return preserved;
  };

  let minimized = cloneCase(original.case);
  minimized.operations = await ddmin(
    minimized.operations,
    1,
    async (operations, description) => {
      const candidate = cloneCase(minimized);
      candidate.operations = operations;
      if (!(await predicate(candidate, description))) return false;
      minimized = candidate;
      return true;
    },
    'session'
  );

  for (const operation of [...minimized.operations]) {
    if (operation.method !== 'tools/call') continue;
    const operationId = operation.id;
    const replaceArguments = async (
      argumentsValue: Record<string, JsonValue>,
      description: string
    ): Promise<boolean> => {
      const candidate = cloneCase(minimized);
      const candidateOperation = candidate.operations.find(
        (item): item is CallToolOperation => item.id === operationId && item.method === 'tools/call'
      );
      if (!candidateOperation) return false;
      candidateOperation.params.arguments = argumentsValue;
      if (!(await predicate(candidate, description))) return false;
      minimized = candidate;
      return true;
    };

    let current = (
      minimized.operations.find(
        (item): item is CallToolOperation => item.id === operationId && item.method === 'tools/call'
      ) as CallToolOperation
    ).params.arguments;
    const keys = await ddmin(
      Object.keys(current),
      0,
      async (candidateKeys, description) => {
        const candidate = Object.fromEntries(candidateKeys.map((key) => [key, current[key] as JsonValue]));
        return replaceArguments(candidate, `${operationId} arguments ${description}`);
      },
      'object'
    );
    current = Object.fromEntries(keys.map((key) => [key, current[key] as JsonValue]));

    for (const key of keys) {
      const value = current[key];
      if (typeof value === 'string') {
        const candidates = [
          '',
          value.slice(0, Math.ceil(value.length / 2)),
          value.slice(-Math.ceil(value.length / 2)),
          'a'
        ];
        for (const candidateValue of [...new Set(candidates)]) {
          const currentValue = current[key];
          if (
            typeof currentValue !== 'string' ||
            scalarComplexity(candidateValue) >= scalarComplexity(currentValue)
          )
            continue;
          const candidateArguments = { ...current, [key]: candidateValue };
          if (await replaceArguments(candidateArguments, `${operationId}.${key}: simplify string`))
            current = candidateArguments;
        }
      } else if (typeof value === 'number') {
        for (const candidateValue of [0, 1, -1]) {
          const currentValue = current[key];
          if (
            typeof currentValue !== 'number' ||
            scalarComplexity(candidateValue) >= scalarComplexity(currentValue)
          )
            continue;
          const candidateArguments = { ...current, [key]: candidateValue };
          if (await replaceArguments(candidateArguments, `${operationId}.${key}: simplify number`))
            current = candidateArguments;
        }
      } else if (value === true) {
        const candidateArguments = { ...current, [key]: false };
        if (await replaceArguments(candidateArguments, `${operationId}.${key}: simplify boolean`))
          current = candidateArguments;
      } else if (Array.isArray(value)) {
        const minimizedArray = await ddmin(
          value,
          0,
          (candidateValue, description) =>
            replaceArguments({ ...current, [key]: candidateValue }, `${operationId}.${key} ${description}`),
          'array'
        );
        current = { ...current, [key]: minimizedArray };
      } else if (value !== null && typeof value === 'object') {
        const objectValue = value as Record<string, JsonValue>;
        const minimizedKeys = await ddmin(
          Object.keys(objectValue),
          0,
          (candidateKeys, description) =>
            replaceArguments(
              {
                ...current,
                [key]: Object.fromEntries(
                  candidateKeys.map((candidateKey) => [candidateKey, objectValue[candidateKey] as JsonValue])
                )
              },
              `${operationId}.${key} ${description}`
            ),
          'nested object'
        );
        current = {
          ...current,
          [key]: Object.fromEntries(
            minimizedKeys.map((candidateKey) => [candidateKey, objectValue[candidateKey] as JsonValue])
          )
        };
      }
    }
  }

  if (!budgetExhausted) {
    for (let verification = 1; verification <= 2; verification += 1) {
      const preserved = await evaluate(minimized);
      const attempt = { description: `final reproduction ${verification}/2`, preserved };
      attempts.push(attempt);
      options.onAttempt?.(attempt, executions);
      if (!preserved && budgetExhausted) break;
      if (!preserved) throw new Error('Minimized result did not reproduce reliably in two fresh runs');
    }
  }

  return {
    schemaVersion: 1,
    kind: 'mcp-interlab-minimized-case',
    originalRunId: original.id,
    category,
    baseline: comparison.baseline,
    candidate: comparison.candidate,
    originalCase: original.case,
    minimizedCase: minimized,
    attempts,
    executions,
    complete: !budgetExhausted,
    stopReason: budgetExhausted ? 'evaluation-budget' : 'local-minimum'
  };
}
