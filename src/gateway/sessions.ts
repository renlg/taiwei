import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from '../llm/client.js';
import { getPaths } from '../util/paths.js';

export interface SessionToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface SessionAttachment {
  name: string;
  url: string;
  type?: string;
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  agentContent?: string;
  attachments?: SessionAttachment[];
  toolCalls?: SessionToolCall[];
  timestamp: string;
  status?: 'stopped' | 'error' | 'pending';
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  model: string;
  compressed?: boolean;
}

export interface SessionIdentity {
  role: 'admin' | 'guest';
  username: string;
  accountName?: string;
  osUsername?: string;
  giteaUsername?: string;
  giteaOrgName?: string;
}

export interface GatewaySession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  /** Agent-ready history, including compressed summaries and tool-call messages. */
  contextMessages?: ChatMessage[];
  usage?: SessionUsage;
  agentId?: string;
  providerId?: string;
  currentModel?: string;
  folderId?: string;
  identity?: SessionIdentity;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  folderId?: string;
  running?: boolean;
}

const VALID_ID = /^[a-f0-9-]{36}$/i;

function hasValidToolArguments(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeContextMessages(messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = [];
  let removedToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      removedToolCallIds = new Set<string>();
      const validCalls = message.tool_calls.filter((call) => {
        const valid = hasValidToolArguments(call?.function?.arguments);
        if (!valid && typeof call?.id === 'string') removedToolCallIds.add(call.id);
        return valid;
      });
      if (validCalls.length === 0) continue;
      sanitized.push(validCalls.length === message.tool_calls.length
        ? message
        : { ...message, tool_calls: validCalls });
      continue;
    }

    if (message.role === 'tool') {
      if (!removedToolCallIds.has(message.tool_call_id)) sanitized.push(message);
      continue;
    }

    removedToolCallIds = new Set<string>();
    sanitized.push(message);
  }

  return sanitized;
}

export class SessionStore {
  constructor(private readonly directory = getPaths().sessions) {}

  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

  async finalizeStalePending(message = '上次运行因网关重启而中断。'): Promise<number> {
    await this.initialize();
    const files = await readdir(this.directory, { withFileTypes: true });
    let finalized = 0;
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const session = await this.readFile(join(this.directory, entry.name));
        const pending = session.messages.at(-1);
        if (pending?.role !== 'assistant' || pending.status !== 'pending') continue;
        pending.status = 'stopped';
        if (!pending.content.trim()) pending.content = message;
        session.updatedAt = new Date().toISOString();
        await this.save(session);
        finalized += 1;
      } catch { /* A malformed session must not prevent gateway startup. */ }
    }
    return finalized;
  }

  async create(agentId = 'build', folderId?: string, currentModel?: string, providerId?: string, identity?: SessionIdentity): Promise<GatewaySession> {
    const now = new Date().toISOString();
    const session: GatewaySession = {
      id: randomUUID(), title: '新会话', createdAt: now, updatedAt: now, messages: [], agentId,
      ...(folderId ? { folderId } : {}), ...(currentModel ? { currentModel } : {}), ...(providerId ? { providerId } : {}),
      ...(identity ? { identity } : {}),
    };
    await this.save(session);
    return session;
  }

  async list(): Promise<SessionSummary[]> {
    await this.initialize();
    const files = await readdir(this.directory, { withFileTypes: true });
    const sessions = await Promise.all(files
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => {
        try { return await this.readFile(join(this.directory, entry.name)); }
        catch { return undefined; }
      }));
    return sessions
      .filter((session): session is GatewaySession => Boolean(session))
      .map((session) => {
        const last = session.messages.at(-1);
        const running = last?.role === 'assistant' && last.status === 'pending';
        return {
          id: session.id,
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages.length,
          ...(session.folderId ? { folderId: session.folderId } : {}),
          ...(running ? { running: true } : {}),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findBlankSession(folderId: string): Promise<GatewaySession | undefined> {
    const summaries = await this.list();
    for (const summary of summaries) {
      if (summary.folderId !== folderId) continue;
      if (summary.title !== '新会话') continue;
      if (summary.messageCount !== 0) continue;
      return this.get(summary.id);
    }
    return undefined;
  }

  async get(id: string): Promise<GatewaySession | undefined> {
    if (!VALID_ID.test(id)) return undefined;
    try { return await this.readFile(this.path(id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async save(session: GatewaySession): Promise<void> {
    if (!VALID_ID.test(session.id)) throw new Error('Invalid session id');
    await this.initialize();
    const path = this.path(session.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  async delete(id: string): Promise<boolean> {
    if (!VALID_ID.test(id)) return false;
    try { await unlink(this.path(id)); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  async moveFolderSessions(folderId: string, destinationFolderId: string): Promise<number> {
    const summaries = await this.list();
    let moved = 0;
    for (const summary of summaries) {
      if (summary.folderId !== folderId) continue;
      const session = await this.get(summary.id);
      if (!session) continue;
      session.folderId = destinationFolderId;
      session.updatedAt = new Date().toISOString();
      await this.save(session);
      moved += 1;
    }
    return moved;
  }

  toChatHistory(session: GatewaySession): ChatMessage[] {
    return session.contextMessages
      ? sanitizeContextMessages(structuredClone(session.contextMessages))
      : session.messages.map((message) => ({ role: message.role, content: message.agentContent ?? message.content }));
  }

  titleFrom(message: string): string {
    const clean = message.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    const characters = Array.from(clean);
    return characters.length > 20 ? `${characters.slice(0, 20).join('')}…` : clean;
  }

  private path(id: string): string { return join(this.directory, `${id}.json`); }

  private async readFile(path: string): Promise<GatewaySession> {
    const value = JSON.parse(await readFile(path, 'utf8')) as GatewaySession;
    if (!value || typeof value.id !== 'string' || !Array.isArray(value.messages)) throw new Error(`Invalid session file: ${path}`);
    return value;
  }
}
