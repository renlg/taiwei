import { createHash } from 'node:crypto';
import type { GatewayFolder } from './folders.js';
import type { GatewaySession, SessionToolCall } from './sessions.js';

export function legacyGuestIdForUsername(username: string): string {
  const safe = username.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `guest-${safe || 'user'}`;
}

export function legacyGuestIdForShareToken(token: string): string {
  return `guest-${token.slice(0, 8).toLowerCase()}`;
}

export function guestIdForShareToken(token: string): string {
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 24);
  return `guest-share-${digest}`;
}

export function publicApiRouteAllowed(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/api/health') return true;
  if (method === 'POST' && pathname === '/api/login') return true;
  if (method === 'POST' && pathname === '/api/oauth/start') return true;
  return method === 'GET' && pathname === '/api/oauth/callback';
}

interface GuestPublicAttachment { name: string; type?: string }
interface GuestPublicMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: GuestPublicAttachment[];
  toolCalls?: SessionToolCall[];
  timestamp: string;
  status?: 'stopped' | 'error' | 'pending';
}

export function guestPublicSession(session: GatewaySession): Omit<GatewaySession, 'messages' | 'contextMessages' | 'identity'> & { messages: GuestPublicMessage[] } {
  const messages = session.messages.map((message): GuestPublicMessage => ({
    role: message.role,
    content: message.content,
    ...(message.attachments?.length ? { attachments: message.attachments.map(({ name, type }) => ({ name, ...(type ? { type } : {}) })) } : {}),
    ...(message.toolCalls?.length ? { toolCalls: message.toolCalls } : {}),
    timestamp: message.timestamp,
    ...(message.status ? { status: message.status } : {}),
  }));
  const { contextMessages: _contextMessages, identity: _identity, messages: _messages, ...metadata } = session;
  return { ...metadata, messages };
}

export type GuestPublicFolder = Omit<GatewayFolder, 'path' | 'dirName'>;

export function guestPublicFolder({ path: _path, dirName: _dirName, ...folder }: GatewayFolder): GuestPublicFolder {
  return folder;
}

export function guestRouteAllowed(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/api/info') return true;
  if (method === 'POST' && pathname === '/api/chat') return true;
  if (method === 'POST' && pathname === '/api/upload') return true;
  if (method === 'POST' && pathname === '/api/stop') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/sessions') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/folders') return true;
  if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/folders\/[^/]+$/.test(pathname)) return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/models') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/model') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/agents') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/agent') return true;
  if (method === 'GET' && pathname === '/api/skills') return true;
  if (method === 'POST' && pathname === '/api/skills/install') return true;
  if ((method === 'POST' || method === 'DELETE') && /^\/api\/skills\/[^/]+$/.test(pathname)) return true;
  if (method === 'GET' && /^\/api\/skills\/[^/]+$/.test(pathname)) return true;
  if ((method === 'GET' || method === 'POST' || method === 'DELETE') && /^\/api\/user-skills(\/[^/]+(\/[^/]+)?)?$/.test(pathname)) return true;
  if (method === 'GET' && pathname === '/api/auth/gitea-user') return true;
  if ((method === 'GET' || method === 'POST') && pathname === '/api/deployments') return true;
  if (method === 'GET' && pathname === '/api/deployments/doctor') return true;
  if (method === 'DELETE' && /^\/api\/deployments\/[^/]+$/.test(pathname)) return true;
  if (method === 'GET' && /^\/api\/sessions\/[^/]+\/pending$/.test(pathname)) return true;
  return (method === 'GET' || method === 'DELETE') && /^\/api\/sessions\/[^/]+$/.test(pathname);
}
