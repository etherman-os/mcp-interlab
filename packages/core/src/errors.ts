import type { JsonValue, SerializableError } from './types.js';

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === 'object' && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export function serializeError(error: unknown): SerializableError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const enriched = error as Error & { code?: string | number; data?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(enriched.code !== undefined ? { code: enriched.code } : {}),
    ...(enriched.data !== undefined && isJsonValue(enriched.data) ? { data: enriched.data } : {})
  };
}
