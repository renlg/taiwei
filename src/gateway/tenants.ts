import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hashPassword } from '../config/password.js';
import type { TaiweiConfig } from '../config/config.js';
import { getPaths } from '../util/paths.js';

type DatabaseSync = import('node:sqlite').DatabaseSync;

export type TenantStatus = 'active' | 'deleted';

export interface TenantAccount {
  id: number;
  username: string;
  tenantUid: number;
  accountName: string;
  osUsername: string;
  giteaUsername: string;
  giteaOrgName: string;
  osPasswordHash: string;
  giteaPasswordHash: string;
  giteaApiToken: string;
  status: TenantStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  osProvisioned: boolean;
  giteaUserProvisioned: boolean;
  giteaTokenProvisioned: boolean;
  giteaOrgProvisioned: boolean;
}

export type PublicTenantAccount = Omit<TenantAccount,
  'osPasswordHash' | 'giteaPasswordHash' | 'giteaApiToken' |
  'osProvisioned' | 'giteaUserProvisioned' | 'giteaTokenProvisioned' | 'giteaOrgProvisioned'> & {
    hasGiteaToken: boolean;
  };

interface TenantRow {
  id: number;
  username: string;
  tenant_uid: number;
  account_name: string;
  os_username: string;
  gitea_username: string;
  gitea_org_name: string;
  os_password_hash: string;
  gitea_password_hash: string;
  gitea_api_token: string;
  status: TenantStatus;
  error: string | null;
  created_at: number;
  updated_at: number;
  os_provisioned: number;
  gitea_user_provisioned: number;
  gitea_token_provisioned: number;
  gitea_org_provisioned: number;
}

function mapRow(row: TenantRow): TenantAccount {
  return {
    id: row.id, username: row.username, tenantUid: row.tenant_uid, accountName: row.account_name,
    osUsername: row.os_username, giteaUsername: row.gitea_username, giteaOrgName: row.gitea_org_name,
    osPasswordHash: row.os_password_hash, giteaPasswordHash: row.gitea_password_hash,
    giteaApiToken: row.gitea_api_token, status: row.status, error: row.error ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at, osProvisioned: Boolean(row.os_provisioned),
    giteaUserProvisioned: Boolean(row.gitea_user_provisioned), giteaTokenProvisioned: Boolean(row.gitea_token_provisioned),
    giteaOrgProvisioned: Boolean(row.gitea_org_provisioned),
  };
}

function publicAccount(account: TenantAccount): PublicTenantAccount {
  const { osPasswordHash: _os, giteaPasswordHash: _gitea, giteaApiToken, osProvisioned: _op,
    giteaUserProvisioned: _gu, giteaTokenProvisioned: _gt, giteaOrgProvisioned: _go, ...safe } = account;
  return { ...safe, hasGiteaToken: Boolean(giteaApiToken) };
}

export interface TenantAccountRepository {
  initialize(): Promise<void>;
  getByUsername(username: string): Promise<TenantAccount | undefined>;
  allocate(username: string, osPasswordHash: string, giteaPasswordHash: string): Promise<TenantAccount>;
  upsertAccount(account: Omit<TenantAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<TenantAccount>;
  listAccounts(): Promise<PublicTenantAccount[]>;
  updateProvisioning(id: number, values: Partial<Pick<TenantAccount,
    'osPasswordHash' | 'giteaPasswordHash' | 'giteaApiToken' | 'error' | 'osProvisioned' |
    'giteaUserProvisioned' | 'giteaTokenProvisioned' | 'giteaOrgProvisioned'>>): Promise<TenantAccount>;
  markDeleted(id: number, error?: string | null): Promise<void>;
  close?(): void;
}

export class TenantAccountStore implements TenantAccountRepository {
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
          CREATE TABLE IF NOT EXISTS tenant_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            tenant_uid INTEGER NOT NULL UNIQUE,
            account_name TEXT NOT NULL UNIQUE,
            os_username TEXT NOT NULL,
            gitea_username TEXT NOT NULL,
            gitea_org_name TEXT NOT NULL,
            os_password_hash TEXT NOT NULL,
            gitea_password_hash TEXT NOT NULL,
            gitea_api_token TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            error TEXT DEFAULT NULL,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            os_provisioned INTEGER NOT NULL DEFAULT 0,
            gitea_user_provisioned INTEGER NOT NULL DEFAULT 0,
            gitea_token_provisioned INTEGER NOT NULL DEFAULT 0,
            gitea_org_provisioned INTEGER NOT NULL DEFAULT 0
          );
        `);
        const columns = new Set((db.prepare('PRAGMA table_info(tenant_accounts)').all() as Array<{ name: string }>).map((column) => column.name));
        const migrations: Array<[string, string]> = [
          ['tenant_uid', 'INTEGER NOT NULL DEFAULT 0'], ['account_name', "TEXT NOT NULL DEFAULT ''"],
          ['os_username', "TEXT NOT NULL DEFAULT ''"], ['gitea_username', "TEXT NOT NULL DEFAULT ''"],
          ['gitea_org_name', "TEXT NOT NULL DEFAULT ''"], ['os_password_hash', "TEXT NOT NULL DEFAULT ''"],
          ['gitea_password_hash', "TEXT NOT NULL DEFAULT ''"], ['gitea_api_token', "TEXT NOT NULL DEFAULT ''"],
          ['status', "TEXT NOT NULL DEFAULT 'active'"], ['error', 'TEXT DEFAULT NULL'],
          ['created_at', 'REAL NOT NULL DEFAULT 0'], ['updated_at', 'REAL NOT NULL DEFAULT 0'],
          ['os_provisioned', 'INTEGER NOT NULL DEFAULT 0'], ['gitea_user_provisioned', 'INTEGER NOT NULL DEFAULT 0'],
          ['gitea_token_provisioned', 'INTEGER NOT NULL DEFAULT 0'], ['gitea_org_provisioned', 'INTEGER NOT NULL DEFAULT 0'],
        ];
        for (const [name, definition] of migrations) if (!columns.has(name)) db.exec(`ALTER TABLE tenant_accounts ADD COLUMN ${name} ${definition}`);
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_tenant_uid ON tenant_accounts(tenant_uid);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_accounts_account_name ON tenant_accounts(account_name);
          CREATE INDEX IF NOT EXISTS idx_tenant_accounts_updated_at ON tenant_accounts(updated_at DESC);
        `);
        this.opened = db;
        return db;
      })().catch((error) => { this.database = undefined; throw error; });
    }
    return this.database;
  }

  async getByUsername(username: string): Promise<TenantAccount | undefined> {
    const row = (await this.open()).prepare('SELECT * FROM tenant_accounts WHERE username = ?').get(username) as TenantRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  async allocate(username: string, osPasswordHash: string, giteaPasswordHash: string): Promise<TenantAccount> {
    const db = await this.open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = db.prepare('SELECT * FROM tenant_accounts WHERE username = ?').get(username) as TenantRow | undefined;
      if (!existing) {
        const next = db.prepare('SELECT COALESCE(MAX(tenant_uid), 0) + 1 AS uid FROM tenant_accounts').get() as { uid: number };
        const accountName = `guest${next.uid}`;
        const now = Date.now();
        db.prepare(`INSERT INTO tenant_accounts(
          username, tenant_uid, account_name, os_username, gitea_username, gitea_org_name,
          os_password_hash, gitea_password_hash, gitea_api_token, status, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'active', NULL, ?, ?)`)
          .run(username, next.uid, accountName, accountName, accountName, accountName, osPasswordHash, giteaPasswordHash, now, now);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return (await this.getByUsername(username))!;
  }

  async listAccounts(): Promise<PublicTenantAccount[]> {
    const rows = (await this.open()).prepare('SELECT * FROM tenant_accounts ORDER BY tenant_uid ASC').all() as unknown as TenantRow[];
    return rows.map(mapRow).map(publicAccount);
  }

  async upsertAccount(account: Omit<TenantAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<TenantAccount> {
    const db = await this.open();
    const now = Date.now();
    db.prepare(`INSERT INTO tenant_accounts(
      username, tenant_uid, account_name, os_username, gitea_username, gitea_org_name,
      os_password_hash, gitea_password_hash, gitea_api_token, status, error, created_at, updated_at,
      os_provisioned, gitea_user_provisioned, gitea_token_provisioned, gitea_org_provisioned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      tenant_uid = excluded.tenant_uid, account_name = excluded.account_name, os_username = excluded.os_username,
      gitea_username = excluded.gitea_username, gitea_org_name = excluded.gitea_org_name,
      os_password_hash = excluded.os_password_hash, gitea_password_hash = excluded.gitea_password_hash,
      gitea_api_token = excluded.gitea_api_token, status = excluded.status, error = excluded.error,
      updated_at = excluded.updated_at, os_provisioned = excluded.os_provisioned,
      gitea_user_provisioned = excluded.gitea_user_provisioned, gitea_token_provisioned = excluded.gitea_token_provisioned,
      gitea_org_provisioned = excluded.gitea_org_provisioned`)
      .run(account.username, account.tenantUid, account.accountName, account.osUsername, account.giteaUsername,
        account.giteaOrgName, account.osPasswordHash, account.giteaPasswordHash, account.giteaApiToken,
        account.status, account.error, now, now, Number(account.osProvisioned), Number(account.giteaUserProvisioned),
        Number(account.giteaTokenProvisioned), Number(account.giteaOrgProvisioned));
    return (await this.getByUsername(account.username))!;
  }

  async updateProvisioning(id: number, values: Partial<Pick<TenantAccount,
    'osPasswordHash' | 'giteaPasswordHash' | 'giteaApiToken' | 'error' | 'osProvisioned' |
    'giteaUserProvisioned' | 'giteaTokenProvisioned' | 'giteaOrgProvisioned'>>): Promise<TenantAccount> {
    const names: Record<string, string> = {
      osPasswordHash: 'os_password_hash', giteaPasswordHash: 'gitea_password_hash', giteaApiToken: 'gitea_api_token',
      error: 'error', osProvisioned: 'os_provisioned', giteaUserProvisioned: 'gitea_user_provisioned',
      giteaTokenProvisioned: 'gitea_token_provisioned', giteaOrgProvisioned: 'gitea_org_provisioned',
    };
    const entries = Object.entries(values).filter(([key]) => key in names);
    if (!entries.length) {
      const row = (await this.open()).prepare('SELECT * FROM tenant_accounts WHERE id = ?').get(id) as unknown as TenantRow;
      return mapRow(row);
    }
    const sets = entries.map(([key]) => `${names[key]} = ?`);
    const params = entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value);
    (await this.open()).prepare(`UPDATE tenant_accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...params, Date.now(), id);
    const row = (await this.open()).prepare('SELECT * FROM tenant_accounts WHERE id = ?').get(id) as unknown as TenantRow;
    return mapRow(row);
  }

  async markDeleted(id: number, error: string | null = null): Promise<void> {
    (await this.open()).prepare("UPDATE tenant_accounts SET status = 'deleted', error = ?, updated_at = ? WHERE id = ?").run(error, Date.now(), id);
  }

  close(): void { const db = this.opened; this.opened = undefined; this.database = undefined; db?.close(); }
}

export interface GiteaClient {
  createUser(accountName: string, password: string): Promise<void>;
  createToken(accountName: string): Promise<string>;
  createOrganization(accountName: string): Promise<void>;
  deleteOrDisableUser(accountName: string): Promise<void>;
  deleteOrganizationIfEmpty(orgName: string): Promise<'deleted' | 'retained'>;
}

export class RestGiteaClient implements GiteaClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;

  constructor(config: Pick<TaiweiConfig, 'gitea'>) {
    this.baseUrl = config.gitea.baseUrl.trim().replace(/\/$/, '');
    this.adminToken = config.gitea.adminToken.trim();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.baseUrl || !this.adminToken) throw new Error('Gitea is not configured (set gitea.baseUrl and gitea.adminToken)');
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `token ${this.adminToken}`, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Gitea ${init.method ?? 'GET'} ${path} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    return response;
  }

  async createUser(accountName: string, password: string): Promise<void> {
    try { await this.request('/admin/users', { method: 'POST', body: JSON.stringify({ login: accountName, email: `${accountName}@localhost`, password, must_change_password: false }) }); }
    catch (error) {
      if (!/\((?:409|422)\)/.test((error as Error).message)) throw error;
      await this.request(`/admin/users/${encodeURIComponent(accountName)}`);
    }
  }
  async createToken(accountName: string): Promise<string> {
    const response = await this.request(`/users/${encodeURIComponent(accountName)}/tokens`, { method: 'POST', body: JSON.stringify({ name: 'taiwei', scopes: ['all'] }) });
    const body = await response.json() as { sha1?: unknown };
    if (typeof body.sha1 !== 'string' || !body.sha1) throw new Error('Gitea token response did not include sha1');
    return body.sha1;
  }
  async createOrganization(accountName: string): Promise<void> {
    try { await this.request('/orgs', { method: 'POST', body: JSON.stringify({ username: accountName, org_name: accountName, description: `taiwei tenant ${accountName}` }) }); }
    catch (error) {
      if (!/\((?:409|422)\)/.test((error as Error).message)) throw error;
      await this.request(`/orgs/${encodeURIComponent(accountName)}`);
    }
  }
  async deleteOrDisableUser(accountName: string): Promise<void> {
    try { await this.request(`/admin/users/${encodeURIComponent(accountName)}`, { method: 'DELETE' }); }
    catch { await this.request(`/admin/users/${encodeURIComponent(accountName)}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }); }
  }
  async deleteOrganizationIfEmpty(orgName: string): Promise<'deleted' | 'retained'> {
    const repos = await (await this.request(`/orgs/${encodeURIComponent(orgName)}/repos`)).json() as unknown;
    if (Array.isArray(repos) && repos.length > 0) return 'retained';
    await this.request(`/orgs/${encodeURIComponent(orgName)}`, { method: 'DELETE' });
    return 'deleted';
  }
}

export interface TenantOsProvider {
  createAccount(accountName: string): Promise<void>;
  lockAccount(accountName: string): Promise<void>;
}

function runOsCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`);
}

export class SystemTenantOsProvider implements TenantOsProvider {
  async createAccount(accountName: string): Promise<void> {
    try { runOsCommand('useradd', ['-m', '--shell', '/bin/bash', '--gecos', `taiwei tenant ${accountName}`, accountName]); }
    catch (error) {
      try { runOsCommand('id', ['-u', accountName]); return; }
      catch { throw error; }
    }
  }
  async lockAccount(accountName: string): Promise<void> {
    runOsCommand('usermod', ['-L', accountName]);
    runOsCommand('usermod', ['-s', '/usr/sbin/nologin', accountName]);
  }
}

function strongPassword(): string { return randomBytes(18).toString('base64url'); }
function errorText(step: string, error: unknown): string { return `${step}: ${error instanceof Error ? error.message : String(error)}`; }

export class TenantAccountService {
  private readonly pending = new Map<string, Promise<TenantAccount>>();

  constructor(
    private readonly config: () => Promise<TaiweiConfig>,
    readonly store: TenantAccountRepository = new TenantAccountStore(),
    private readonly os: TenantOsProvider = new SystemTenantOsProvider(),
    private readonly giteaFactory: (config: TaiweiConfig) => GiteaClient = (value) => new RestGiteaClient(value),
  ) {}

  async ensureTenantAccount(username: string): Promise<TenantAccount> {
    const normalized = username.trim();
    if (!normalized) throw new Error('Tenant username is required');
    const active = this.pending.get(normalized);
    if (active) return active;
    const work = this.provision(normalized).finally(() => this.pending.delete(normalized));
    this.pending.set(normalized, work);
    return work;
  }

  private async provision(normalized: string): Promise<TenantAccount> {
    let account = await this.store.getByUsername(normalized);
    if (account && !account.error) return account;
    if (!account) {
      account = await this.store.allocate(normalized, hashPassword(strongPassword()), hashPassword(strongPassword()));
    }
    if (account.status === 'deleted') return account;
    const failures: string[] = [];
    if (!account.osProvisioned) {
      try { await this.os.createAccount(account.accountName); account = await this.store.updateProvisioning(account.id, { osProvisioned: true }); }
      catch (error) { failures.push(errorText('OS account creation failed', error)); }
    }
    let config: TaiweiConfig;
    try { config = await this.config(); }
    catch (error) { failures.push(errorText('Configuration load failed', error)); return this.store.updateProvisioning(account.id, { error: failures.join('; ') }); }
    if (!config.gitea.baseUrl.trim() || !config.gitea.adminToken.trim()) {
      failures.push('Gitea provisioning skipped: set gitea.baseUrl and gitea.adminToken');
    } else {
      const gitea = this.giteaFactory(config);
      if (!account.giteaUserProvisioned) {
        const password = strongPassword();
        try {
          await gitea.createUser(account.accountName, password);
          account = await this.store.updateProvisioning(account.id, { giteaUserProvisioned: true, giteaPasswordHash: hashPassword(password) });
        } catch (error) { failures.push(errorText('Gitea account creation failed', error)); }
      }
      if (account.giteaUserProvisioned && !account.giteaTokenProvisioned) {
        try {
          const token = await gitea.createToken(account.accountName);
          account = await this.store.updateProvisioning(account.id, { giteaApiToken: token, giteaTokenProvisioned: true });
        } catch (error) { failures.push(errorText('Gitea token creation failed after account creation succeeded', error)); }
      }
      if (account.giteaUserProvisioned && !account.giteaOrgProvisioned) {
        try { await gitea.createOrganization(account.accountName); account = await this.store.updateProvisioning(account.id, { giteaOrgProvisioned: true }); }
        catch (error) { failures.push(errorText('Gitea organization creation failed after account creation succeeded', error)); }
      }
    }
    return this.store.updateProvisioning(account.id, { error: failures.length ? failures.join('; ') : null });
  }

  async deleteTenantAccount(username: string): Promise<void> {
    const account = await this.store.getByUsername(username);
    if (!account) throw new Error(`Tenant account not found: ${username}`);
    await this.store.markDeleted(account.id);
    const failures: string[] = [];
    let config: TaiweiConfig | undefined;
    try { config = await this.config(); } catch (error) { failures.push(errorText('Configuration load failed', error)); }
    if (config?.gitea.baseUrl.trim() && config.gitea.adminToken.trim()) {
      const gitea = this.giteaFactory(config);
      try { await gitea.deleteOrDisableUser(account.accountName); } catch (error) { failures.push(errorText('Gitea user cleanup failed', error)); }
      try { await gitea.deleteOrganizationIfEmpty(account.giteaOrgName); } catch (error) { failures.push(errorText('Gitea organization cleanup failed', error)); }
    } else failures.push('Gitea cleanup skipped: Gitea is not configured');
    try { await this.os.lockAccount(account.osUsername); } catch (error) { failures.push(errorText('OS account lock failed', error)); }
    await this.store.markDeleted(account.id, failures.length ? failures.join('; ') : null);
  }
}

export async function ensureTenantAccount(username: string, service: TenantAccountService): Promise<TenantAccount> {
  return service.ensureTenantAccount(username);
}
