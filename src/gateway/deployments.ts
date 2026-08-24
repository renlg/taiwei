import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getPaths } from '../util/paths.js';

type DatabaseSync = import('node:sqlite').DatabaseSync;

const execFileAsync = promisify(execFile);
export const DEPLOYMENT_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
export const OWNER_HASH_PATTERN = /^[a-f0-9]{8,64}$/;
export const DEPLOYMENT_STATUSES = ['running', 'stopped', 'cleaned', 'failed'] as const;

export type DeploymentStatus = typeof DEPLOYMENT_STATUSES[number];

export interface DeploymentRecord {
  id: number;
  name: string;
  ownerHash: string;
  path: string;
  port: number;
  dir: string;
  status: DeploymentStatus;
  url: string;
  repo: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeploymentInput {
  name: string;
  ownerHash: string;
  path: string;
  port: number;
  dir: string;
  status: DeploymentStatus;
  url: string;
  repo?: string | null;
}

export interface CleanupStep {
  step: 'stop_port' | 'delete_files' | 'remove_nginx';
  status: 'ok' | 'skipped' | 'failed';
  message: string;
}

export interface DeploymentDoctorResult {
  deployment: DeploymentRecord;
  desired: Pick<DeploymentRecord, 'status' | 'port' | 'path' | 'dir'>;
  observed: {
    port: { state: 'listening' | 'not_listening' | 'unknown'; listening: boolean | null; pids: number[]; message: string };
    nginx: { state: 'configured' | 'missing' | 'unknown'; configured: boolean | null; message: string };
    directory: { state: 'present' | 'missing' | 'unknown'; exists: boolean | null; message: string };
  };
  healthy: boolean;
}

export interface DeploymentRepository {
  initialize(): Promise<void>;
  listDeployments(): Promise<DeploymentRecord[]>;
  getDeployment(name: string, ownerHash?: string): Promise<DeploymentRecord | undefined>;
  upsertDeployment(input: DeploymentInput): Promise<DeploymentRecord>;
  markCleaned(id: number): Promise<void>;
  close?(): void;
}

interface DeploymentRow {
  id: number;
  name: string;
  owner_hash: string;
  path: string;
  port: number;
  dir: string;
  status: DeploymentStatus;
  url: string;
  repo: string | null;
  created_at: number;
  updated_at: number;
}

function mapRow(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    name: row.name,
    ownerHash: row.owner_hash,
    path: row.path,
    port: row.port,
    dir: row.dir,
    status: row.status,
    url: row.url,
    repo: row.repo ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DeploymentStore implements DeploymentRepository {
  private database?: Promise<DatabaseSync>;
  private opened?: DatabaseSync;

  constructor(private readonly databasePath = getPaths().historyDb) {}

  async initialize(): Promise<void> { await this.open(); }

  private async open(): Promise<DatabaseSync> {
    if (!this.database) {
      this.database = (async () => {
        const { DatabaseSync } = await import('node:sqlite');
        await mkdir(dirname(this.databasePath), { recursive: true });
        const db = new DatabaseSync(this.databasePath);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          CREATE TABLE IF NOT EXISTS deployments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            owner_hash TEXT NOT NULL,
            path TEXT NOT NULL,
            port INTEGER NOT NULL,
            dir TEXT NOT NULL,
            status TEXT NOT NULL,
            url TEXT NOT NULL,
            repo TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            UNIQUE(name, owner_hash)
          );
          CREATE INDEX IF NOT EXISTS idx_deployments_owner_name ON deployments(owner_hash, name);
          CREATE INDEX IF NOT EXISTS idx_deployments_updated_at ON deployments(updated_at DESC);
        `);
        const columns = db.prepare('PRAGMA table_info(deployments)').all() as Array<{ name: string }>;
        if (!columns.some((col) => col.name === 'repo')) {
          db.exec('ALTER TABLE deployments ADD COLUMN repo TEXT');
        }
        this.opened = db;
        return db;
      })().catch((error) => {
        this.database = undefined;
        throw error;
      });
    }
    return this.database;
  }

  async listDeployments(): Promise<DeploymentRecord[]> {
    const rows = (await this.open()).prepare('SELECT * FROM deployments ORDER BY created_at DESC, id DESC').all() as unknown as DeploymentRow[];
    return rows.map(mapRow);
  }

  async getDeployment(name: string, ownerHash?: string): Promise<DeploymentRecord | undefined> {
    const db = await this.open();
    if (ownerHash) {
      const row = db.prepare('SELECT * FROM deployments WHERE name = ? AND owner_hash = ?').get(name, ownerHash) as DeploymentRow | undefined;
      return row ? mapRow(row) : undefined;
    }
    const rows = db.prepare('SELECT * FROM deployments WHERE name = ? ORDER BY updated_at DESC LIMIT 2').all(name) as unknown as DeploymentRow[];
    if (rows.length > 1) throw new Error('Multiple deployments have this name; ownerHash is required');
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async upsertDeployment(input: DeploymentInput): Promise<DeploymentRecord> {
    const db = await this.open();
    const now = Date.now();
    db.prepare(`
      INSERT INTO deployments(name, owner_hash, path, port, dir, status, url, repo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name, owner_hash) DO UPDATE SET
        path = excluded.path,
        port = excluded.port,
        dir = excluded.dir,
        status = excluded.status,
        url = excluded.url,
        repo = excluded.repo,
        updated_at = excluded.updated_at
    `).run(input.name, input.ownerHash, input.path, input.port, input.dir, input.status, input.url, input.repo ?? null, now, now);
    return (await this.getDeployment(input.name, input.ownerHash))!;
  }

  async markCleaned(id: number): Promise<void> {
    (await this.open()).prepare("UPDATE deployments SET status = 'cleaned', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  close(): void {
    const opened = this.opened;
    this.opened = undefined;
    this.database = undefined;
    if (opened) opened.close();
  }
}

export function validateDeploymentInput(
  value: unknown,
  projectsRoot = join(getPaths().home, 'projects'),
  workspaceDirectories: readonly string[] = [],
  guestProjectsRoots: readonly string[] = [],
): DeploymentInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be an object');
  const body = value as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const ownerHash = typeof body.ownerHash === 'string' ? body.ownerHash.trim() : '';
  if (!DEPLOYMENT_NAME_PATTERN.test(name)) throw new Error('name must match ^[a-z0-9-]+$');
  if (!OWNER_HASH_PATTERN.test(ownerHash)) throw new Error('ownerHash must contain 8-64 lowercase hexadecimal characters');
  if (!Number.isInteger(body.port) || Number(body.port) < 1 || Number(body.port) > 65535) throw new Error('port must be an integer from 1 to 65535');
  const expectedPath = `/taiwei/${ownerHash}/${name}/`;
  if (body.path !== expectedPath) throw new Error(`path must be ${expectedPath}`);
  if (typeof body.dir !== 'string' || !isAbsolute(body.dir)) throw new Error('dir must be an absolute path');
  const legacyDir = resolve(projectsRoot, ownerHash, name);
  const submittedDir = resolve(body.dir);
  const sessionDir = workspaceDirectories.map((directory) => resolve(directory)).find((directory) => directory === submittedDir);
  const guestProjectDir = guestProjectsRoots
    .map((root) => resolve(root))
    .map((root) => resolve(root, name))
    .find((directory) => directory === submittedDir);
  if (!sessionDir && !guestProjectDir && submittedDir !== legacyDir) throw new Error(`dir must be a current session workspace or ${legacyDir}`);
  const deploymentDir = sessionDir ?? guestProjectDir ?? legacyDir;
  if (typeof body.url !== 'string' || !body.url.trim()) throw new Error('url is required');
  const url = body.url.trim();
  if (url !== expectedPath) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('url must be an http(s) URL or the deployment path'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must use http or https');
  }
  if (!DEPLOYMENT_STATUSES.includes(body.status as DeploymentStatus)) throw new Error(`status must be one of: ${DEPLOYMENT_STATUSES.join(', ')}`);
  let repo: string | null = null;
  if (body.repo !== undefined && body.repo !== null) {
    if (typeof body.repo !== 'string') throw new Error('repo must be a string');
    const trimmed = body.repo.trim();
    if (trimmed) {
      if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/.test(trimmed)) throw new Error('repo must be owner/name or a bare name');
      repo = trimmed;
    }
  }
  return { name, ownerHash, path: expectedPath, port: Number(body.port), dir: deploymentDir, url, status: body.status as DeploymentStatus, repo };
}

async function executableResult(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { timeout: 8_000, maxBuffer: 1024 * 1024 });
}

async function listeningPids(port: number): Promise<number[]> {
  let inspected = false;
  try {
    const { stdout } = await executableResult('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    inspected = true;
    return [...new Set(stdout.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inspected = true;
  }
  try {
    const { stdout } = await executableResult('ss', ['-ltnp']);
    inspected = true;
    const pids: number[] = [];
    for (const line of stdout.split('\n')) {
      if (!new RegExp(`:${port}(?:\\s|$)`).test(line)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) pids.push(Number(match[1]));
    }
    return [...new Set(pids)];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') inspected = true;
  }
  if (!inspected) throw new Error('Neither lsof nor ss is available to inspect the port');
  return [];
}

/** 只读检查部署的进程、nginx location 与目录，不执行任何修复。 */
export async function inspectDeployment(
  record: DeploymentRecord,
  options: { locationsPath?: string } = {},
): Promise<DeploymentDoctorResult> {
  let port: DeploymentDoctorResult['observed']['port'];
  try {
    const pids = await listeningPids(record.port);
    port = pids.length
      ? { state: 'listening', listening: true, pids, message: `端口 ${record.port} 正在监听（PID ${pids.join(', ')}）` }
      : { state: 'not_listening', listening: false, pids: [], message: `端口 ${record.port} 未监听` };
  } catch (error) {
    port = { state: 'unknown', listening: null, pids: [], message: `无法检查端口：${(error as Error).message}` };
  }

  const locationsPath = options.locationsPath ?? '/etc/nginx/taiwei-projects-locations.conf';
  let nginx: DeploymentDoctorResult['observed']['nginx'];
  try {
    const locations = await readFile(locationsPath, 'utf8');
    const configured = locations.includes(`location ${record.path}`);
    nginx = configured
      ? { state: 'configured', configured: true, message: `已找到 nginx location ${record.path}` }
      : { state: 'missing', configured: false, message: `nginx location 中未找到 ${record.path}` };
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    nginx = {
      state: 'unknown', configured: null,
      message: detail.code === 'ENOENT' ? `nginx locations 文件不存在：${locationsPath}` : `无法读取 nginx locations：${detail.message}`,
    };
  }

  let directory: DeploymentDoctorResult['observed']['directory'];
  try {
    const info = await stat(record.dir);
    const exists = info.isDirectory();
    directory = exists
      ? { state: 'present', exists: true, message: `目录存在：${record.dir}` }
      : { state: 'missing', exists: false, message: `路径存在但不是目录：${record.dir}` };
  } catch (error) {
    const detail = error as NodeJS.ErrnoException;
    directory = detail.code === 'ENOENT'
      ? { state: 'missing', exists: false, message: `目录不存在：${record.dir}` }
      : { state: 'unknown', exists: null, message: `无法检查目录：${detail.message}` };
  }

  const healthy = record.status === 'running'
    ? port.listening === true && nginx.configured === true && directory.exists === true
    : record.status === 'stopped'
      ? port.listening === false && nginx.configured === true && directory.exists === true
      : record.status === 'cleaned'
        ? port.listening === false && nginx.configured === false && directory.exists === false
        : false;
  return {
    deployment: record,
    desired: { status: record.status, port: record.port, path: record.path, dir: record.dir },
    observed: { port, nginx, directory },
    healthy,
  };
}

async function stopPort(port: number): Promise<CleanupStep> {
  try {
    const pids = await listeningPids(port);
    if (!pids.length) return { step: 'stop_port', status: 'skipped', message: `No process is listening on port ${port}` };
    const failures: string[] = [];
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); }
      catch (error) { failures.push(`PID ${pid}: ${(error as Error).message}`); }
    }
    if (failures.length) return { step: 'stop_port', status: 'failed', message: failures.join('; ') };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
    for (const pid of pids) {
      try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(`PID ${pid}: ${(error as Error).message}`); }
    }
    return failures.length
      ? { step: 'stop_port', status: 'failed', message: failures.join('; ') }
      : { step: 'stop_port', status: 'ok', message: `Stopped PID ${pids.join(', ')} on port ${port}` };
  } catch (error) {
    return { step: 'stop_port', status: 'failed', message: (error as Error).message };
  }
}

async function safeProjectDirectory(directory: string, projectsRoot: string, workspaceDirectories: readonly string[]): Promise<string> {
  const root = resolve(projectsRoot);
  const target = resolve(directory);
  const child = relative(root, target);
  const workspace = workspaceDirectories.map((directory) => resolve(directory)).find((directory) => directory === target);
  const legacyProject = Boolean(child) && !child.startsWith('..') && !isAbsolute(child);
  if (!legacyProject && !workspace) throw new Error(`Refusing to delete path outside the projects root or registered workspaces`);
  try {
    const realTarget = await realpath(target);
    if (workspace) {
      if (realTarget !== await realpath(workspace)) throw new Error('Refusing to delete a workspace symlink target');
    } else {
      const realRoot = await realpath(root);
      const realChild = relative(realRoot, realTarget);
      if (!realChild || realChild.startsWith('..') || isAbsolute(realChild)) throw new Error(`Refusing to delete symlink target outside ${root}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

export async function cleanupDeployment(record: DeploymentRecord, options: { projectsRoot?: string; skillsRoot?: string; workspaceDirectories?: readonly string[] } = {}): Promise<CleanupStep[]> {
  const projectsRoot = options.projectsRoot ?? join(getPaths().home, 'projects');
  const skillsRoot = options.skillsRoot ?? getPaths().skills;
  const steps: CleanupStep[] = [await stopPort(record.port)];
  try {
    const target = await safeProjectDirectory(record.dir, projectsRoot, options.workspaceDirectories ?? []);
    await rm(target, { recursive: true, force: true });
    steps.push({ step: 'delete_files', status: 'ok', message: `Deleted ${target}` });
  } catch (error) {
    steps.push({ step: 'delete_files', status: 'failed', message: (error as Error).message });
  }
  try {
    const helper = join(skillsRoot, 'taiwei-编程部署', 'scripts', 'nginx_deploy.py');
    const { stdout, stderr } = await executableResult('python3', [helper, record.ownerHash, record.name, '--remove']);
    steps.push({ step: 'remove_nginx', status: 'ok', message: (stdout || stderr || `Removed nginx proxy for ${record.path}`).trim() });
  } catch (error) {
    const detail = error as Error & { stderr?: string };
    steps.push({ step: 'remove_nginx', status: 'failed', message: (detail.stderr || detail.message).trim() });
  }
  return steps;
}
