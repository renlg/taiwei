import { spawn } from 'node:child_process';

export const HOOK_EVENTS = ['beforeMessage', 'beforeLLM', 'afterLLM', 'beforeTool', 'afterTool'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export type HookCommands = Record<HookEvent, string[]>;

export interface HookPayload {
  event: HookEvent;
  timestamp: number;
  workspace: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface HookResponse {
  block?: boolean;
  reason?: string;
  extraContext?: string;
  [key: string]: unknown;
}

export interface HookExecution {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  response?: HookResponse;
}

export interface HookRunResult {
  block?: boolean;
  reason?: string;
  extraContext?: string;
  executions: HookExecution[];
}

type HookLogger = (message: string) => void;

export class HookRunner {
  private commands: HookCommands;
  private timeoutMs: number;
  private workspace: string;

  constructor(commands: HookCommands, timeoutSeconds = 10, workspace = process.cwd(), private readonly log: HookLogger = console.error) {
    this.commands = cloneCommands(commands);
    this.timeoutMs = normalizeTimeout(timeoutSeconds);
    this.workspace = workspace;
  }

  configure(commands: HookCommands, timeoutSeconds = 10, workspace = process.cwd()): void {
    this.commands = cloneCommands(commands);
    this.timeoutMs = normalizeTimeout(timeoutSeconds);
    this.workspace = workspace;
  }

  async run(event: HookEvent, fields: Record<string, unknown> = {}): Promise<HookRunResult> {
    const payload: HookPayload = { event, timestamp: Date.now(), workspace: this.workspace, ...fields };
    const executions: HookExecution[] = [];
    const contexts: string[] = [];
    for (const command of this.commands[event]) {
      const execution = await this.execute(command, payload);
      executions.push(execution);
      if (typeof execution.response?.extraContext === 'string' && execution.response.extraContext.trim()) {
        contexts.push(execution.response.extraContext);
      }
      if (execution.response?.block === true) {
        return {
          block: true,
          reason: typeof execution.response.reason === 'string' && execution.response.reason.trim()
            ? execution.response.reason.trim()
            : `Blocked by ${event} hook`,
          ...(contexts.length ? { extraContext: contexts.join('\n\n') } : {}),
          executions,
        };
      }
    }
    return { ...(contexts.length ? { extraContext: contexts.join('\n\n') } : {}), executions };
  }

  async test(command: string, event: HookEvent, fields: Record<string, unknown> = {}): Promise<HookExecution> {
    return this.execute(command, { event, timestamp: Date.now(), workspace: this.workspace, ...fields });
  }

  private async execute(command: string, payload: HookPayload): Promise<HookExecution> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(process.env.SHELL || '/bin/sh', ['-lc', command], {
          cwd: this.workspace,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[taiwei] Hook ${payload.event} could not start: ${command}\n${message}`);
        resolve({ command, stdout: '', stderr: message, exitCode: null, timedOut: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let response: HookResponse | undefined;
        const trimmed = stdout.trim();
        if (trimmed && !timedOut) {
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) response = parsed as HookResponse;
            else this.log(`[taiwei] Hook ${payload.event} returned JSON that is not an object; ignoring stdout`);
          } catch {
            this.log(`[taiwei] Hook ${payload.event} returned non-JSON stdout; ignoring: ${trimmed.slice(0, 500)}`);
          }
        }
        if (timedOut) this.log(`[taiwei] Hook ${payload.event} timed out after ${this.timeoutMs / 1_000}s: ${command}`);
        else if (exitCode !== 0) this.log(`[taiwei] Hook ${payload.event} failed with exit code ${exitCode}: ${command}`);
        if (stderr.trim()) this.log(`[taiwei] Hook ${payload.event} stderr (${command}):\n${stderr.trim()}`);
        resolve({ command, stdout, stderr, exitCode, timedOut, ...(response ? { response } : {}) });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        const forceTimer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, 250);
        forceTimer.unref();
      }, this.timeoutMs);
      timer.unref();
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        stderr += `${stderr ? '\n' : ''}${error.message}`;
        this.log(`[taiwei] Hook ${payload.event} could not start: ${command}\n${error.message}`);
        finish(null);
      });
      child.once('close', (code) => finish(code));
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }
}

function normalizeTimeout(seconds: number): number {
  return Math.max(1, Number.isFinite(seconds) ? seconds : 10) * 1_000;
}

function cloneCommands(commands: HookCommands): HookCommands {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, [...(commands[event] ?? [])]])) as unknown as HookCommands;
}
