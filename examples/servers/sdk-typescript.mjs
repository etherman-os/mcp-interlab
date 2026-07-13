import { createServer } from 'node:http';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod/v4';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const host = option('host', '127.0.0.1');
const port = Number(option('port', '43201'));

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid --port: ${port}`);
}

const summaryItemSchema = z.object({
  rank: z.number().int().positive(),
  label: z.string()
});

const summarySchema = z.object({
  topic: z.string(),
  count: z.number().int().nonnegative(),
  items: z.array(summaryItemSchema)
});

function createMcpServer() {
  const server = new McpServer({ name: 'interlab-typescript-sdk', version: '1.29.0' });
  server.registerTool(
    'summarize',
    {
      description: 'Return a deterministic structured summary.',
      inputSchema: {
        topic: z.string().min(1),
        limit: z.number().int().min(1).max(3).default(2)
      },
      outputSchema: summarySchema
    },
    async ({ topic, limit }) => {
      const normalizedTopic = topic.trim().toLowerCase();
      const output = {
        topic: normalizedTopic,
        count: limit,
        items: Array.from({ length: limit }, (_, index) => ({
          rank: index + 1,
          label: `${normalizedTopic}-${index + 1}`
        }))
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    }
  );
  return server;
}

const httpServer = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`);
  if (requestUrl.pathname !== '/mcp') {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST' }).end();
    return;
  }

  const mcpServer = createMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  try {
    await mcpServer.connect(transport);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const webRequest = new Request(requestUrl, {
      method: request.method,
      headers: request.headers,
      ...(body.length > 0 ? { body } : {})
    });
    const webResponse = await transport.handleRequest(webRequest);
    response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
    response.end(Buffer.from(await webResponse.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    if (!response.writableEnded) response.end();
  } finally {
    await mcpServer.close();
  }
});

httpServer.listen(port, host, () => {
  console.log(`TypeScript SDK 1.29.0 listening on http://${host}:${port}/mcp`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  httpServer.close(() => process.exit(0));
}

process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
