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

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  agentContent?: string;
  toolCalls?: SessionToolCall[];
  timestamp: string;
  status?: 'stopped' | 'error';
}

export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  model: string;
}

export interface GatewaySession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
  usage?: SessionUsage;
  agentId?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

const VALID_ID = /^[a-f0-9-]{36}$/i;

export class SessionStore {
  constructor(private readonly directory = getPaths().sessions) {}

  async initialize(): Promise<void> { await mkdir(this.directory, { recursive: true }); }

  async create(agentId = 'build'): Promise<GatewaySession> {
    const now = new Date().toISOString();
    const session: GatewaySession = { id: randomUUID(), title: '新会话', createdAt: now, updatedAt: now, messages: [], agentId };
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
      .map(({ id, title, updatedAt, messages }) => ({ id, title, updatedAt, messageCount: messages.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  toChatHistory(session: GatewaySession): ChatMessage[] {
    return session.messages.map((message) => ({ role: message.role, content: message.agentContent ?? message.content }));
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
