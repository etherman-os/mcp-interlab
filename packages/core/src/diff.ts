import { comparableTargetRun } from './normalize.js';
import type {
  CompareRules,
  DiffEntry,
  DifferenceCategory,
  JsonValue,
  TargetComparison,
  TargetRun
} from './types.js';

function kindOf(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function diffJson(baseline: JsonValue, candidate: JsonValue, path = ''): DiffEntry[] {
  if (Object.is(baseline, candidate)) return [];

  const baselineKind = kindOf(baseline);
  const candidateKind = kindOf(candidate);
  if (baselineKind !== candidateKind) {
    return [{ path: path || '/', kind: 'type-changed', baseline, candidate }];
  }

  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    const differences: DiffEntry[] = [];
    const length = Math.max(baseline.length, candidate.length);
    for (let index = 0; index < length; index += 1) {
      const itemPath = `${path}/${index}`;
      if (index >= baseline.length) {
        differences.push({ path: itemPath, kind: 'added', candidate: candidate[index] });
      } else if (index >= candidate.length) {
        differences.push({ path: itemPath, kind: 'removed', baseline: baseline[index] });
      } else {
        differences.push(...diffJson(baseline[index] as JsonValue, candidate[index] as JsonValue, itemPath));
      }
    }
    return differences;
  }

  if (
    baseline !== null &&
    candidate !== null &&
    typeof baseline === 'object' &&
    typeof candidate === 'object'
  ) {
    const differences: DiffEntry[] = [];
    const baselineObject = baseline as Record<string, JsonValue>;
    const candidateObject = candidate as Record<string, JsonValue>;
    const keys = [...new Set([...Object.keys(baselineObject), ...Object.keys(candidateObject)])].sort();
    for (const key of keys) {
      const itemPath = `${path}/${escapePointerToken(key)}`;
      if (!(key in baselineObject)) {
        differences.push({ path: itemPath, kind: 'added', candidate: candidateObject[key] });
      } else if (!(key in candidateObject)) {
        differences.push({ path: itemPath, kind: 'removed', baseline: baselineObject[key] });
      } else {
        differences.push(
          ...diffJson(baselineObject[key] as JsonValue, candidateObject[key] as JsonValue, itemPath)
        );
      }
    }
    return differences;
  }

  return [{ path: path || '/', kind: 'changed', baseline, candidate }];
}

function inferCategory(
  baseline: TargetRun,
  candidate: TargetRun,
  differences: DiffEntry[]
): DifferenceCategory {
  const statuses = [...baseline.observations, ...candidate.observations].map((item) => item.status);
  if (statuses.includes('timeout')) return 'timeout';
  if (baseline.status !== 'completed' || candidate.status !== 'completed') return 'lifecycle';
  if (
    differences.some(
      (difference) => difference.path === '/protocolVersion' || difference.path.startsWith('/initialization')
    )
  ) {
    return 'protocol';
  }

  const divergentIndices = new Set(
    differences
      .map((difference) => /^\/observations\/(\d+)/.exec(difference.path)?.[1])
      .filter((index): index is string => index !== undefined)
      .map(Number)
  );
  for (const index of divergentIndices) {
    const left = baseline.observations[index];
    const right = candidate.observations[index];
    if (left?.method === 'tools/list' || right?.method === 'tools/list') return 'schema-acceptance';
    if (left?.method === 'tools/call' || right?.method === 'tools/call') {
      const invalidParams = left?.error?.code === -32_602 || right?.error?.code === -32_602;
      if (invalidParams && left?.status !== right?.status) return 'schema-acceptance';
      const leftIsError =
        left?.value !== null && typeof left?.value === 'object' && !Array.isArray(left.value)
          ? (left.value as Record<string, JsonValue>).isError
          : undefined;
      const rightIsError =
        right?.value !== null && typeof right?.value === 'object' && !Array.isArray(right.value)
          ? (right.value as Record<string, JsonValue>).isError
          : undefined;
      if (left?.status !== right?.status || left?.error || right?.error || leftIsError !== rightIsError) {
        return 'error-semantics';
      }
    }
  }
  if (statuses.includes('error') || statuses.includes('crash')) return 'error-semantics';
  if (differences.some((difference) => difference.path.includes('/value'))) return 'result-shape';
  return 'protocol';
}

export function compareTargetRuns(
  baseline: TargetRun,
  candidate: TargetRun,
  rules: CompareRules,
  categoryOverride?: DifferenceCategory
): TargetComparison {
  const differences = diffJson(comparableTargetRun(baseline, rules), comparableTargetRun(candidate, rules));
  const equivalent = differences.length === 0;
  const inferredCategory = equivalent ? undefined : inferCategory(baseline, candidate, differences);
  const category =
    inferredCategory === 'timeout' || inferredCategory === 'lifecycle' || inferredCategory === 'protocol'
      ? inferredCategory
      : (categoryOverride ?? inferredCategory);
  return {
    baseline: baseline.target,
    candidate: candidate.target,
    equivalent,
    ...(!equivalent ? { category } : {}),
    differences
  };
}
