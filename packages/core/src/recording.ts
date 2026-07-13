import { serializeError } from './errors.js';
import type { HttpTranscriptEntry } from './types.js';

const MAX_BODY_BYTES = 64 * 1024;
const SENSITIVE_HEADER_PATTERN = /(?:authorization|cookie|token|secret|api[-_]?key|session)/i;

function safeUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function headersRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [
        name,
        SENSITIVE_HEADER_PATTERN.test(name) || name.toLowerCase() === 'location' ? '[REDACTED]' : value
      ])
  );
}

async function readLimitedBody(body: ReadableStream<Uint8Array> | null): Promise<string | undefined> {
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  try {
    while (bytes < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) return output + decoder.decode();
      if (!value) continue;
      const remaining = MAX_BODY_BYTES - bytes;
      const selected = value.byteLength <= remaining ? value : value.slice(0, remaining);
      bytes += selected.byteLength;
      output += decoder.decode(selected, { stream: true });
      if (selected.byteLength < value.byteLength || bytes >= MAX_BODY_BYTES) {
        await reader.cancel();
        return `${output}${decoder.decode()}\n…[truncated]`;
      }
    }
    return `${output}${decoder.decode()}\n…[truncated]`;
  } finally {
    reader.releaseLock();
  }
}

export interface RecordingFetch {
  fetch: typeof fetch;
  flush: () => Promise<void>;
}

export class ResponseSizeError extends Error {
  override readonly name = 'ResponseSizeError';

  constructor(readonly maxBytes: number) {
    super(`MCP response exceeded the ${maxBytes} byte limit`);
  }
}

export function createSizeLimitedFetch(baseFetch: typeof fetch, maxBytes: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new ResponseSizeError(maxBytes);
    }
    if (!response.body) return response;

    let received = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > maxBytes) {
            controller.error(new ResponseSizeError(maxBytes));
            return;
          }
          controller.enqueue(chunk);
        }
      })
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

export function createRecordingFetch(transcript: HttpTranscriptEntry[]): RecordingFetch {
  const pending = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise));
  };

  const recordingFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const started = process.hrtime.bigint();
    const request = new Request(input, init);
    const entry: HttpTranscriptEntry = {
      sequence: transcript.length + 1,
      method: request.method,
      url: safeUrl(request.url),
      requestHeaders: headersRecord(request.headers),
      durationMs: 0
    };
    transcript.push(entry);

    if (request.body) {
      track(
        readLimitedBody(request.clone().body)
          .then((body) => {
            if (body !== undefined) entry.requestBody = body;
          })
          .catch(() => {
            entry.requestBody = '[unavailable stream]';
          })
      );
    }

    try {
      const response = await fetch(request);
      entry.responseStatus = response.status;
      entry.responseHeaders = headersRecord(response.headers);
      entry.durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.toLowerCase().includes('text/event-stream')) {
        track(
          readLimitedBody(response.clone().body)
            .then((body) => {
              if (body !== undefined) entry.responseBody = body;
            })
            .catch(() => {
              entry.responseBody = '[unavailable stream]';
            })
        );
      }
      return response;
    } catch (error) {
      entry.durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      entry.error = serializeError(error);
      throw error;
    }
  };

  return {
    fetch: recordingFetch,
    async flush() {
      await Promise.allSettled([...pending]);
    }
  };
}
