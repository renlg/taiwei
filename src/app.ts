import { AgentContext } from './agent/context.js';
import { InterruptManager, TurnQueue } from './agent/interrupt.js';
import { runAgentTurn, type AgentEvent } from './agent/loop.js';
import { loadConfig, type TaiweiConfig } from './config/config.js';
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

  async initialize(options: { external?: boolean; scheduler?: boolean } = {}): Promise<void> {
    this.config = await loadConfig();
    for (const tool of [bashTool, readTool, writeTool, searchTool, ragSearchTool, ...createMemoryTools(this.memory)]) this.registry.register(tool);
    if (options.external !== false) {
      await this.plugins.reload();
      await this.mcp.reload();
    }
    if (options.scheduler !== false) await this.scheduler.start();
  }

  async run(prompt: string, options: { stream?: boolean; retainConversation?: boolean; onEvent?: (event: AgentEvent) => void; context?: AgentContext } = {}): Promise<string> {
    return this.turns.run(async () => {
      const signal = this.interrupt.beginTurn();
      try {
        return await runAgentTurn(prompt, options.context ?? this.context, this.registry, this.config, {
          signal,
          retainConversation: options.retainConversation,
          onText: options.stream ? (text) => process.stdout.write(text) : undefined,
          onEvent: options.onEvent,
        });
      } finally { this.interrupt.endTurn(); }
    });
  }

  private async executeCron(job: CronJob): Promise<void> {
    const result = await this.turns.run(async () => {
      const cronContext = new AgentContext(this.memory, this.skills);
      try {
        return await runAgentTurn(job.prompt, cronContext, this.registry, this.config, { retainConversation: false });
      } catch (error) { return `Error: ${(error as Error).message}`; }
    });
    const summary = result.replace(/\s+/g, ' ').trim().slice(0, 500) || '(no text response)';
    this.interrupt.notify({ title: `cron job "${job.name}" fired`, message: summary });
  }

  async close(): Promise<void> { this.scheduler.stop(); await this.mcp.close(); }
}
