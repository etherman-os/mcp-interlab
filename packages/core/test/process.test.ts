import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

import { ManagedTarget } from '../src/process.js';
import type { TargetConfig } from '../src/types.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function config(port: number, script: string, overrides: Partial<TargetConfig> = {}): TargetConfig {
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    command: process.execPath,
    args: ['--input-type=module', '-e', script, String(port)],
    env: {},
    inheritEnv: [],
    recordHttp: false,
    maxResponseBytes: 4 * 1024 * 1024,
    startupTimeoutMs: 500,
    requestTimeoutMs: 200,
    shutdownTimeoutMs: 100,
    ...overrides
  };
}

describe('ManagedTarget readiness', () => {
  it('accepts an MCP-shaped pre-session 400 response used by stateful SDK servers', async () => {
    const port = await freePort();
    const script = `
      import { createServer } from 'node:http';
      const port = Number(process.argv[1]);
      const server = createServer((_request, response) => {
        response.writeHead(400, {'content-type':'application/json'});
        response.end(JSON.stringify({jsonrpc:'2.0', error:{code:-32000,message:'Server not initialized'}, id:null}));
      });
      server.listen(port, '127.0.0.1');
      process.on('SIGTERM', () => server.close());
    `;
    const target = new ManagedTarget(config(port, script));
    try {
      await expect(target.start()).resolves.toBeUndefined();
    } finally {
      await target.stop();
    }
  });

  it('rejects an unrelated HTTP listener instead of treating any response as ready', async () => {
    const port = await freePort();
    const script = `
      import { createServer } from 'node:http';
      const port = Number(process.argv[1]);
      const server = createServer((_request, response) => {
        response.writeHead(200, {'content-type':'text/html'});
        response.end('<h1>not MCP</h1>');
      });
      server.listen(port, '127.0.0.1');
      process.on('SIGTERM', () => server.close());
    `;
    const target = new ManagedTarget(config(port, script, { startupTimeoutMs: 250 }));
    try {
      await expect(target.start()).rejects.toThrow('unexpected readiness response');
    } finally {
      await target.stop();
    }
  });

  it('surfaces a missing executable without waiting for the full startup timeout', async () => {
    const target = new ManagedTarget({
      ...config(1, ''),
      command: '__mcp_interlab_missing_executable__',
      args: [],
      startupTimeoutMs: 5_000
    });
    const started = Date.now();
    try {
      await expect(target.start()).rejects.toMatchObject({ code: 'ENOENT' });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await target.stop();
    }
  });

  it('does not inherit ambient secrets unless the matrix names them explicitly', async () => {
    const port = await freePort();
    const script = `
      import { createServer } from 'node:http';
      const port = Number(process.argv[1]);
      console.log(JSON.stringify({secret:process.env.MCP_INTERLAB_SECRET_TEST ?? null, allowed:process.env.MCP_INTERLAB_ALLOWED_TEST, explicit:process.env.EXPLICIT_VALUE}));
      const server = createServer((_request, response) => { response.writeHead(405); response.end(); });
      server.listen(port, '127.0.0.1');
      process.on('SIGTERM', () => server.close());
    `;
    process.env.MCP_INTERLAB_SECRET_TEST = 'must-not-leak';
    process.env.MCP_INTERLAB_ALLOWED_TEST = 'allowed';
    const target = new ManagedTarget(
      config(port, script, {
        env: { EXPLICIT_VALUE: 'explicit' },
        inheritEnv: ['MCP_INTERLAB_ALLOWED_TEST']
      })
    );
    try {
      await target.start();
      expect(target.stdout).toContain('"secret":null');
      expect(target.stdout).toContain('"allowed":"allowed"');
      expect(target.stdout).toContain('"explicit":"explicit"');
    } finally {
      await target.stop();
      delete process.env.MCP_INTERLAB_SECRET_TEST;
      delete process.env.MCP_INTERLAB_ALLOWED_TEST;
    }
  });
});
