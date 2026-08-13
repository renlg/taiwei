import { AgentContext } from './agent/context.js';
import { InterruptManager, TurnQueue } from './agent/interrupt.js';
import { runAgentTurn, type AgentEvent } from './agent/loop.js';
import { mkdir } from 'node:fs/promises';
import { loadConfig, resolveWorkspaceDir, type TaiweiConfig } from './config/config.js';
import { getCurrentModel } from './config/model.js';
import { CronJobStore, type CronJob } from './cron/jobs.js';
import { CronScheduler } from './cron/scheduler.js';
import { McpBridge } from './mcp/bridge.js';
import { MemoryStore } from './memory/store.js';
import { PluginLoader } from './plugins/loader.js';
import { SkillLoader } from './skills/loader.js';
import { bashTool } from './tools/impl/bash.js';
import { createMemoryTools } from './tools/impl/memory.js';
import { ragSearchTool } from './tools/impl/rag.js';
import { readTool } from './tools/impl/read.js';
import { searchTool } from './tools/impl/search.js';
import { writeTool } from './tools/impl/write.js';
import { ToolRegistry } from './tools/registry.js';
import { CommandSecurity, type ConfirmationHandler } from './security/commands.js';
import { HookRunner } from './hooks/runner.js';

export class TaiweiApp {
  config!: TaiweiConfig;
  readonly registry = new ToolRegistry();
  readonly memory = new MemoryStore();
  readonly skills = new SkillLoader();
  readonly context = new AgentContext(this.memory, this.skills);
  readonly interrupt = new InterruptManager();
  readonly turns = new TurnQueue();
  readonly cronJobs = new CronJobStore();
  readonly mcp = new McpBridge(this.registry);
  readonly plugins = new PluginLoader(this.registry);
  readonly scheduler = new CronScheduler(this.cronJobs, (job) => this.executeCron(job));
  readonly security = new CommandSecurity();
  hooks!: HookRunner;

  async initialize(options: { external?: boolean; scheduler?: boolean } = {}): Promise<void> {
    this.config = await loadConfig();
    const workspace = resolveWorkspaceDir(this.config);
    await mkdir(workspace, { recursive: true });
    this.hooks = new HookRunner(this.config.hooks, this.config.hookTimeoutSeconds, workspace);
    for (const tool of [bashTool, readTool, writeTool, searchTool, ragSearchTool, ...createMemoryTools(this.memory)]) this.registry.register(tool);
    if (options.external !== false) {
      await this.plugins.reload();
      await this.mcp.reload();
    }
    if (options.scheduler !== false) await this.scheduler.start();
  }

  async run(prompt: string, options: { stream?: boolean; retainConversation?: boolean; onEvent?: (event: AgentEvent) => void; context?: AgentContext; confirmDanger?: ConfirmationHandler; sessionId?: string; skipBeforeMessageHook?: boolean } = {}): Promise<string> {
    return this.turns.run(async () => {
      const signal = this.interrupt.beginTurn();
      try {
        this.config = await loadConfig();
        const cwd = resolveWorkspaceDir(this.config);
        await mkdir(cwd, { recursive: true });
        this.hooks.configure(this.config.hooks, this.config.hookTimeoutSeconds, cwd);
        if (!options.skipBeforeMessageHook) {
          const gate = await this.hooks.run('beforeMessage', { sessionId: options.sessionId, message: prompt });
          if (gate.block) throw new Error(gate.reason ?? 'Message blocked by hook');
        }
        return await runAgentTurn(prompt, options.context ?? this.context, this.registry, this.config, {
          signal,
          cwd,
          retainConversation: options.retainConversation,
          onText: options.stream ? (text) => process.stdout.write(text) : undefined,
          onEvent: options.onEvent,
          getModel: getCurrentModel,
          confirmDanger: options.confirmDanger,
          authorizeCommand: (command, workspace, handler, commandSignal) => this.security.authorize(command, workspace, this.config.security, handler, commandSignal),
          hooks: this.hooks,
          sessionId: options.sessionId,
        });
      } finally { this.interrupt.endTurn(); }
    });
  }

  private async executeCron(job: CronJob): Promise<void> {
    const result = await this.turns.run(async () => {
      const cronContext = new AgentContext(this.memory, this.skills);
      try {
        this.config = await loadConfig();
        const cwd = resolveWorkspaceDir(this.config);
        await mkdir(cwd, { recursive: true });
        this.hooks.configure(this.config.hooks, this.config.hookTimeoutSeconds, cwd);
        return await runAgentTurn(job.prompt, cronContext, this.registry, this.config, {
          cwd, retainConversation: false, getModel: getCurrentModel,
          authorizeCommand: (command, workspace, handler, commandSignal) => this.security.authorize(command, workspace, this.config.security, handler, commandSignal),
          hooks: this.hooks,
        });
      } catch (error) { return `Error: ${(error as Error).message}`; }
    });
    const summary = result.replace(/\s+/g, ' ').trim().slice(0, 500) || '(no text response)';
    this.interrupt.notify({ title: `cron job "${job.name}" fired`, message: summary });
  }

  async close(): Promise<void> { this.scheduler.stop(); await this.mcp.close(); }
}
