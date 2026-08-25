import { AgentContext } from './agent/context.js';
import { InterruptManager, TurnQueue } from './agent/interrupt.js';
import { runAgentTurn, type AgentEvent } from './agent/loop.js';
import type { ContentBlock } from './llm/client.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, resolveToolSettings, resolveWorkspaceDir, type TaiweiConfig } from './config/config.js';
import { getCurrentModel } from './config/model.js';
import { CronJobStore, type CronJob } from './cron/jobs.js';
import { CronScheduler, type CronExecutionResult } from './cron/scheduler.js';
import { executeWatchdogScript } from './cron/script.js';
import type { CronRun } from './cron/runs.js';
import { McpBridge } from './mcp/bridge.js';
import { MemoryStore } from './memory/store.js';
import { PluginLoader } from './plugins/loader.js';
import { SkillLoader } from './skills/loader.js';
import { UserSkillStore } from './skills/user-store.js';
import { UserSkillStateStore } from './skills/user-state.js';
import { bashTool } from './tools/impl/bash.js';
import { createMemoryTools } from './tools/impl/memory.js';
import { imageGenTool, videoGenTool } from './tools/impl/media.js';
import { ragSearchTool } from './tools/impl/rag.js';
import { webSearchTool } from './tools/impl/websearch.js';
import { readTool } from './tools/impl/read.js';
import { searchTool } from './tools/impl/search.js';
import { createNginxAddProxyTool } from './tools/impl/nginx-add-proxy.js';
import { createWatchdogTools } from './tools/impl/watchdog.js';
import { createLoadSkillTool } from './tools/impl/skill.js';
import { createUserSkillTools } from './tools/impl/user-skill.js';
import { writeTool } from './tools/impl/write.js';
import { editTool } from './tools/impl/edit.js';
import { diagnosticsTool } from './tools/impl/diagnostics.js';
import { ToolRegistry, type TenantIdentity } from './tools/registry.js';
import { CommandSecurity, type ConfirmationHandler } from './security/commands.js';
import { HookRunner } from './hooks/runner.js';
import { historyTools } from './tools/impl/history.js';
import { importHistoryIfEmpty } from './history/db.js';
import { appendMessage, upsertSession } from './history/db.js';
import { getAgentProfile, getAgentProfiles, type AgentProfile } from './agents/profiles.js';
import { DelegationManager, type DelegateRequest } from './agent/delegation.js';
import { createDelegateTool } from './tools/impl/delegate.js';
import { taskTools } from './tools/impl/task.js';
import { BrowserToolRuntime } from './tools/impl/browser.js';
import { SessionRuntime } from './agent/runtime.js';
import { PolicyEngine } from './security/policy.js';
import { guestIdForUsername } from './util/paths.js';

export class TaiweiApp {
  config!: TaiweiConfig;
  readonly registry = new ToolRegistry();
  readonly memory = new MemoryStore();
  readonly skills = new SkillLoader();
  readonly userSkills = new UserSkillStore();
  readonly userSkillStates = new UserSkillStateStore();
  readonly context = new AgentContext(this.memory, this.skills);
  readonly interrupt = new InterruptManager();
  readonly turns = new TurnQueue();
  runtime!: SessionRuntime;
  readonly cronJobs = new CronJobStore();
  readonly mcp = new McpBridge(this.registry);
  readonly plugins = new PluginLoader(this.registry);
  readonly scheduler = new CronScheduler(this.cronJobs, (job, signal) => this.executeCron(job, signal), (job, run) => this.deliverCron(job, run));
  readonly security = new CommandSecurity();
  hooks!: HookRunner;
  delegation!: DelegationManager;
  activeAgentId = 'build';
  readonly browser = new BrowserToolRuntime();

  async initialize(options: { external?: boolean; scheduler?: boolean } = {}): Promise<void> {
    this.config = await loadConfig();
    getAgentProfiles(); // Load and validate ~/.taiwei/agents.json once at startup.
    this.runtime = new SessionRuntime(this.config.runtime.maxConcurrentTurns);
    this.skills.setDisabled(this.config.skillsDisabled);
    this.registry.configure(resolveToolSettings(this.config));
    const workspace = resolveWorkspaceDir(this.config);
    await mkdir(workspace, { recursive: true });
    this.hooks = new HookRunner(this.config.hooks, this.config.hookTimeoutSeconds, workspace);
    this.delegation = new DelegationManager((request) => this.runChild(request), this.config.delegation.maxConcurrent, this.config.delegation.maxDepth);
    const nginxAddProxyTool = createNginxAddProxyTool({ publicUrl: this.config.publicUrl });
    // User-skill management tools: create_skill, list_skills, delete_skill.
    for (const tool of [bashTool, readTool, writeTool, editTool, diagnosticsTool, searchTool, nginxAddProxyTool, ragSearchTool, webSearchTool, imageGenTool, videoGenTool, ...historyTools, createLoadSkillTool(this.skills, this.userSkills, this.userSkillStates), ...createUserSkillTools(this.userSkills, this.userSkillStates), ...createMemoryTools(this.memory), ...createWatchdogTools(this.cronJobs, this.scheduler), ...taskTools, ...this.browser.tools()]) this.registry.register(tool);
    this.registry.register(createDelegateTool(this.delegation));
    // history.db is a rebuildable index. A missing/unsupported SQLite runtime must never block chat startup.
    await importHistoryIfEmpty().catch(() => {});
    if (options.external !== false) {
      await this.plugins.reload();
      await this.mcp.reload();
    }
    if (options.scheduler !== false) { await this.scheduler.start(); console.log(`[taiwei] Scheduler started (${(await this.cronJobs.list()).filter((job) => job.enabled).length} enabled jobs)`); }
  }

  async run(prompt: string, options: { stream?: boolean; retainConversation?: boolean; enableDiagnostics?: boolean; onEvent?: (event: AgentEvent) => void; context?: AgentContext; confirmDanger?: ConfirmationHandler; sessionId?: string; runtimeSessionId?: string; skipBeforeMessageHook?: boolean; agentId?: string; delegationDepth?: number; role?: 'admin' | 'guest'; identity?: string; guestId?: string; tenantIdentity?: TenantIdentity; providerId?: string; model?: string; workspaceRoot?: string; userContent?: ContentBlock[] } = {}): Promise<string> {
    const runtimeSessionId = options.runtimeSessionId ?? options.sessionId ?? 'local';
    return this.runtime.run(runtimeSessionId, async (runtimeSignal) => {
      const localSignal = options.sessionId ? undefined : this.interrupt.beginTurn();
      const signal = localSignal ? AbortSignal.any([runtimeSignal, localSignal]) : runtimeSignal;
      try {
        this.config = await loadConfig();
        this.skills.setDisabled(this.config.skillsDisabled);
        const turnContext = options.context ?? this.context;
        await this.refreshContextSkills(turnContext, options.role === 'guest' ? options.guestId ?? 'guest' : 'admin');
        this.registry.configure(resolveToolSettings(this.config));
        const cwd = options.workspaceRoot ? resolve(options.workspaceRoot) : resolveWorkspaceDir(this.config);
        await mkdir(cwd, { recursive: true });
        this.hooks.configure(this.config.hooks, this.config.hookTimeoutSeconds, cwd);
        if (!options.skipBeforeMessageHook) {
          const gate = await this.hooks.run('beforeMessage', { sessionId: options.sessionId, message: prompt });
          if (gate.block) throw new Error(gate.reason ?? 'Message blocked by hook');
        }
        const profile = getAgentProfile(options.agentId ?? this.activeAgentId);
        return await runAgentTurn(prompt, turnContext, this.registry, { ...this.config, ...(profile.model ? { model: profile.model } : {}) }, {
          signal,
          enableDiagnostics: options.enableDiagnostics,
          cwd,
          retainConversation: options.retainConversation,
          onText: options.stream ? (text) => process.stdout.write(text) : undefined,
          onEvent: options.onEvent,
          getModel: options.model ? undefined : getCurrentModel,
          providerId: options.providerId, model: options.model,
          confirmDanger: options.confirmDanger,
          authorizeCommand: (command, workspace, handler, commandSignal) => this.security.authorize(
            options.identity ?? options.role ?? 'admin', command, workspace, this.config.security, handler, commandSignal,
            (options.role ?? 'admin') !== 'guest',
          ),
          hooks: this.hooks,
          sessionId: options.sessionId,
          agentProfile: profile,
          delegationDepth: options.delegationDepth,
          role: options.role ?? 'admin', identity: options.identity ?? options.role ?? 'admin', guestId: options.guestId, tenantIdentity: options.tenantIdentity,
          workspaceRoot: cwd, policy: new PolicyEngine(this.config.policy),
          userContent: options.userContent,
          userSkillStore: this.userSkills,
        });
      } finally { if (localSignal) this.interrupt.endTurn(); }
    });
  }

  stopSession(sessionId: string): boolean { return this.runtime.stop(sessionId); }

  async refreshContextSkills(context: AgentContext, owner = 'admin'): Promise<void> {
    if (this.config.autoLoadSkills === false) {
      context.setAvailableSkills([]);
      context.setUserSkills([]);
      return;
    }
    try { context.setAvailableSkills(await this.skills.list()); }
    catch { context.setAvailableSkills([]); }
    try { context.setUserSkills(await this.userSkills.loadEnabled(owner, await this.userSkillStates.disabled(owner))); }
    catch { context.setUserSkills([]); }
  }

  private async executeCron(job: CronJob, signal: AbortSignal): Promise<CronExecutionResult> {
    if (job.kind === 'script') {
      this.config = await loadConfig();
      const cwd = resolveWorkspaceDir(this.config);
      await mkdir(cwd, { recursive: true });
      return executeWatchdogScript(job.script!, cwd, signal);
    }
    if (job.kind === 'command') throw new Error('Cron command jobs are not supported; use kind "agent"');
    const result = await this.runtime.run(`cron:${job.id}`, async (runtimeSignal) => {
      const cronContext = new AgentContext(this.memory, this.skills);
      try {
        this.config = await loadConfig();
        this.skills.setDisabled(this.config.skillsDisabled);
        await this.refreshContextSkills(cronContext, 'admin');
        this.registry.configure(resolveToolSettings(this.config));
        const cwd = resolveWorkspaceDir(this.config);
        await mkdir(cwd, { recursive: true });
        this.hooks.configure(this.config.hooks, this.config.hookTimeoutSeconds, cwd);
        let tokens = 0;
        const output = await runAgentTurn(job.prompt!, cronContext, this.registry, this.config, {
          signal: AbortSignal.any([signal, runtimeSignal]), cwd, retainConversation: false, getModel: getCurrentModel,
          authorizeCommand: (command, workspace, handler, commandSignal) => this.security.authorize(
            'cron:' + job.id, command, workspace, this.config.security, handler, commandSignal, true,
          ),
          hooks: this.hooks,
          onEvent: (event) => { if (event.type === 'usage') tokens += event.usage.totalTokens; },
          role: 'admin', identity: `cron:${job.id}`, workspaceRoot: cwd, policy: new PolicyEngine(this.config.policy), sessionId: `cron:${job.id}`,
        });
        return { output, tokens };
      } catch (error) { throw error; }
    });
    return result;
  }

  private async runChild(request: DelegateRequest & { childSessionId: string; signal: AbortSignal }): Promise<string> {
    const context = new AgentContext(request.memory, this.skills, request.extendedMemory, request.profile);
    await this.refreshContextSkills(context, request.role === 'guest' ? guestIdForUsername(request.identity) : 'admin');
    const config = { ...this.config, ...(request.profile.model ? { model: request.profile.model } : {}) };
    const output = await runAgentTurn(request.task, context, this.registry, config, {
      signal: request.signal, cwd: request.workspaceRoot, retainConversation: false,
      agentProfile: request.profile, delegationDepth: request.depth + 1, sessionId: request.childSessionId,
      authorizeCommand: (command, workspace, handler, commandSignal) => this.security.authorize(
        request.identity, command, workspace, config.security, handler, commandSignal,
        (request.role ?? 'admin') !== 'guest',
      ),
      hooks: this.hooks,
      role: request.role, identity: request.identity, workspaceRoot: request.workspaceRoot, policy: new PolicyEngine(config.policy),
    });
    try {
      const now = Date.now();
      await upsertSession({ id: request.childSessionId, title: request.task.slice(0, 80), source: 'delegate', model: request.profile.model ?? config.model, createdAt: now, updatedAt: now, parentSessionId: request.parentSessionId, agentId: request.profile.id, ownerIdentity: request.identity });
      await appendMessage({ sessionId: request.childSessionId, role: 'user', content: request.task, timestamp: now });
      await appendMessage({ sessionId: request.childSessionId, role: 'assistant', content: output, timestamp: now + 0.001 });
    } catch { /* History is optional. */ }
    return output;
  }

  private async deliverCron(job: CronJob, run: CronRun): Promise<void> {
    if (job.delivery.type === 'none') return;
    const summary = (run.output || run.error || '(no text response)').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (job.delivery.type === 'webhook') {
      const response = await fetch(job.delivery.url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job, run }), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Cron webhook returned HTTP ${response.status}`);
      return;
    }
    console.log(`[taiwei] cron ${job.name}: ${run.status} — ${summary}`);
    this.interrupt.notify({ title: `cron job "${job.name}" ${run.status}`, message: summary });
  }

  async close(): Promise<void> { this.scheduler.stop(); await this.browser.close(); await this.plugins.close(); await this.mcp.close(); }
}
