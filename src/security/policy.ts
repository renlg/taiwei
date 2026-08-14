import { resolve } from 'node:path';
import { detectDanger } from './commands.js';

export type PolicyEffect = 'allow' | 'ask' | 'deny';
export interface PolicyMatch { role?: 'admin' | 'guest'; agentMode?: 'plan' | 'build'; tool?: string; path?: string; }
export interface PolicyRule { match: PolicyMatch; effect: PolicyEffect; }
export interface PolicyConfig { rules: PolicyRule[]; }
export interface PolicyInput {
  role: 'admin' | 'guest'; agentMode: 'plan' | 'build'; sessionId: string;
  tool: string; args: Record<string, unknown>; cwd: string; workspaceRoot: string; identity: string;
}
export interface PolicyDecision { effect: PolicyEffect; rule: string; explicit: boolean; allowExternalPath?: boolean; }

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);
const READ_TOOLS = new Set(['read_file', 'search_files', 'rag_search', 'session_search', 'session_list', 'session_get']);

function matchesPattern(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`).test(value);
}

export function toolPath(args: Record<string, unknown>, cwd: string): string | undefined {
  const value = args.path ?? args.file ?? args.filename;
  return typeof value === 'string' ? resolve(cwd, value) : undefined;
}

function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  const match = rule.match;
  if (match.role && match.role !== input.role) return false;
  if (match.agentMode && match.agentMode !== input.agentMode) return false;
  if (match.tool && !matchesPattern(input.tool, match.tool)) return false;
  if (match.path) {
    const path = toolPath(input.args, input.cwd);
    if (!path) return false;
    const absolutePattern = resolve(input.workspaceRoot, match.path);
    if (!matchesPattern(path, absolutePattern)) return false;
  }
  return true;
}

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig = { rules: [] }) {}

  decide(input: PolicyInput): PolicyDecision {
    for (let index = 0; index < this.config.rules.length; index += 1) {
      const rule = this.config.rules[index]!;
      if (ruleMatches(rule, input)) {
        return { effect: rule.effect, rule: `config.rules[${index}]`, explicit: true, allowExternalPath: rule.effect === 'allow' && Boolean(rule.match.path) };
      }
    }
    if (input.role === 'guest') {
      if (input.tool === 'bash') return { effect: 'deny', rule: 'builtin.guest.no-bash', explicit: false };
      if (WRITE_TOOLS.has(input.tool)) return { effect: 'deny', rule: 'builtin.guest.no-write', explicit: false };
      if (input.tool.startsWith('memory_')) return { effect: 'deny', rule: 'builtin.guest.no-memory-management', explicit: false };
      if (input.tool.startsWith('mcp_') || input.tool.startsWith('plugin_')) return { effect: 'deny', rule: 'builtin.guest.no-extensions', explicit: false };
      if (READ_TOOLS.has(input.tool) || input.tool.startsWith('read_') || input.tool.startsWith('search_')) return { effect: 'allow', rule: 'builtin.guest.workspace-read', explicit: false };
    }
    if (input.agentMode === 'plan') {
      if (input.tool === 'bash' || WRITE_TOOLS.has(input.tool) || input.tool === 'delegate_task' || input.tool.startsWith('memory_')) {
        return { effect: 'deny', rule: 'builtin.plan.read-only', explicit: false };
      }
      return { effect: 'allow', rule: 'builtin.plan.read', explicit: false };
    }
    if (input.tool === 'bash' && detectDanger(String(input.args.command ?? ''))) return { effect: 'ask', rule: 'builtin.admin.dangerous-command', explicit: false };
    return { effect: 'allow', rule: 'builtin.admin.build', explicit: false };
  }
}
