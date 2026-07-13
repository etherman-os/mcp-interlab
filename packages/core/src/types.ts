export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DifferenceCategory =
  'protocol' | 'schema-acceptance' | 'result-shape' | 'error-semantics' | 'lifecycle' | 'timeout';

export interface TargetConfig {
  url: string;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  inheritEnv: string[];
  recordHttp: boolean;
  maxResponseBytes: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
}

export interface CaseSource {
  url: string;
  note?: string;
}

export interface ListToolsOperation {
  id: string;
  method: 'tools/list';
}

export interface CallToolOperation {
  id: string;
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, JsonValue>;
  };
}

export interface ListResourcesOperation {
  id: string;
  method: 'resources/list';
}

export interface ReadResourceOperation {
  id: string;
  method: 'resources/read';
  params: {
    uri: string;
  };
}

export interface ListPromptsOperation {
  id: string;
  method: 'prompts/list';
}

export interface GetPromptOperation {
  id: string;
  method: 'prompts/get';
  params: {
    name: string;
    arguments: Record<string, string>;
  };
}

export type InteropOperation =
  | ListToolsOperation
  | CallToolOperation
  | ListResourcesOperation
  | ReadResourceOperation
  | ListPromptsOperation
  | GetPromptOperation;

export interface CompareRules {
  ignorePaths: string[];
  unorderedPaths: string[];
}

export interface InteropCase {
  version: 1;
  id: string;
  title: string;
  description?: string;
  expectation: 'spec' | 'differential' | 'regression';
  tags: string[];
  category?: DifferenceCategory;
  sources: CaseSource[];
  operations: InteropOperation[];
  compare: CompareRules;
}

export interface MatrixConfig {
  version: 1;
  targets: Record<string, TargetConfig>;
  cases: Array<string | InteropCase>;
}

export type OperationStatus = 'success' | 'error' | 'timeout' | 'crash';

export interface SerializableError {
  name: string;
  message: string;
  code?: string | number;
  data?: JsonValue;
}

export interface OperationObservation {
  id: string;
  method: InteropOperation['method'];
  status: OperationStatus;
  value?: JsonValue;
  error?: SerializableError;
  durationMs: number;
}

export interface HttpTranscriptEntry {
  sequence: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseStatus?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  durationMs: number;
  error?: SerializableError;
}

export interface TargetRun {
  target: string;
  url: string;
  status: 'completed' | 'startup-error' | 'connection-error' | 'crash';
  sdk?: {
    name: string;
    version: string;
  };
  protocolVersion?: string;
  initialization?: {
    capabilities: JsonValue;
    instructions?: string;
  };
  observations: OperationObservation[];
  transcript: HttpTranscriptEntry[];
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: SerializableError;
}

export type DiffKind = 'added' | 'removed' | 'changed' | 'type-changed';

export interface DiffEntry {
  path: string;
  kind: DiffKind;
  baseline?: JsonValue;
  candidate?: JsonValue;
}

export interface TargetComparison {
  baseline: string;
  candidate: string;
  equivalent: boolean;
  category?: DifferenceCategory;
  differences: DiffEntry[];
}

export interface CaseRunArtifact {
  schemaVersion: 1;
  kind: 'mcp-interlab-case-run';
  id: string;
  startedAt: string;
  durationMs: number;
  case: InteropCase;
  targetInfo: Record<
    string,
    {
      url: string;
      managed: boolean;
      httpRecorded: boolean;
      envKeys: string[];
    }
  >;
  runs: TargetRun[];
  comparisons: TargetComparison[];
}

export interface SuiteRunArtifact {
  schemaVersion: 1;
  kind: 'mcp-interlab-suite-run';
  id: string;
  startedAt: string;
  durationMs: number;
  source?: {
    matrixPath: string;
    matrixSha256: string;
  };
  cases: CaseRunArtifact[];
  summary: {
    total: number;
    equivalent: number;
    divergent: number;
    harnessErrors: number;
  };
}

export interface MinimizationAttempt {
  description: string;
  preserved: boolean;
}

export interface MinimizedArtifact {
  schemaVersion: 1;
  kind: 'mcp-interlab-minimized-case';
  originalRunId: string;
  category: DifferenceCategory;
  baseline: string;
  candidate: string;
  originalCase: InteropCase;
  minimizedCase: InteropCase;
  attempts: MinimizationAttempt[];
  executions: number;
  complete: boolean;
  stopReason: 'local-minimum' | 'evaluation-budget';
}
