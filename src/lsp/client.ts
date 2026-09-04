// Minimal, dependency-free Language Server Protocol client.
//
// Spawns a configured language server over stdio, performs the initialize
// handshake, opens documents on demand, and issues textDocument/definition,
// textDocument/references, and textDocument/documentSymbol requests. Servers
// are resolved from the workspace's node_modules/.bin or PATH; a missing binary
// yields an actionable error instead of a crash. One client is cached per
// (workspace, server) and shut down after an idle period.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export interface LspServerConfig {
  command: string;
  args?: string[];
  extensions: string[];
  env?: Record<string, string>;
}

export interface LspPosition {
  /** 1-based line. */
  line: number;
  /** 1-based character (column). */
  character: number;
}

export interface LspLocationResult {
  file: string;
  line: number;
  character: number;
  endLine?: number;
  endCharacter?: number;
}

export interface LspSymbolResult {
  name: string;
  kind: string;
  detail?: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  children?: LspSymbolResult[];
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const SYMBOL_KINDS: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method', 7: 'Property',
  8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function', 13: 'Variable',
  14: 'Constant', 15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object',
  20: 'Key', 21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
};

const LANGUAGE_IDS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.go': 'go', '.rs': 'rust',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
};

export const DEFAULT_LSP_SERVERS: LspServerConfig[] = [
  { command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] },
  { command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py'] },
  { command: 'gopls', extensions: ['.go'] },
  { command: 'rust-analyzer', extensions: ['.rs'] },
  { command: 'clangd', extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp'] },
];

export class LspServerNotFoundError extends Error {
  constructor(command: string) {
    super(`Language server "${command}" was not found in node_modules/.bin or PATH. Install it to enable semantic navigation for this file type.`);
    this.name = 'LspServerNotFoundError';
  }
}

async function executable(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try { await access(path); return path; } catch { /* try the next candidate */ }
  }
  return undefined;
}

async function resolveServerCommand(command: string, workspace: string): Promise<string | undefined> {
  if (isAbsolute(command)) return (await executable([command])) ? command : undefined;
  const candidates: string[] = [];
  let directory = workspace;
  for (;;) {
    candidates.push(join(directory, 'node_modules', '.bin', command));
    if (process.platform === 'win32') candidates.push(join(directory, 'node_modules', '.bin', `${command}.cmd`));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const pathDirectory of (process.env.PATH ?? '').split(delimiter)) {
    if (!pathDirectory) continue;
    candidates.push(join(pathDirectory, command));
    if (process.platform === 'win32') candidates.push(join(pathDirectory, `${command}.cmd`));
  }
  return executable(candidates);
}

function toPosition(position: LspPosition): { line: number; character: number } {
  return { line: Math.max(0, Math.floor(position.line) - 1), character: Math.max(0, Math.floor(position.character) - 1) };
}

interface RawRange { start: { line: number; character: number }; end: { line: number; character: number } }

function rangeToFields(range: RawRange | undefined): { line: number; character: number; endLine: number; endCharacter: number } {
  if (!range) return { line: 1, character: 1, endLine: 1, endCharacter: 1 };
  return {
    line: (range.start?.line ?? 0) + 1,
    character: (range.start?.character ?? 0) + 1,
    endLine: (range.end?.line ?? 0) + 1,
    endCharacter: (range.end?.character ?? 0) + 1,
  };
}

function uriToRelativeFile(uri: string, workspace: string): string {
  try {
    const path = uri.startsWith('file:') ? fileURLToPath(uri) : uri;
    return relative(workspace, path) || path;
  } catch {
    return uri;
  }
}

class LspClient {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly opened = new Map<string, { version: number; hash: string }>();
  private ready?: Promise<void>;
  private closed = false;

  constructor(
    private readonly workspace: string,
    private readonly server: LspServerConfig,
    private readonly resolvedCommand: string,
    private readonly requestTimeoutMs: number,
    private readonly onClosed: () => void,
  ) {}

  private markClosed(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(error);
    this.onClosed();
  }

  private spawnAndInitialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const child = spawn(this.resolvedCommand, this.server.args ?? [], {
        cwd: this.workspace,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...(this.server.env ?? {}) },
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
      // Always consume stderr: an unread pipe can fill and deadlock a verbose server.
      child.stderr.resume();
      child.on('error', (error) => this.markClosed(error));
      child.on('close', () => this.markClosed(new Error(`Language server "${this.server.command}" exited`)));
      const rootUri = pathToFileURL(this.workspace).href;
      await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'taiwei', version: '1.0' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: basename(this.workspace) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
          workspace: { workspaceFolders: true, configuration: true },
          window: { workDoneProgress: false },
        },
      }, 30_000);
      this.notify('initialized', {});
    })();
    return this.ready;
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const total = headerEnd + 4 + length;
      if (this.buffer.length < total) break;
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      try { this.dispatch(JSON.parse(body) as JsonRpcMessage); }
      catch { /* ignore malformed frames */ }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      const id = typeof message.id === 'number' ? message.id : Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? `LSP error ${message.error.code ?? ''}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.id !== null && message.method) {
      // Server -> client request. Answer generically so servers keep working.
      const result = message.method === 'workspace/configuration'
        ? new Array(Array.isArray((message.params as { items?: unknown[] })?.items) ? (message.params as { items: unknown[] }).items.length : 1).fill({})
        : null;
      this.send({ jsonrpc: '2.0', id: message.id, result });
      return;
    }
    // Notifications (publishDiagnostics, logMessage, progress) are ignored.
  }

  private send(message: object): void {
    if (!this.child || this.closed) throw new Error('Language server is not running');
    const json = JSON.stringify(message);
    const bytes = Buffer.byteLength(json, 'utf8');
    this.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n`);
    this.child.stdin.write(json);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      if (signal?.aborted) { reject(new DOMException('LSP request cancelled', 'AbortError')); return; }
      const id = this.nextId++;
      const cleanup = () => { this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(new DOMException('LSP request cancelled', 'AbortError')); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolvePromise(value); },
        reject: (error) => { cleanup(); reject(error); },
        timer,
      });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { cleanup(); reject(error as Error); }
    });
  }

  private async ensureOpen(filePath: string, text: string): Promise<string> {
    await this.spawnAndInitialize();
    const uri = pathToFileURL(filePath).href;
    const hash = createHash('sha256').update(text).digest('hex');
    const existing = this.opened.get(uri);
    const languageId = LANGUAGE_IDS[extname(filePath).toLowerCase()] ?? 'plaintext';
    if (!existing) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
      this.opened.set(uri, { version: 1, hash });
    } else if (existing.hash !== hash) {
      const version = existing.version + 1;
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      this.opened.set(uri, { version, hash });
    }
    return uri;
  }

  async definition(filePath: string, text: string, position: LspPosition, signal?: AbortSignal): Promise<unknown> {
    const uri = await this.ensureOpen(filePath, text);
    return this.request('textDocument/definition', { textDocument: { uri }, position: toPosition(position) }, undefined, signal);
  }

  async references(filePath: string, text: string, position: LspPosition, signal?: AbortSignal): Promise<unknown> {
    const uri = await this.ensureOpen(filePath, text);
    return this.request('textDocument/references', { textDocument: { uri }, position: toPosition(position), context: { includeDeclaration: true } }, undefined, signal);
  }

  async documentSymbols(filePath: string, text: string, signal?: AbortSignal): Promise<unknown> {
    const uri = await this.ensureOpen(filePath, text);
    return this.request('textDocument/documentSymbol', { textDocument: { uri } }, undefined, signal);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.request('shutdown', null, 3_000); } catch { /* best effort */ }
    try { this.notify('exit', null); } catch { /* best effort */ }
    this.closed = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      const exited = await new Promise<boolean>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolveExit(true); return; }
        const onExit = () => { clearTimeout(timer); resolveExit(true); };
        const timer = setTimeout(() => { child.removeListener('exit', onExit); resolveExit(false); }, 2_000);
        child.once('exit', onExit);
      });
      if (!exited && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }
    this.failAll(new Error('Language server closed'));
  }
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly servers: LspServerConfig[] = DEFAULT_LSP_SERVERS,
    private readonly options: { idleMs?: number; requestTimeoutMs?: number } = {},
  ) {}

  private get idleMs(): number { return this.options.idleMs ?? 10 * 60_000; }
  private get requestTimeoutMs(): number { return this.options.requestTimeoutMs ?? 15_000; }

  serverForFile(filePath: string): LspServerConfig | undefined {
    const extension = extname(filePath).toLowerCase();
    return this.servers.find((server) => server.extensions.some((candidate) => candidate.toLowerCase() === extension));
  }

  private touch(key: string): void {
    const existing = this.idleTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => { void this.closeClient(key); }, this.idleMs);
    timer.unref?.();
    this.idleTimers.set(key, timer);
  }

  private async closeClient(key: string): Promise<void> {
    const client = this.clients.get(key);
    this.clients.delete(key);
    const timer = this.idleTimers.get(key);
    if (timer) { clearTimeout(timer); this.idleTimers.delete(key); }
    if (client) await client.close().catch(() => {});
  }

  private async clientFor(workspace: string, filePath: string): Promise<LspClient> {
    const server = this.serverForFile(filePath);
    if (!server) throw new Error(`No language server configured for "${extname(filePath) || filePath}" files. Configure lsp.servers to add one.`);
    const root = resolve(workspace);
    const key = `${root}\u0000${server.command}`;
    const cached = this.clients.get(key);
    if (cached) { this.touch(key); return cached; }
    const resolved = await resolveServerCommand(server.command, root);
    if (!resolved) throw new LspServerNotFoundError(server.command);
    const client = new LspClient(root, server, resolved, this.requestTimeoutMs, () => {
      if (this.clients.get(key) !== client) return;
      this.clients.delete(key);
      const timer = this.idleTimers.get(key);
      if (timer) { clearTimeout(timer); this.idleTimers.delete(key); }
    });
    this.clients.set(key, client);
    this.touch(key);
    return client;
  }

  private normalizeLocations(raw: unknown, workspace: string): LspLocationResult[] {
    const root = resolve(workspace);
    const locations: LspLocationResult[] = [];
    const pushLocation = (uri: string, range: RawRange | undefined) => {
      const fields = rangeToFields(range);
      locations.push({ file: uriToRelativeFile(uri, root), ...fields });
    };
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      const record = value as Record<string, unknown>;
      if (typeof record.targetUri === 'string') {
        pushLocation(record.targetUri, (record.targetSelectionRange ?? record.targetRange) as RawRange | undefined);
        return;
      }
      if (typeof record.uri === 'string') pushLocation(record.uri, record.range as RawRange | undefined);
    };
    visit(raw);
    return locations;
  }

  private normalizeSymbols(raw: unknown, workspace: string): LspSymbolResult[] {
    const root = resolve(workspace);
    const symbols: LspSymbolResult[] = [];
    const visit = (value: unknown, file?: string) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const item of value) visit(item, file); return; }
      const record = value as Record<string, unknown>;
      const kind = typeof record.kind === 'number' ? (SYMBOL_KINDS[record.kind] ?? 'Unknown') : 'Unknown';
      const name = typeof record.name === 'string' ? record.name : '';
      if (record.range && record.selectionRange) {
        // Hierarchical DocumentSymbol: push this node, then flatten its children.
        const fields = rangeToFields(record.range as RawRange);
        symbols.push({ name, kind, ...(typeof record.detail === 'string' ? { detail: record.detail } : {}), ...fields });
        if (Array.isArray(record.children)) visit(record.children, file);
        return;
      }
      if (record.location && typeof record.location === 'object') {
        // Flat SymbolInformation.
        const location = record.location as { uri?: string; range?: RawRange };
        const fields = rangeToFields(location.range);
        symbols.push({ name, kind, file: uriToRelativeFile(String(location.uri ?? file ?? ''), root), ...fields } as LspSymbolResult);
      }
    };
    visit(raw);
    return symbols;
  }

  async definition(workspace: string, filePath: string, text: string, position: LspPosition, signal?: AbortSignal): Promise<LspLocationResult[]> {
    const client = await this.clientFor(workspace, filePath);
    return this.normalizeLocations(await client.definition(filePath, text, position, signal), workspace);
  }

  async references(workspace: string, filePath: string, text: string, position: LspPosition, signal?: AbortSignal): Promise<LspLocationResult[]> {
    const client = await this.clientFor(workspace, filePath);
    return this.normalizeLocations(await client.references(filePath, text, position, signal), workspace);
  }

  async documentSymbols(workspace: string, filePath: string, text: string, signal?: AbortSignal): Promise<LspSymbolResult[]> {
    const client = await this.clientFor(workspace, filePath);
    return this.normalizeSymbols(await client.documentSymbols(filePath, text, signal), workspace);
  }

  async close(): Promise<void> {
    const keys = [...this.clients.keys()];
    await Promise.all(keys.map((key) => this.closeClient(key)));
  }
}
