import { basename, dirname, normalize, sep } from 'node:path';

const SENSITIVE_BASENAMES = new Set([
  '.env.gitea',
  'config.json',
  'gateway-sessions.json',
  'login-locks.json',
  'mcp.json',
  'tenant-accounts.db',
  'tenants.db',
]);

const SECRET_TEXT = [
  /(authorization\s*[:=]\s*(?:bearer|token)\s+)()[^\s"']+/gi,
  /((?:api[_-]?key|token|access[_-]?token|client[_-]?secret|password|gitea[_-]?(?:api[_-]?)?token)["']?\s*[=:]\s*["']?)()[^\s,;"']+/gi,
  /(https?:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi,
] as const;

/** Files containing gateway, MCP, session, or administrator credentials are never guest-readable. */
export function isSensitiveGuestPath(path: string): boolean {
  const normalized = normalize(path);
  const name = basename(normalized).toLowerCase();
  if (SENSITIVE_BASENAMES.has(name)) return true;
  const segments = normalized.toLowerCase().split(sep);
  if (/^\.env(?:\..*)?$/.test(name) && segments.some((part) => part.includes('gitea-mcp'))) return true;
  if (name === 'config.json' && basename(dirname(normalized)).toLowerCase().includes('gitea-mcp')) return true;
  return false;
}

export function assertGuestPathNotSensitive(path: string): void {
  if (isSensitiveGuestPath(path)) throw new Error('guest 无权读取包含管理员凭据的敏感文件');
}

export function containsSensitivePathReference(value: string): boolean {
  return /(?:^|[\s'"=:(])(?:~?\/)?[^\s'";&|()<>]*(?:\.taiwei\/(?:config|gateway-sessions|login-locks)\.json|(?:^|\/)mcp\.json|\.env\.gitea|gitea-mcp\/[^\s'";&|()<>]*\.env(?:\.[^\s'";&|()<>]*)?)/i.test(value);
}

/** Defense in depth for subprocess/file-search output; path checks remain the primary boundary. */
export function redactCredentialText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_TEXT) redacted = redacted.replace(pattern, '$1***$2');
  return redacted;
}
