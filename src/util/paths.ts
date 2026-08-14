import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, access } from 'node:fs/promises';

export interface TaiweiPaths {
  home: string;
  config: string;
  cron: string;
  mcp: string;
  memory: string;
  memoryDir: string;
  skills: string;
  knowledge: string;
  ragIndex: string;
  plugins: string;
  sessions: string;
  historyDb: string;
  gatewaySessions: string;
  loginLocks: string;
  uploads: string;
  guests: string;
}

export function getPaths(): TaiweiPaths {
  const home = process.env.TAIWEI_HOME || join(homedir(), '.taiwei');
  return {
    home,
    config: join(home, 'config.json'),
    cron: join(home, 'cron.json'),
    mcp: join(home, 'mcp.json'),
    memory: join(home, 'memory.md'),
    memoryDir: join(home, 'memory'),
    skills: join(home, 'skills'),
    knowledge: join(home, 'knowledge'),
    ragIndex: join(home, 'rag-index.json'),
    plugins: join(home, 'plugins'),
    sessions: join(home, 'sessions'),
    historyDb: join(home, 'history.db'),
    gatewaySessions: join(home, 'gateway-sessions.json'),
    loginLocks: join(home, 'login-locks.json'),
    uploads: join(home, 'uploads'),
    guests: join(home, 'guests'),
  };
}

const VALID_GUEST_ID = /^[a-z0-9_-]{1,64}$/;

export function guestMemory(guestId: string): string {
  if (!VALID_GUEST_ID.test(guestId)) throw new Error('Invalid guest id');
  return join(getPaths().guests, guestId, 'memory.md');
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, content, 'utf8');
  }
}

export async function ensureTaiweiHome(): Promise<TaiweiPaths> {
  const paths = getPaths();
  await Promise.all([
    mkdir(paths.home, { recursive: true }),
    mkdir(paths.skills, { recursive: true }),
    mkdir(paths.knowledge, { recursive: true }),
    mkdir(paths.memoryDir, { recursive: true }),
    mkdir(paths.plugins, { recursive: true }),
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.uploads, { recursive: true }),
    mkdir(paths.guests, { recursive: true }),
  ]);
  await Promise.all([
    writeIfMissing(paths.cron, '[]\n'),
    writeIfMissing(paths.mcp, '[]\n'),
    writeIfMissing(paths.memory, ''),
  ]);
  return paths;
}
