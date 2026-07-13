import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const port = Number(option('port', process.env.PORT ?? '43101'));
const profile = option('profile', process.env.PROFILE ?? 'baseline');
const sessions = new Set();

const tools = [
  {
    name: 'echo',
    description: 'Returns its input unchanged',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  },
  {
    name: 'search',
    description: 'Deterministic search fixture',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1 },
        noise: { type: 'string' }
      },
      required: ['query', 'limit'],
      additionalProperties: false
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, rank: { type: 'integer' } },
            required: ['title', 'rank'],
            additionalProperties: false
          }
        }
      },
      required: ['items'],
      additionalProperties: false
    }
  },
  {
    name: 'validation_probe',
    description: 'Surfaces invalid input as a tool error in the baseline profile',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 } },
      required: ['count'],
      additionalProperties: false
    }
  },
  {
    name: 'open_object_probe',
    description: 'Exercises JSON Schema open-object behavior',
    inputSchema: {
      type: 'object',
      properties: { known: { type: 'string' } },
      required: ['known']
    }
  },
  {
    name: 'error_probe',
    description: 'Produces a tool-level error',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'structured_probe',
    description: 'Produces structured content',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false
    }
  },
  {
    name: 'order_probe',
    description: 'Returns a list in profile-dependent order',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
];

function json(response, id, result, extraHeaders = {}) {
  response.writeHead(200, { 'content-type': 'application/json', ...extraHeaders });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function rpcError(response, id, code, message, data) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }));
}

function toolResult(response, id, value, isError = false) {
  json(response, id, {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { structuredContent: value }
      : {}),
    ...(isError ? { isError: true } : {})
  });
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(405, { allow: 'POST, DELETE' });
    response.end();
    return;
  }
  if (request.method === 'DELETE') {
    const sessionId = request.headers['mcp-session-id'];
    if (typeof sessionId === 'string') sessions.delete(sessionId);
    response.writeHead(200);
    response.end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405);
    response.end();
    return;
  }

  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let message;
  try {
    message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    rpcError(response, null, -32700, 'Parse error');
    return;
  }

  if (message.method === 'initialize') {
    const sessionId = randomUUID();
    sessions.add(sessionId);
    json(
      response,
      message.id,
      {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: `interlab-reference-${profile}`, version: '0.1.0' }
      },
      { 'mcp-session-id': sessionId }
    );
    return;
  }

  if (message.method === 'notifications/initialized') {
    response.writeHead(202);
    response.end();
    return;
  }

  const sessionId = request.headers['mcp-session-id'];
  if (typeof sessionId !== 'string') {
    response.writeHead(400);
    response.end('Mcp-Session-Id is required');
    return;
  }
  if (!sessions.has(sessionId)) {
    response.writeHead(404);
    response.end('Unknown session');
    return;
  }

  if (message.method === 'tools/list') {
    json(response, message.id, { tools });
    return;
  }
  if (message.method === 'resources/list') {
    json(response, message.id, { resources: [] });
    return;
  }
  if (message.method === 'prompts/list') {
    json(response, message.id, { prompts: [] });
    return;
  }
  if (message.method !== 'tools/call') {
    rpcError(response, message.id, -32601, 'Method not found');
    return;
  }

  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  if (name === 'echo') {
    toolResult(response, message.id, args.value ?? '');
    return;
  }
  if (name === 'search') {
    if (
      typeof args.query !== 'string' ||
      args.query.length === 0 ||
      !Number.isInteger(args.limit) ||
      args.limit < 1
    ) {
      toolResult(response, message.id, 'invalid search arguments', true);
      return;
    }
    const items = profile === 'baseline' ? [{ title: args.query, rank: 1 }].slice(0, args.limit) : [];
    toolResult(response, message.id, { items });
    if (profile === 'crash-after-call') setImmediate(() => process.exit(7));
    return;
  }
  if (name === 'validation_probe') {
    if (!Number.isInteger(args.count) || args.count < 1) {
      if (profile === 'baseline') toolResult(response, message.id, 'count must be at least one', true);
      else rpcError(response, message.id, -32602, 'Invalid params');
      return;
    }
    toolResult(response, message.id, 'valid');
    return;
  }
  if (name === 'open_object_probe') {
    const hasExtra = Object.keys(args).some((key) => key !== 'known');
    if (profile !== 'baseline' && hasExtra)
      toolResult(response, message.id, 'additional property rejected', true);
    else toolResult(response, message.id, { accepted: true, keys: Object.keys(args).sort() });
    return;
  }
  if (name === 'error_probe') {
    toolResult(
      response,
      message.id,
      profile === 'baseline' ? 'fixture failure' : 'fixture failure reported as success',
      profile === 'baseline'
    );
    return;
  }
  if (name === 'structured_probe') {
    if (profile === 'baseline') toolResult(response, message.id, { ok: true });
    else json(response, message.id, { content: [{ type: 'text', text: '{"ok":true}' }] });
    return;
  }
  if (name === 'order_probe') {
    toolResult(response, message.id, {
      items: profile === 'baseline' ? ['alpha', 'beta'] : ['beta', 'alpha']
    });
    return;
  }
  rpcError(response, message.id, -32602, `Unknown tool: ${name}`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`reference ${profile} listening on http://127.0.0.1:${port}/mcp`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
