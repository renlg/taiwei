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

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch', 'create_skill', 'delete_skill']);
const READ_ONLY_LSP_TOOLS = new Set(['document_symbols', 'go_to_definition', 'find_references']);
const GUEST_READ_TOOLS = new Set(['read_file', 'search_files', 'rag_search', 'web_search', 'generate_image', 'generate_video', 'session_search', 'session_list', 'session_get', 'load_skill', 'list_skills']);

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
      if (input.tool.startsWith('watchdog_')) return { effect: 'deny', rule: 'builtin.guest.no-watchdog-management', explicit: false };
      if (input.tool.startsWith('task_')) return { effect: 'deny', rule: 'builtin.guest.no-task-management', explicit: false };
      if (input.tool === 'delegate_task') return { effect: 'deny', rule: 'builtin.guest.no-delegation', explicit: false };
      // guest bash 放行：bash 工具会从 ToolContext 解析租户身份、切换 OS 用户，并检查内联及脚本内的文件/Git/Gitea 操作；映射或降权失败时拒绝执行。
      if (input.tool === 'bash') return { effect: 'allow', rule: 'builtin.guest.jailed-bash', explicit: false };
      // path 是 nginx URL 而不是文件路径；该专用工具自行严格校验并直接执行固定脚本。
      if (input.tool === 'nginx_add_proxy') return { effect: 'allow', rule: 'builtin.guest.nginx-add-proxy', explicit: false, allowExternalPath: true };
      // 计划清单是会话级规划元数据，不触碰文件系统，guest 可用以呈现进度分解。
      if (input.tool === 'todo_write' || input.tool === 'todo_read') return { effect: 'allow', rule: 'builtin.guest.todo', explicit: false };
      if (input.tool.startsWith('memory_')) return { effect: 'deny', rule: 'builtin.guest.no-memory-management', explicit: false };
      if (input.tool.startsWith('mcp_') || input.tool.startsWith('plugin_')) return { effect: 'deny', rule: 'builtin.guest.no-extensions', explicit: false };
      if (WRITE_TOOLS.has(input.tool)) return { effect: 'allow', rule: 'builtin.guest.workspace-write', explicit: false };
      if (GUEST_READ_TOOLS.has(input.tool)) return { effect: 'allow', rule: 'builtin.guest.workspace-read', explicit: false };
      return { effect: 'deny', rule: 'builtin.guest.default-deny', explicit: false };
    }
    if (input.agentMode === 'plan') {
      if (input.tool === 'bash' || WRITE_TOOLS.has(input.tool) || input.tool === 'delegate_task' || input.tool.startsWith('memory_') || input.tool === 'task_start' || input.tool === 'task_kill' || input.tool.startsWith('browser_') || input.tool.startsWith('mcp_')) {
        return { effect: 'deny', rule: 'builtin.plan.read-only', explicit: false };
      }
      if (READ_ONLY_LSP_TOOLS.has(input.tool)) return { effect: 'allow', rule: 'builtin.plan.lsp-navigation', explicit: false };
      if (input.tool.startsWith('lsp_')) return { effect: 'deny', rule: 'builtin.plan.no-lsp-mutation', explicit: false };
      return { effect: 'allow', rule: 'builtin.plan.read', explicit: false };
    }
    if (input.tool === 'bash' && detectDanger(String(input.args.command ?? ''))) return { effect: 'ask', rule: 'builtin.admin.dangerous-command', explicit: false };
    return { effect: 'allow', rule: 'builtin.admin.build', explicit: false };
  }
}
