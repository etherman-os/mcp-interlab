import type { CompareRules, JsonValue, OperationObservation, TargetRun } from './types.js';

// Protocol metadata is excluded before this layer. Payload fields are never
// removed just because they have a common volatile-looking name; callers must
// opt in with an explicit JSON pointer.
export const DEFAULT_IGNORE_PATHS: readonly string[] = [];

function escapePointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function matchesTokens(path: string[], pattern: string[], pathIndex = 0, patternIndex = 0): boolean {
  if (patternIndex === pattern.length) return pathIndex === path.length;
  const token = pattern[patternIndex];
  if (token === '**') {
    if (patternIndex === pattern.length - 1) return true;
    for (let index = pathIndex; index <= path.length; index += 1) {
      if (matchesTokens(path, pattern, index, patternIndex + 1)) return true;
    }
    return false;
  }
  if (pathIndex >= path.length) return false;
  return (
    (token === '*' || token === path[pathIndex]) &&
    matchesTokens(path, pattern, pathIndex + 1, patternIndex + 1)
  );
}

export function matchesPointer(path: string, pattern: string): boolean {
  return matchesTokens(pointerTokens(path), pointerTokens(pattern));
}

function stableStringify(value: JsonValue): string {
  return JSON.stringify(value);
}

const OMIT = Symbol('omit');

function normalizeNode(
  value: JsonValue,
  path: string,
  ignorePatterns: string[],
  unorderedPatterns: string[]
): JsonValue | typeof OMIT {
  if (ignorePatterns.some((pattern) => matchesPointer(path, pattern))) return OMIT;

  if (Array.isArray(value)) {
    const normalized = value
      .map((item, index) => normalizeNode(item, `${path}/${index}`, ignorePatterns, unorderedPatterns))
      .filter((item): item is JsonValue => item !== OMIT);
    if (unorderedPatterns.some((pattern) => matchesPointer(path, pattern))) {
      normalized.sort((left, right) => {
        const leftText = stableStringify(left);
        const rightText = stableStringify(right);
        return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
      });
    }
    return normalized;
  }

  if (value !== null && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalizeNode(
        value[key] as JsonValue,
        `${path}/${escapePointerToken(key)}`,
        ignorePatterns,
        unorderedPatterns
      );
      if (normalized !== OMIT) output[key] = normalized;
    }
    return output;
  }

  return value;
}

export function normalizeJson(value: JsonValue, rules: CompareRules): JsonValue {
  const normalized = normalizeNode(
    value,
    '',
    [...DEFAULT_IGNORE_PATHS, ...rules.ignorePaths],
    rules.unorderedPaths
  );
  return normalized === OMIT ? null : normalized;
}

function comparableObservation(observation: OperationObservation): JsonValue {
  const output: Record<string, JsonValue> = {
    id: observation.id,
    method: observation.method,
    status: observation.status
  };
  if (observation.value !== undefined) output.value = observation.value;
  if (observation.error !== undefined) {
    output.error = {
      name: observation.error.name,
      message: observation.error.message,
      ...(observation.error.code !== undefined ? { code: observation.error.code } : {}),
      ...(observation.error.data !== undefined ? { data: observation.error.data } : {})
    } as JsonValue;
  }
  return output;
}

export function comparableTargetRun(run: TargetRun, rules: CompareRules): JsonValue {
  const value: Record<string, JsonValue> = {
    status: run.status,
    observations: run.observations.map(comparableObservation)
  };
  if (run.protocolVersion !== undefined) value.protocolVersion = run.protocolVersion;
  if (run.initialization !== undefined) {
    value.initialization = {
      capabilities: run.initialization.capabilities,
      ...(run.initialization.instructions !== undefined
        ? { instructions: run.initialization.instructions }
        : {})
    };
  }
  if (run.error !== undefined) {
    value.error = {
      name: run.error.name,
      message: run.error.message,
      ...(run.error.code !== undefined ? { code: run.error.code } : {})
    } as JsonValue;
  }
  return normalizeJson(value, rules);
}
