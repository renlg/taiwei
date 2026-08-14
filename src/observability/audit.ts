import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getPaths } from '../util/paths.js';
import type { ObservabilityEvent } from './events.js';

const SECRET_KEY = /key|token|secret|password|apiKey/i;

export function redactSecrets(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '***';
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSecrets(item, name)]));
  return value;
}

export async function appendAudit(entry: ObservabilityEvent): Promise<void> {
  const path = getPaths().audit;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(redactSecrets({ timestamp: new Date().toISOString(), ...entry }))}\n`, 'utf8');
}

export async function readAudit(limit = 100, offset = 0): Promise<unknown[]> {
  let content = '';
  try { content = await readFile(getPaths().audit, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const entries = content.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as unknown]; } catch { return []; } }).reverse();
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 100;
  return entries.slice(safeOffset, safeOffset + safeLimit);
}
