import { describe, expect, it, vi } from 'vitest';

import { createSizeLimitedFetch, ResponseSizeError } from '../src/recording.js';

describe('response size limiting fetch', () => {
  it('passes through responses within the configured limit', async () => {
    const base = vi.fn(async () => new Response('small')) as unknown as typeof fetch;
    const response = await createSizeLimitedFetch(base, 10)(new Request('http://example.test/mcp'));
    await expect(response.text()).resolves.toBe('small');
  });

  it('rejects a declared oversized response before parsing it', async () => {
    const base = vi.fn(
      async () => new Response('large response', { headers: { 'content-length': '14' } })
    ) as unknown as typeof fetch;
    await expect(
      createSizeLimitedFetch(base, 5)(new Request('http://example.test/mcp'))
    ).rejects.toBeInstanceOf(ResponseSizeError);
  });

  it('stops a chunked response while it is being consumed', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('1234'));
        controller.enqueue(new TextEncoder().encode('5678'));
        controller.close();
      }
    });
    const base = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
    const response = await createSizeLimitedFetch(base, 6)(new Request('http://example.test/mcp'));
    await expect(response.text()).rejects.toBeInstanceOf(ResponseSizeError);
  });
});
