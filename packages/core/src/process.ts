import { spawn, type ChildProcess } from 'node:child_process';

import type { TargetConfig } from './types.js';

const MAX_LOG_BYTES = 64 * 1024;
const activeTargets = new Set<ManagedTarget>();
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'PATHEXT',
  'WINDIR',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME'
] as const;

function targetEnvironment(config: TargetConfig): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of [...SAFE_ENV_KEYS, ...config.inheritEnv]) {
    const value = process.env[key];
    if (value !== undefined) output[key] = value;
  }
  return { ...output, ...config.env };
}

function appendCapped(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= MAX_LOG_BYTES ? next : next.slice(next.length - MAX_LOG_BYTES);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readProbeJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes <= 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > 4096) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    return undefined;
  }
}

function isMcpSessionError(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.jsonrpc !== '2.0' ||
    record.id !== null ||
    record.error === null ||
    typeof record.error !== 'object'
  ) {
    return false;
  }
  const error = record.error as Record<string, unknown>;
  return typeof error.code === 'number' && typeof error.message === 'string';
}

export class ManagedTarget {
  readonly #config: TargetConfig;
  #child?: ChildProcess;
  #stdout = '';
  #stderr = '';
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #stopped = false;
  #spawnError?: Error;
  #unexpectedExit = false;

  constructor(config: TargetConfig) {
    this.#config = config;
  }

  get stdout(): string {
    return this.#stdout;
  }

  get stderr(): string {
    return this.#stderr;
  }

  get crashed(): boolean {
    return this.#child !== undefined && (this.#exitCode !== null || this.#exitSignal !== null);
  }

  get exitDescription(): string {
    if (this.#exitCode !== null) return `process exited with code ${this.#exitCode}`;
    if (this.#exitSignal !== null) return `process exited from signal ${this.#exitSignal}`;
    return 'process exited';
  }

  get unexpectedExit(): boolean {
    return this.#unexpectedExit;
  }

  async start(): Promise<void> {
    if (!this.#config.command) return;

    const child = spawn(this.#config.command, this.#config.args, {
      cwd: this.#config.cwd,
      env: targetEnvironment(this.#config),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    this.#child = child;
    activeTargets.add(this);
    child.stdout?.on('data', (chunk: Buffer) => {
      this.#stdout = appendCapped(this.#stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr = appendCapped(this.#stderr, chunk);
    });
    child.once('exit', (code, signal) => {
      this.#exitCode = code;
      this.#exitSignal = signal;
      this.#unexpectedExit = !this.#stopped;
      if (this.#stopped) activeTargets.delete(this);
    });
    child.once('error', (error) => {
      this.#spawnError = error;
      this.#stderr = appendCapped(this.#stderr, error.message);
    });

    const deadline = Date.now() + this.#config.startupTimeoutMs;
    let lastError = 'target did not respond';
    while (Date.now() < deadline) {
      if (this.#spawnError) throw this.#spawnError;
      if (this.crashed)
        throw new Error(`${this.exitDescription}${this.#stderr ? `: ${this.#stderr.trim()}` : ''}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500);
      try {
        const response = await fetch(this.#config.url, {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal
        });
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        let accepted =
          response.status === 405 || (response.status === 200 && contentType.includes('text/event-stream'));
        if (
          (response.status === 400 || response.status === 404) &&
          contentType.includes('application/json')
        ) {
          accepted = isMcpSessionError(await readProbeJson(response));
        } else {
          await response.body?.cancel();
        }
        clearTimeout(timeout);
        if (!accepted) {
          lastError = `unexpected readiness response: HTTP ${response.status} ${contentType || '(no content type)'}`;
          await delay(75);
          continue;
        }
        await delay(25);
        if (this.#spawnError) throw this.#spawnError;
        if (this.crashed) throw new Error(this.exitDescription);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        clearTimeout(timeout);
        await delay(75);
      }
    }
    throw new Error(`target was not ready within ${this.#config.startupTimeoutMs}ms: ${lastError}`);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child || this.#stopped) return;
    this.#stopped = true;

    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    const exited = alreadyExited
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      if (process.platform === 'win32') child.kill('SIGTERM');
      else if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }

    const graceful =
      alreadyExited ||
      (await Promise.race([
        exited.then(() => true),
        delay(this.#config.shutdownTimeoutMs).then(() => false)
      ]));
    if (graceful && process.platform === 'win32') {
      activeTargets.delete(this);
      return;
    }

    if (graceful && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 0);
      } catch {
        activeTargets.delete(this);
        return;
      }
    }

    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    if (!alreadyExited) await exited;
    activeTargets.delete(this);
  }

  async observeUnexpectedExit(graceMs = 25): Promise<void> {
    const child = this.#child;
    if (!child || this.#unexpectedExit || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        child.off('exit', onExit);
        resolve();
      }, graceMs);
      child.once('exit', onExit);
    });
  }
}

export async function stopAllManagedTargets(): Promise<void> {
  await Promise.allSettled([...activeTargets].map((target) => target.stop()));
}
