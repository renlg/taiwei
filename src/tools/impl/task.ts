import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths } from '../../util/paths.js';
import type { ToolSpec } from '../registry.js';

interface TaskRecord {
  id: string;
  pid: number;
  cwd: string;
  startedAt: string;
  timeoutMs?: number;
  status: 'running' | 'completed' | 'timed_out' | 'killed';
  exitCode: number | null;
  exitSignal: string | null;
  exitedAt: string | null;
}

interface TaskRegistry {
  tasks: TaskRecord[];
}

const activeProcesses = new Map<string, ChildProcess>();
const POLL_INTERVAL_MS = 200;
const KILL_GRACE_MS = 3000;
const DEFAULT_WAIT_TIMEOUT_S = 3600;

function tasksDir(): string {
  return join(getPaths().home, 'tasks');
}

function registryPath(): string {
  return join(tasksDir(), 'registry.json');
}

async function ensureTasksDir(): Promise<void> {
  await mkdir(tasksDir(), { recursive: true });
}

async function loadRegistry(): Promise<TaskRegistry> {
  try {
    const data = await readFile(registryPath(), 'utf8');
    return JSON.parse(data) as TaskRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [] };
    if (error instanceof SyntaxError) return { tasks: [] };
    throw error;
  }
}

async function saveRegistry(registry: TaskRegistry): Promise<void> {
  await ensureTasksDir();
  await writeFile(registryPath(), JSON.stringify(registry, null, 2));
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function generateId(): string {
  return randomBytes(4).toString('hex');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function taskDir(id: string): string {
  return join(tasksDir(), id);
}

function startProcess(command: string, cwd: string, id: string, timeoutMs?: number): { child: ChildProcess; pid: number } {
  const dir = taskDir(id);
  const stdoutPath = join(dir, 'stdout.log');
  const stderrPath = join(dir, 'stderr.log');

  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!child.pid) throw new Error('Failed to start background process');
  if (!child.stdout || !child.stderr) throw new Error('Failed to pipe process output');

  child.stdout.on('data', (chunk: Buffer) => { appendFile(stdoutPath, chunk).catch(() => {}); });
  child.stderr.on('data', (chunk: Buffer) => { appendFile(stderrPath, chunk).catch(() => {}); });

  child.on('close', (code, signal) => {
    activeProcesses.delete(id);
    loadRegistry().then(async (registry) => {
      const task = registry.tasks.find((t) => t.id === id);
      if (task && task.status === 'running') {
        task.status = 'completed';
        task.exitCode = code;
        task.exitSignal = signal;
        task.exitedAt = new Date().toISOString();
      }
      await saveRegistry(registry);
    }).catch(() => {});
  });

  if (timeoutMs && timeoutMs > 0) {
    setTimeout(() => {
      if (isProcessAlive(child.pid!)) {
        loadRegistry().then(async (registry) => {
          const task = registry.tasks.find((t) => t.id === id);
          if (task && task.status === 'running') {
            task.status = 'timed_out';
            await saveRegistry(registry);
          }
        }).catch(() => {});
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          if (isProcessAlive(child.pid!)) {
            try { child.kill('SIGKILL'); } catch {}
          }
        }, KILL_GRACE_MS);
      }
    }, timeoutMs);
  }

  return { child, pid: child.pid };
}

async function readLog(id: string, stream: 'stdout' | 'stderr'): Promise<string> {
  try {
    const { readFile: rf } = await import('node:fs/promises');
    return await rf(join(taskDir(id), `${stream}.log`), 'utf8');
  } catch {
    return '';
  }
}

async function getTaskStatus(record: TaskRecord): Promise<TaskRecord> {
  if (record.status !== 'running') return record;
  if (!isProcessAlive(record.pid)) {
    record.status = 'completed';
    record.exitedAt = new Date().toISOString();
  }
  return record;
}

export const taskTools: ToolSpec[] = [
  {
    name: 'task_start',
    description: 'Start a long-running command as a detached background process. The process survives the current turn. stdout and stderr are logged to per-task files. Use task_wait to block until it finishes, task_poll for non-blocking status, or task_kill to stop it.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in the background.' },
        cwd: { type: 'string', description: 'Working directory for the command. Defaults to the current workspace.' },
        timeout_ms: { type: 'number', description: 'Safety-net wall-clock timeout in milliseconds. The process is killed after this duration. Omit for no automatic timeout.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(args, context) {
      const command = requiredString(args.command, 'command');
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : context.cwd;
      const timeoutMs = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? Math.floor(args.timeout_ms) : undefined;

      await ensureTasksDir();

      const id = generateId();
      await mkdir(taskDir(id), { recursive: true });

      const { child, pid } = startProcess(command, cwd, id, timeoutMs);
      activeProcesses.set(id, child);

      const record: TaskRecord = {
        id, pid, cwd,
        startedAt: new Date().toISOString(),
        timeoutMs,
        status: 'running',
        exitCode: null,
        exitSignal: null,
        exitedAt: null,
      };

      const registry = await loadRegistry();
      registry.tasks.push(record);
      await saveRegistry(registry);

      return { id, pid, cwd, startedAt: record.startedAt };
    },
  },

  {
    name: 'task_wait',
    description: 'Block until a background task finishes or the wait timeout expires. Returns the complete stdout, stderr, exit code, and duration. If the wait times out the task keeps running — use task_kill to stop it afterwards.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID returned by task_start.' },
        timeout_seconds: { type: 'number', description: `Maximum seconds to wait. Defaults to ${DEFAULT_WAIT_TIMEOUT_S}. The task is NOT killed on timeout.` },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = requiredString(args.id, 'id');
      const timeoutSeconds = typeof args.timeout_seconds === 'number' && args.timeout_seconds > 0
        ? args.timeout_seconds
        : DEFAULT_WAIT_TIMEOUT_S;

      const registry = await loadRegistry();
      const record = registry.tasks.find((t) => t.id === id);
      if (!record) return { error: `Task not found: ${id}` };

      const started = Date.now();
      const timeoutMs = timeoutSeconds * 1000;

      if (record.status !== 'running') {
        const stdout = await readLog(id, 'stdout');
        const stderr = await readLog(id, 'stderr');
        const duration = record.exitedAt ? Date.parse(record.exitedAt) - Date.parse(record.startedAt) : 0;
        return { id, status: record.status, stdout, stderr, exitCode: record.exitCode, exitSignal: record.exitSignal, duration };
      }

      while (Date.now() - started < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const updated = await loadRegistry();
        const task = updated.tasks.find((t) => t.id === id);
        if (!task) return { error: `Task disappeared: ${id}` };
        if (task.status !== 'running') {
          const stdout = await readLog(id, 'stdout');
          const stderr = await readLog(id, 'stderr');
          const duration = task.exitedAt ? Date.parse(task.exitedAt) - Date.parse(task.startedAt) : 0;
          return { id, status: task.status, stdout, stderr, exitCode: task.exitCode, exitSignal: task.exitSignal, duration };
        }
        if (!isProcessAlive(task.pid)) {
          task.status = 'completed';
          task.exitedAt = new Date().toISOString();
          await saveRegistry(updated);
          const stdout = await readLog(id, 'stdout');
          const stderr = await readLog(id, 'stderr');
          const duration = Date.parse(task.exitedAt) - Date.parse(task.startedAt);
          return { id, status: task.status, stdout, stderr, exitCode: task.exitCode, exitSignal: task.exitSignal, duration };
        }
      }

      const stdout = await readLog(id, 'stdout');
      const stderr = await readLog(id, 'stderr');
      const elapsed = Date.now() - Date.parse(record.startedAt);
      return { id, status: 'timed_out', stdout, stderr, exitCode: null, exitSignal: null, duration: elapsed };
    },
  },

  {
    name: 'task_poll',
    description: 'Non-blocking status check for a background task. Returns the current status, partial stdout/stderr, exit code (if finished), and uptime.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID returned by task_start.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = requiredString(args.id, 'id');

      const registry = await loadRegistry();
      const record = registry.tasks.find((t) => t.id === id);
      if (!record) return { error: `Task not found: ${id}` };

      const updated = await getTaskStatus({ ...record });
      if (updated.status !== record.status) {
        registry.tasks.find((t) => t.id === id)!.status = updated.status;
        await saveRegistry(registry);
      }

      const stdout = await readLog(id, 'stdout');
      const stderr = await readLog(id, 'stderr');
      const uptime = Date.now() - Date.parse(record.startedAt);

      return {
        id,
        pid: record.pid,
        status: updated.status,
        stdout,
        stderr,
        exitCode: updated.exitCode,
        exitSignal: updated.exitSignal,
        uptime,
      };
    },
  },

  {
    name: 'task_kill',
    description: 'Terminate a background task. Sends SIGTERM first, then SIGKILL after a 3-second grace period if the process has not exited. No-op for tasks that have already finished.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID returned by task_start.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = requiredString(args.id, 'id');

      const registry = await loadRegistry();
      const record = registry.tasks.find((t) => t.id === id);
      if (!record) return { error: `Task not found: ${id}` };

      if (record.status !== 'running') {
        if (!isProcessAlive(record.pid)) {
          return { id, status: record.status, killed: false, message: 'Task already finished' };
        }
      }

      const child = activeProcesses.get(id);

      try { process.kill(record.pid, 'SIGTERM'); } catch {}

      let killed = false;
      for (let i = 0; i < KILL_GRACE_MS / POLL_INTERVAL_MS; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (!isProcessAlive(record.pid)) {
          killed = true;
          break;
        }
      }

      if (!killed && isProcessAlive(record.pid)) {
        try { process.kill(record.pid, 'SIGKILL'); } catch {}
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        killed = !isProcessAlive(record.pid);
      }

      if (child) activeProcesses.delete(id);

      const updated = await loadRegistry();
      const task = updated.tasks.find((t) => t.id === id);
      if (task && task.status === 'running') {
        task.status = 'killed';
        task.exitedAt = new Date().toISOString();
        await saveRegistry(updated);
      }

      const stdout = await readLog(id, 'stdout');
      const stderr = await readLog(id, 'stderr');

      return { id, status: 'killed', killed: true, stdout, stderr };
    },
  },
];
