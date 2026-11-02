import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

/** Exact multi-architecture Node 24 Alpine image digest used by the local WSL2 proof. */
export const SANDBOX_IMAGE_REF =
  'node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85';

export type SandboxErrorCode =
  | 'timed_out'
  | 'cancelled'
  | 'unavailable'
  | 'crashed'
  | 'output_limit'
  | 'launch_failed'
  | 'termination_failed';

const safeMessages: Record<SandboxErrorCode, string> = {
  timed_out: 'The isolated execution exceeded its time limit.',
  cancelled: 'The isolated execution was cancelled.',
  unavailable: 'The isolated execution service is unavailable.',
  crashed: 'The isolated execution process failed.',
  output_limit: 'The isolated execution exceeded its output limit.',
  launch_failed: 'The isolated execution could not be started.',
  termination_failed: 'The isolated execution could not be confirmed stopped.',
};

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode) {
    super(safeMessages[code]);
    this.name = 'SandboxError';
    this.code = code;
  }
}

export interface SandboxExecutor {
  cleanupOrphanedContainers(
    resolveActiveRunIds: (candidateRunIds: readonly string[]) => Promise<readonly string[]>,
  ): Promise<void>;
  execute(input: {
    runId: string;
    argv: readonly string[];
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface DockerSandboxTestDependencies {
  /** Test seam only. Production callers should use the default constructor. */
  dockerPath?: string;
  workspaceRoot?: string;
  uid?: number;
  gid?: number;
  maxOutputBytes?: number;
  scopeId?: string;
}

const maxExecutionMs = 30_000;
const maxArgvCount = 16;
const maxArgBytes = 32 * 1024;
const maxStdinBytes = 64 * 1024;
const defaultMaxOutputBytes = 64 * 1024;
const terminateGraceMs = 1_500;
const cleanupDeadlineMs = 5_000;
const workspaceMount = '/workspace';

// This supervisor remains inside the container if the trusted worker is killed.
// Its child is placed in a new process group so a timeout also kills descendants.
const workloadSupervisor = String.raw`
const { spawn } = require('node:child_process');
const [timeoutText, command, ...args] = process.argv.slice(1);
const timeoutMs = Number(timeoutText);
if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000 || !command) process.exit(125);
const child = spawn(command, args, { detached: true, stdio: 'inherit', shell: false });
let finished = false;
const forceKill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
const timer = setTimeout(() => {
  if (finished) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { if (!finished) forceKill(); }, ${terminateGraceMs}).unref();
  process.exitCode = 124;
}, timeoutMs);
child.once('error', () => { finished = true; clearTimeout(timer); process.exitCode = 126; });
child.once('close', (code, signal) => {
  finished = true;
  clearTimeout(timer);
  if (process.exitCode === 124) return;
  process.exitCode = code ?? (signal ? 128 : 1);
});
process.once('SIGTERM', forceKill);
process.once('SIGINT', forceKill);
`;

export class DockerSandboxExecutor implements SandboxExecutor {
  private readonly dockerPath: string;
  private readonly workspaceRoot: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly maxOutputBytes: number;
  private readonly scopeId: string;

  constructor(dependencies: DockerSandboxTestDependencies = {}) {
    this.dockerPath = dependencies.dockerPath ?? '/usr/bin/docker';
    this.workspaceRoot = dependencies.workspaceRoot ?? path.join(os.tmpdir(), 'omnis-os-sandbox');
    this.uid = dependencies.uid ?? process.getuid?.() ?? 0;
    this.gid = dependencies.gid ?? process.getgid?.() ?? 0;
    this.maxOutputBytes = dependencies.maxOutputBytes ?? defaultMaxOutputBytes;
    this.scopeId = dependencies.scopeId ?? '000000000000000000000000';
    if (!/^[0-9a-f]{24}$/.test(this.scopeId)) throw new SandboxError('launch_failed');
  }

  async cleanupOrphanedContainers(
    resolveActiveRunIds: (candidateRunIds: readonly string[]) => Promise<readonly string[]>,
  ): Promise<void> {
    const cliConfig = await this.createPrivateDirectory('docker-cleanup-');
    try {
      const result = await this.runDocker(
        [
          'ps',
          '--all',
          '--filter',
          'label=com.omnis.os.sandbox=true',
          '--filter',
          `label=com.omnis.os.scope=${this.scopeId}`,
          '--format',
          '{{.ID}}|{{.Label "com.omnis.os.run-id"}}',
        ],
        cliConfig,
        cleanupDeadlineMs,
        64 * 1024,
      );
      if (result.code !== 0) throw new SandboxError('unavailable');
      const containers: Array<{ id: string; runId: string }> = [];
      for (const row of result.stdout.split(/\r?\n/).filter(Boolean)) {
        const [containerId, runId] = row.split('|');
        if (!/^[0-9a-f]{12,64}$/i.test(containerId ?? '') || !/^run-[0-9]{4,}$/.test(runId ?? '')) {
          throw new SandboxError('launch_failed');
        }
        containers.push({ id: containerId!, runId: runId! });
      }
      const workspaceEntries = await readdir(this.workspaceRoot, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        },
      );
      const orphanableWorkspaces = workspaceEntries.flatMap((entry) => {
        const match = /^run-(run-[0-9]{4,})-[A-Za-z0-9_-]{6}$/.exec(entry.name);
        return entry.isDirectory() && match
          ? [{ path: path.join(this.workspaceRoot, entry.name), runId: match[1]! }]
          : [];
      });
      const candidates = [
        ...new Set([
          ...containers.map((container) => container.runId),
          ...orphanableWorkspaces.map((workspace) => workspace.runId),
        ]),
      ];
      const activeIds = new Set(await resolveActiveRunIds(candidates));
      if (
        activeIds.size > candidates.length ||
        [...activeIds].some((id) => !candidates.includes(id))
      ) {
        throw new SandboxError('launch_failed');
      }
      for (const container of containers) {
        if (!activeIds.has(container.runId)) await this.removeContainer(container.id, cliConfig);
      }
      for (const workspace of orphanableWorkspaces) {
        if (!activeIds.has(workspace.runId)) await this.removePrivateDirectory(workspace.path);
      }
    } finally {
      await this.removePrivateDirectory(cliConfig);
    }
  }

  async execute(input: {
    runId: string;
    argv: readonly string[];
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    validateInput(input, this.maxOutputBytes);
    if (input.signal.aborted) throw new SandboxError('cancelled');
    if (this.uid <= 0 || this.gid < 0) throw new SandboxError('launch_failed');

    const cliConfig = await this.createPrivateDirectory('docker-config-');
    let workspace: string | undefined;
    let containerName: string | undefined;
    let startChild: ChildProcess | undefined;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;
    let stopping: Promise<void> | undefined;
    const output: { stdout: string; stderr: string; bytes: number; exitCode?: number } = {
      stdout: '',
      stderr: '',
      bytes: 0,
    };

    try {
      workspace = await this.createPrivateDirectory(`run-${input.runId}-`);
      const sourcePath = await realpath(workspace);
      if (sourcePath.includes(',') || sourcePath.includes(':')) {
        throw new SandboxError('launch_failed');
      }

      const containerId = randomUUID().replaceAll('-', '').slice(0, 24);
      containerName = `omnis-os-sandbox-${containerId}`;
      const create = await this.runDocker(
        [
          'create',
          '--pull=never',
          '--name',
          containerName,
          '--label',
          'com.omnis.os.sandbox=true',
          '--label',
          `com.omnis.os.scope=${this.scopeId}`,
          '--label',
          `com.omnis.os.run-id=${input.runId}`,
          '--network=none',
          '--read-only',
          '--user',
          `${this.uid}:${this.gid}`,
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges:true',
          '--pids-limit=32',
          '--memory=128m',
          '--memory-swap=128m',
          '--cpus=0.5',
          '--shm-size=16m',
          '--ulimit=core=0:0',
          '--ulimit=nofile=128:128',
          '--stop-timeout=1',
          '--init',
          '--interactive',
          '--rm',
          '--log-driver=none',
          `--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,uid=${this.uid},gid=${this.gid},mode=700`,
          '--mount',
          `type=bind,src=${sourcePath},dst=${workspaceMount},readonly=false`,
          '--workdir',
          workspaceMount,
          SANDBOX_IMAGE_REF,
          'node',
          '-e',
          workloadSupervisor,
          String(input.timeoutMs),
          ...input.argv,
        ],
        cliConfig,
        10_000,
      );
      if (create.code !== 0) throw new SandboxError('unavailable');
      if (input.signal.aborted) {
        cancelled = true;
        await this.removeContainer(containerName, cliConfig);
        throw new SandboxError('cancelled');
      }

      const executionFinished = new Promise<void>((resolve, reject) => {
        const child = spawn(
          this.dockerPath,
          [
            '--host',
            'unix:///var/run/docker.sock',
            '--config',
            cliConfig,
            'start',
            '--attach',
            '--interactive',
            containerName!,
          ],
          {
            cwd: '/tmp',
            env: dockerCliEnvironment(cliConfig),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
        startChild = child;

        const onChunk = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
          output.bytes += chunk.byteLength;
          if (output.bytes > this.maxOutputBytes) {
            outputExceeded = true;
            requestStop('output_limit');
            return;
          }
          output[stream] += chunk.toString('utf8');
        };
        child.stdout?.on('data', (chunk: Buffer) => onChunk('stdout', chunk));
        child.stderr?.on('data', (chunk: Buffer) => onChunk('stderr', chunk));
        child.once('error', reject);
        child.once('close', (code, signal) => {
          startChild = undefined;
          if (signal === 'SIGKILL' && (cancelled || timedOut || outputExceeded)) {
            resolve();
            return;
          }
          if (code === null && !cancelled && !timedOut && !outputExceeded) {
            reject(new SandboxError('unavailable'));
            return;
          }
          Object.assign(output, { exitCode: code ?? 128 });
          resolve();
        });
        child.stdin?.on('error', () => {
          // A workload may exit before consuming all input; this is not a launcher failure.
        });
        if (input.stdin !== undefined) child.stdin?.end(input.stdin);
        else child.stdin?.end();
      });

      const requestStop = (reason: 'cancelled' | 'timed_out' | 'output_limit') => {
        if (stopping) return;
        if (reason === 'cancelled') cancelled = true;
        if (reason === 'timed_out') timedOut = true;
        if (reason === 'output_limit') outputExceeded = true;
        stopping = this.removeContainer(containerName!, cliConfig).catch(() => {
          startChild?.kill('SIGKILL');
          throw new SandboxError('termination_failed');
        });
      };

      const onAbort = () => requestStop('cancelled');
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) onAbort();
      const timer = setTimeout(() => requestStop('timed_out'), input.timeoutMs);
      try {
        if (input.stdin !== undefined) {
          // stdin payload is task data only; the runtime adapter supplies the child command.
        }
        await executionFinished;
        if (stopping) await stopping;
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
      }

      if (cancelled) throw new SandboxError('cancelled');
      if (timedOut || output.exitCode === 124) throw new SandboxError('timed_out');
      if (outputExceeded) throw new SandboxError('output_limit');
      const exitCode = Number(output.exitCode ?? 1);
      if (exitCode !== 0) throw new SandboxError('crashed');
      return { stdout: output.stdout, stderr: output.stderr, exitCode };
    } catch (error) {
      if (error instanceof SandboxError) throw error;
      if (input.signal.aborted) throw new SandboxError('cancelled');
      throw new SandboxError('launch_failed');
    } finally {
      try {
        if (containerName) await this.removeContainer(containerName, cliConfig);
      } finally {
        if (workspace) await this.removePrivateDirectory(workspace);
        await this.removePrivateDirectory(cliConfig);
      }
    }
  }

  private async createPrivateDirectory(prefix: string): Promise<string> {
    await ensurePrivateRoot(this.workspaceRoot);
    const directory = await mkdtemp(path.join(this.workspaceRoot, prefix));
    await chmod(directory, 0o700);
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== this.uid ||
      (info.mode & 0o777) !== 0o700
    ) {
      await rm(directory, { recursive: true, force: true });
      throw new SandboxError('launch_failed');
    }
    return directory;
  }

  private async removePrivateDirectory(directory: string): Promise<void> {
    const root = await realpath(this.workspaceRoot);
    const entry = await lstat(directory).catch(() => undefined);
    if (!entry) return;
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !(await realpath(directory)).startsWith(`${root}${path.sep}`)
    ) {
      throw new SandboxError('launch_failed');
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }

  private async runDocker(
    args: string[],
    cliConfig: string,
    timeoutMs: number,
    maxCapturedBytes = 4096,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(
        this.dockerPath,
        ['--host', 'unix:///var/run/docker.sock', '--config', cliConfig, ...args],
        {
          cwd: '/tmp',
          env: dockerCliEnvironment(cliConfig),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < maxCapturedBytes)
          stdout += chunk.toString('utf8').slice(0, maxCapturedBytes - stdout.length);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < maxCapturedBytes)
          stderr += chunk.toString('utf8').slice(0, maxCapturedBytes - stderr.length);
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(new SandboxError('unavailable'));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (signal === 'SIGKILL') {
          reject(new SandboxError('unavailable'));
          return;
        }
        resolve({ code: code ?? 128, stdout, stderr });
      });
    });
  }

  private async removeContainer(containerName: string, cliConfig: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.runDocker(
        ['rm', '--force', containerName],
        cliConfig,
        cleanupDeadlineMs,
      );
      if (result.code === 0 || /no such container/i.test(`${result.stderr}\n${result.stdout}`)) {
        return;
      }
      const inspected = await this.runDocker(
        ['inspect', '--type=container', containerName],
        cliConfig,
        cleanupDeadlineMs,
      );
      if (
        inspected.code !== 0 &&
        /no such (?:container|object)/i.test(`${inspected.stderr}\n${inspected.stdout}`)
      ) {
        return;
      }
      if (inspected.code !== 0) throw new SandboxError('termination_failed');
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    throw new SandboxError('termination_failed');
  }
}

function validateInput(
  input: {
    runId: string;
    argv: readonly string[];
    stdin?: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
  maxOutputBytes: number,
): void {
  if (!/^run-[0-9]{4,}$/.test(input.runId)) {
    throw new SandboxError('launch_failed');
  }
  if (
    !Array.isArray(input.argv) ||
    input.argv.length < 1 ||
    input.argv.length > maxArgvCount ||
    (input.argv[0] !== 'node' && input.argv[0] !== '/usr/local/bin/node') ||
    input.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
    input.argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > maxArgBytes ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 100 ||
    input.timeoutMs > maxExecutionMs ||
    (input.stdin !== undefined && Buffer.byteLength(input.stdin) > maxStdinBytes) ||
    !input.signal ||
    typeof input.signal.aborted !== 'boolean' ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1
  ) {
    throw new SandboxError('launch_failed');
  }
}

async function ensurePrivateRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  const uid = process.getuid?.() ?? 0;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
    throw new SandboxError('launch_failed');
  }
  await chmod(root, 0o700);
  await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
}

function dockerCliEnvironment(cliConfig: string): NodeJS.ProcessEnv {
  return {
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    DOCKER_CONFIG: cliConfig,
    HOME: cliConfig,
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
}
