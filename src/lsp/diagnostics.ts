import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getPaths } from '../util/paths.js';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
  source: string;
}

export interface DiagnosticResult {
  workspace: string;
  diagnostics: Diagnostic[];
  command?: string;
  skipped?: string;
  truncated: boolean;
}

const TSC_PATTERN = /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

async function executable(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try { await access(path); return path; } catch { /* try the next candidate */ }
  }
  return undefined;
}

async function findTsc(workspace: string): Promise<string | undefined> {
  const candidates: string[] = [];
  let directory = workspace;
  while (true) {
    candidates.push(join(directory, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  candidates.push(join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
  for (const pathDirectory of (process.env.PATH ?? '').split(delimiter)) {
    if (pathDirectory) candidates.push(join(pathDirectory, process.platform === 'win32' ? 'tsc.cmd' : 'tsc'));
  }
  return executable(candidates);
}

function parseTsc(output: string, workspace: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const match = TSC_PATTERN.exec(rawLine.trim());
    if (!match) continue;
    const absoluteFile = resolve(workspace, match[1]!);
    diagnostics.push({
      file: relative(workspace, absoluteFile) || match[1]!,
      line: Number(match[2]), column: Number(match[3]),
      severity: match[4] as 'error' | 'warning', code: match[5]!, message: match[6]!, source: 'tsc',
    });
  }
  return diagnostics;
}

async function run(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), DEFAULT_TIMEOUT_MS);
    const append = (chunk: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const kept = chunk.subarray(0, MAX_OUTPUT_BYTES - size);
      chunks.push(kept); size += kept.length;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    child.once('close', () => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      resolveOutput(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function collectDiagnostics(workspaceInput: string, options: { maxDiagnostics?: number; signal?: AbortSignal } = {}): Promise<DiagnosticResult> {
  const workspace = resolve(workspaceInput);
  const maxDiagnostics = Math.max(1, Math.floor(options.maxDiagnostics ?? 5));
  const tsc = await findTsc(workspace);
  if (!tsc) return { workspace, diagnostics: [], skipped: 'TypeScript compiler not found', truncated: false };
  try {
    const cacheDirectory = join(getPaths().home, 'cache', 'lsp');
    await mkdir(cacheDirectory, { recursive: true });
    const buildInfo = join(cacheDirectory, `${createHash('sha256').update(workspace).digest('hex')}.tsbuildinfo`);
    const args = ['--noEmit', '--pretty', 'false', '--incremental', '--tsBuildInfoFile', buildInfo];
    const output = await run(tsc, args, workspace, options.signal);
    const all = parseTsc(output, workspace);
    return { workspace, diagnostics: all.slice(0, maxDiagnostics), command: `${tsc} ${args.join(' ')}`, truncated: all.length > maxDiagnostics };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return { workspace, diagnostics: [], skipped: `Diagnostic command failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false };
  }
}

function fingerprint(diagnostic: Diagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}`;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  return `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} - ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
}

/** Per-agent-turn state used to compare write-time diagnostics and inject only new failures. */
export class DiagnosticFeedbackSession {
  private baseline = new Set<string>();
  private pending: Diagnostic[] = [];
  private injected = new Set<string>();
  private changedFiles = new Set<string>();
  private primed = false;

  constructor(
    private readonly workspace: string,
    private readonly maxDiagnostics: number,
    private readonly signal?: AbortSignal,
    private readonly collect: typeof collectDiagnostics = collectDiagnostics,
  ) {}

  async beforeWrite(): Promise<void> {
    if (this.primed) return;
    const result = await this.collect(this.workspace, { maxDiagnostics: 500, signal: this.signal });
    this.baseline = new Set(result.diagnostics.map(fingerprint));
    this.primed = true;
  }

  async afterWrite(pathInput: string): Promise<void> {
    if (!this.primed) await this.beforeWrite();
    const changed = isAbsolute(pathInput) ? relative(this.workspace, pathInput) : relative(this.workspace, resolve(this.workspace, pathInput));
    this.changedFiles.add(changed);
  }

  /** Coalesce all writes since the previous model request into one compiler pass. */
  async refresh(): Promise<void> {
    if (!this.changedFiles.size) return;
    const changedFiles = new Set(this.changedFiles);
    this.changedFiles.clear();
    const result = await this.collect(this.workspace, { maxDiagnostics: 500, signal: this.signal });
    const next = new Set(result.diagnostics.map(fingerprint));
    for (const diagnostic of result.diagnostics) {
      const key = fingerprint(diagnostic);
      if (changedFiles.has(diagnostic.file) && !this.baseline.has(key) && !this.injected.has(key) && !this.pending.some((item) => fingerprint(item) === key)) this.pending.push(diagnostic);
    }
    this.baseline = next;
  }

  takeInjection(): Diagnostic[] {
    const diagnostics = this.pending.slice(0, this.maxDiagnostics);
    for (const diagnostic of diagnostics) this.injected.add(fingerprint(diagnostic));
    this.pending = this.pending.slice(diagnostics.length);
    return diagnostics;
  }
}
