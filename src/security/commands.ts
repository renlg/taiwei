import { randomUUID } from 'node:crypto';
import type { SecurityRememberMode, TaiweiConfig } from '../config/config.js';
import { loadConfig, saveConfig } from '../config/config.js';

export interface DangerPattern {
  pattern: string;
  reason: string;
  level: 'danger' | 'warn';
}

export interface DangerMatch extends DangerPattern {
  source: 'default' | 'custom';
}

export interface ConfirmationRequest {
  id: string;
  command: string;
  reason: string;
  pattern: string;
  level: 'danger' | 'warn';
  workspace: string;
  timeoutSeconds: number;
}

export interface ConfirmationDecision {
  approve: boolean;
  remember?: SecurityRememberMode;
}

export type ConfirmationHandler = (request: ConfirmationRequest) => Promise<ConfirmationDecision>;

export const DEFAULT_DANGER_PATTERNS: readonly DangerPattern[] = [
  { pattern: String.raw`\.taiwei[\\/](?:(?:config|gateway-sessions|login-locks)\.json|state\.db)\b`, reason: 'access to taiwei sensitive config (auth credentials / session tokens)', level: 'danger' },
  { pattern: String.raw`\bsudo\s+rm\b`, reason: 'sudo rm can remove protected system data', level: 'danger' },
  { pattern: String.raw`\brm[ \t]+(?:(?:-[A-Za-z]+|--[A-Za-z][A-Za-z-]*)[ \t]+)*(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?=[ \t]|$)`, reason: 'recursive delete is destructive and unrecoverable', level: 'danger' },
  { pattern: String.raw`\brm\s+(?:-[A-Za-z]*r[A-Za-z]*f|-[A-Za-z]*f[A-Za-z]*r)\s+(?:--\s+)?(?:/(?:\*|\s|$)|~(?:/|\s|$)|/Users(?:/|\s|$)|/System(?:/|\s|$)|/Library(?:/|\s|$)|/etc(?:/|\s|$)|/usr(?:/|\s|$)|/var(?:/|\s|$))`, reason: 'recursive forced removal targets a root, home, or system path', level: 'danger' },
  { pattern: String.raw`\bmkfs(?:\.[A-Za-z0-9]+)?\b`, reason: 'mkfs destroys filesystem contents', level: 'danger' },
  { pattern: String.raw`\bdd\b[^\n]*\bif=[^\s]+[^\n]*\bof=/dev/`, reason: 'dd writes directly to a device', level: 'danger' },
  { pattern: String.raw`\b(?:fdisk|format)\b`, reason: 'disk formatting or partitioning command', level: 'danger' },
  { pattern: String.raw`\b(?:shutdown|reboot|halt|poweroff)\b`, reason: 'system power command', level: 'danger' },
  { pattern: String.raw`\bchmod\s+-R\s+777\s+/`, reason: 'recursive world-writable permissions on an absolute path', level: 'danger' },
  { pattern: String.raw`\bchown\s+-R\b`, reason: 'recursive ownership change', level: 'danger' },
  { pattern: String.raw`:\s*\(\s*\)\s*\{`, reason: 'shell fork bomb signature', level: 'danger' },
  { pattern: String.raw`\bfork\s+bomb\b`, reason: 'fork bomb command', level: 'danger' },
  { pattern: String.raw`\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)(?:\s|$)`, reason: 'forced git history rewrite', level: 'warn' },
  { pattern: String.raw`\bcurl\b[^\n|]*\|\s*(?:ba|z)?sh\b`, reason: 'remote curl response piped into a shell', level: 'danger' },
  { pattern: String.raw`\bwget\b[^\n|]*\|\s*(?:ba|z)?sh\b`, reason: 'remote wget response piped into a shell', level: 'danger' },
];

export function detectDanger(command: string, customPatterns: readonly string[] = []): DangerMatch | undefined {
  const candidates: DangerMatch[] = [
    ...DEFAULT_DANGER_PATTERNS.map((item) => ({ ...item, source: 'default' as const })),
    ...customPatterns.map((pattern) => ({ pattern, reason: `custom dangerous-command pattern matched: ${pattern}`, level: 'danger' as const, source: 'custom' as const })),
  ];
  for (const candidate of candidates) {
    try { if (new RegExp(candidate.pattern, 'i').test(command)) return candidate; }
    catch { /* Invalid custom patterns are rejected by settings and ignored defensively here. */ }
  }
  return undefined;
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal?.aborted) reject(new DOMException('Turn cancelled', 'AbortError'));
    else signal?.addEventListener('abort', () => reject(new DOMException('Turn cancelled', 'AbortError')), { once: true });
  });
}

export class CommandSecurity {
  /** 按用户隔离的「本次会话记住」集合 */
  private readonly sessionApprovals = new Map<string, Set<string>>();

  async authorize(userId: string, command: string, workspace: string, security: TaiweiConfig['security'], handler?: ConfirmationHandler, signal?: AbortSignal, canWritePermanent = true): Promise<boolean> {
    if (!security.enabled) return true;
    const match = detectDanger(command, security.patterns);
    if (!match) return true;
    const userKey = userId || 'default';
    if (this.sessionApprovals.get(userKey)?.has(match.pattern) || security.approvedPatterns.includes(match.pattern)) return true;
    if (!handler) {
      console.error(`[taiwei] Dangerous command rejected because confirmation is unavailable: ${match.reason}`);
      return false;
    }
    const timeoutSeconds = Math.max(1, Math.min(3600, Math.floor(security.timeoutSeconds || 60)));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ConfirmationDecision>((resolve) => {
      timer = setTimeout(() => resolve({ approve: false }), timeoutSeconds * 1_000);
    });
    try {
      const decision = await Promise.race([
        handler({ id: randomUUID(), command, workspace, reason: match.reason, pattern: match.pattern, level: match.level, timeoutSeconds }),
        timeout,
        abortPromise(signal),
      ]);
      if (!decision.approve) return false;
      const remember = decision.remember ?? 'off';
      // 「本次会话记住」按用户隔离
      if (remember === 'session' || (remember === 'permanent' && !canWritePermanent)) {
        let set = this.sessionApprovals.get(userKey);
        if (!set) { set = new Set(); this.sessionApprovals.set(userKey, set); }
        set.add(match.pattern);
      } else if (remember === 'permanent') {
        // 仅可写永久的调用方(admin/CLI)落全局白名单;guest 的「永久」已在上分支降级为「本次会话」
        let set = this.sessionApprovals.get(userKey);
        if (!set) { set = new Set(); this.sessionApprovals.set(userKey, set); }
        set.add(match.pattern);
        const latest = await loadConfig();
        if (!latest.security.approvedPatterns.includes(match.pattern)) {
          latest.security.approvedPatterns.push(match.pattern);
          await saveConfig(latest);
        }
      }
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  clearSessionApprovals(): void { this.sessionApprovals.clear(); }
}
