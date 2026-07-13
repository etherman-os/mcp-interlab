import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { compareTargetRuns } from './diff.js';
import { serializeError } from './errors.js';
import { ManagedTarget } from './process.js';
import { createRecordingFetch, createSizeLimitedFetch } from './recording.js';
import type {
  CaseRunArtifact,
  InteropCase,
  InteropOperation,
  JsonValue,
  MatrixConfig,
  OperationObservation,
  SuiteRunArtifact,
  TargetConfig,
  TargetRun
} from './types.js';
import type { HttpTranscriptEntry } from './types.js';

function elapsed(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`cleanup timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const enriched = error as Error & { code?: unknown };
  return error.name === 'AbortError' || enriched.code === -32_001 || enriched.code === 'ETIMEDOUT';
}

function safeTargetUrl(value: string): string {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function executeOperation(
  client: Client,
  operation: InteropOperation,
  timeout: number,
  processHandle: ManagedTarget
): Promise<OperationObservation> {
  const started = process.hrtime.bigint();
  try {
    if (processHandle.crashed) throw new Error(processHandle.exitDescription);
    const options = { timeout, maxTotalTimeout: timeout };
    let value: unknown;
    switch (operation.method) {
      case 'tools/list':
        value = await client.listTools(undefined, options);
        break;
      case 'tools/call':
        value = await client.callTool(operation.params, undefined, options);
        break;
      case 'resources/list':
        value = await client.listResources(undefined, options);
        break;
      case 'resources/read':
        value = await client.readResource(operation.params, options);
        break;
      case 'prompts/list':
        value = await client.listPrompts(undefined, options);
        break;
      case 'prompts/get':
        value = await client.getPrompt(operation.params, options);
        break;
    }
    return {
      id: operation.id,
      method: operation.method,
      status: 'success',
      value: toJsonValue(value),
      durationMs: elapsed(started)
    };
  } catch (error) {
    return {
      id: operation.id,
      method: operation.method,
      status: processHandle.crashed ? 'crash' : isTimeoutError(error) ? 'timeout' : 'error',
      error: serializeError(error),
      durationMs: elapsed(started)
    };
  }
}

async function runTarget(name: string, config: TargetConfig, testCase: InteropCase): Promise<TargetRun> {
  const started = process.hrtime.bigint();
  const processHandle = new ManagedTarget(config);
  let transport: StreamableHTTPClientTransport | undefined;
  let client: Client | undefined;
  let status: TargetRun['status'] = 'completed';
  let error: TargetRun['error'];
  const observations: OperationObservation[] = [];
  const transcript: HttpTranscriptEntry[] = [];
  const recorder = config.recordHttp ? createRecordingFetch(transcript) : undefined;
  const transportFetch = createSizeLimitedFetch(recorder?.fetch ?? fetch, config.maxResponseBytes);
  let sdk: TargetRun['sdk'];
  let protocolVersion: string | undefined;
  let initialization: TargetRun['initialization'];
  let connected = false;

  try {
    try {
      await processHandle.start();
    } catch (caught) {
      status = 'startup-error';
      error = serializeError(caught);
      return {
        target: name,
        url: safeTargetUrl(config.url),
        status,
        observations,
        transcript,
        stdout: processHandle.stdout,
        stderr: processHandle.stderr,
        durationMs: elapsed(started),
        error
      };
    }

    try {
      transport = new StreamableHTTPClientTransport(new URL(config.url), { fetch: transportFetch });
      client = new Client({ name: 'mcp-interlab', version: '0.1.0' }, { capabilities: {} });
      await client.connect(transport, {
        timeout: config.requestTimeoutMs,
        maxTotalTimeout: config.requestTimeoutMs
      });
      connected = true;
      const server = client.getServerVersion();
      if (server) sdk = { name: server.name, version: server.version };
      protocolVersion = transport.protocolVersion;
      initialization = {
        capabilities: toJsonValue(client.getServerCapabilities() ?? {}),
        ...(client.getInstructions() !== undefined
          ? { instructions: client.getInstructions() as string }
          : {})
      };
    } catch (caught) {
      status = processHandle.crashed ? 'crash' : 'connection-error';
      error = serializeError(caught);
    }

    if (client && connected) {
      for (const operation of testCase.operations) {
        observations.push(await executeOperation(client, operation, config.requestTimeoutMs, processHandle));
      }
    }
    if (processHandle.crashed && status === 'completed') {
      status = 'crash';
      error = serializeError(new Error(processHandle.exitDescription));
    }
  } finally {
    if (transport && connected) {
      try {
        await bounded(transport.terminateSession(), Math.min(config.requestTimeoutMs, 1_000));
      } catch {
        // Session termination is best-effort: servers may return 405 or already be gone.
      }
    }
    try {
      await client?.close();
    } catch {
      // A failed target may already have closed its transport.
    }
    await recorder?.flush();
    await processHandle.observeUnexpectedExit();
    await processHandle.stop();
    if (processHandle.unexpectedExit && status === 'completed') {
      status = 'crash';
      error = serializeError(new Error(processHandle.exitDescription));
    }
    if (status !== 'completed' && !error) {
      error = serializeError(new Error(processHandle.exitDescription));
    }
  }

  return {
    target: name,
    url: safeTargetUrl(config.url),
    status,
    ...(sdk ? { sdk } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(initialization ? { initialization } : {}),
    observations,
    transcript,
    stdout: processHandle.stdout,
    stderr: processHandle.stderr,
    durationMs: elapsed(started),
    ...(error ? { error } : {})
  };
}

export interface RunCaseOptions {
  targetNames?: string[];
}

export async function runCase(
  targets: Record<string, TargetConfig>,
  testCase: InteropCase,
  options: RunCaseOptions = {}
): Promise<CaseRunArtifact> {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const selectedNames = options.targetNames ?? Object.keys(targets);
  if (selectedNames.length < 2) throw new Error('Differential execution requires at least two targets');
  const selectedTargets = Object.fromEntries(
    selectedNames.map((name) => {
      const target = targets[name];
      if (!target) throw new Error(`Unknown target '${name}'`);
      return [name, target];
    })
  );
  const runs = await Promise.all(
    Object.entries(selectedTargets).map(([name, target]) => runTarget(name, target, testCase))
  );
  const baseline = runs[0];
  if (!baseline) throw new Error('No baseline target was executed');
  const comparisons = runs
    .slice(1)
    .map((candidate) => compareTargetRuns(baseline, candidate, testCase.compare, testCase.category));

  return {
    schemaVersion: 1,
    kind: 'mcp-interlab-case-run',
    id: randomUUID(),
    startedAt,
    durationMs: elapsed(started),
    case: testCase,
    targetInfo: Object.fromEntries(
      Object.entries(selectedTargets).map(([name, target]) => [
        name,
        {
          url: safeTargetUrl(target.url),
          managed: target.command !== undefined,
          httpRecorded: target.recordHttp,
          envKeys: [...new Set([...Object.keys(target.env), ...target.inheritEnv])].sort()
        }
      ])
    ),
    runs,
    comparisons
  };
}

export interface RunMatrixOptions {
  caseId?: string;
}

export async function runMatrix(
  config: MatrixConfig,
  cases: InteropCase[],
  source?: { matrixPath: string; matrixSha256: string },
  options: RunMatrixOptions = {}
): Promise<SuiteRunArtifact> {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const selectedCases = options.caseId ? cases.filter((entry) => entry.id === options.caseId) : cases;
  if (selectedCases.length === 0) throw new Error(`Case '${options.caseId}' was not found`);
  const artifacts: CaseRunArtifact[] = [];
  for (const testCase of selectedCases) artifacts.push(await runCase(config.targets, testCase));

  const divergent = artifacts.filter((artifact) =>
    artifact.comparisons.some((item) => !item.equivalent)
  ).length;
  const harnessErrors = artifacts.filter((artifact) =>
    artifact.runs.some((run) => run.status !== 'completed')
  ).length;
  return {
    schemaVersion: 1,
    kind: 'mcp-interlab-suite-run',
    id: randomUUID(),
    startedAt,
    durationMs: elapsed(started),
    ...(source ? { source } : {}),
    cases: artifacts,
    summary: {
      total: artifacts.length,
      equivalent: artifacts.length - divergent,
      divergent,
      harnessErrors
    }
  };
}
