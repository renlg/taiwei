import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { TaiweiApp } from '../app.js';
import { nextRun } from '../cron/scheduler.js';
import { renderRetrievedContext } from '../rag/prompt.js';
import { buildIndex } from '../rag/index.js';
import { retrieve } from '../rag/retrieve.js';
import { resolveModels, setCurrentModel } from '../config/model.js';
import { expandHome, saveConfig } from '../config/config.js';
import { mkdir, stat } from 'node:fs/promises';
import type { ConfirmationHandler } from '../security/commands.js';
import { randomUUID } from 'node:crypto';
import { appendMessage, getSession, listSessions, rebuildHistoryDb, searchMessages, upsertSession } from '../history/db.js';
import { BUILTIN_AGENTS, getAgentProfile } from '../agents/profiles.js';

const color = {
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
};

const HELP = `Commands:
  /help                         Show this help
  /exit                         Exit taiwei
  /stop                         Cancel the active turn
  /clear                        Clear conversation history
  /model [name]                 List models or change the current model
  /agent list|use <id>|reset    Select Plan or Build agent
  /workspace <path>             Change the default tool working directory
  /skill list|load|unload ...   Manage active skills
  /cron list                    List scheduled jobs
  /cron add <name> <schedule> <prompt>
  /cron remove|pause|resume <id>
  /cron run <id> | history [id]
  /mcp list|reload              Manage MCP connections
  /memory show|clear            Manage persistent memory
  /rag index|search <query>     Index or search local knowledge
  /history list|search|get ...  Query or rebuild conversation history
  /plugin list|reload           Manage plugins

Quote arguments containing spaces, for example:
  /cron add check "every 1h" "Review the project status"`;

function tokenize(input: string): string[] {
  const values: string[] = [];
  let current = '', quote = '', escaped = false;
  for (const char of input.trim()) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) { values.push(current); current = ''; } }
    else current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('Unclosed quote');
  if (current) values.push(current);
  return values;
}

function output(message: string): void { process.stdout.write(`${message}\n`); }

export async function handleModelCommand(app: TaiweiApp, name?: string): Promise<string> {
  const available = await resolveModels();
  if (!name) {
    const lines = available.models.map((model) => `${model === available.current ? '*' : ' '} ${model}`);
    return `Current model: ${available.current}\nAvailable models:\n${lines.join('\n')}`;
  }
  const model = name.trim();
  const known = available.models.includes(model);
  if (!known && available.source !== 'fallback') {
    throw new Error(`Unknown model: ${model}. Available models:\n${available.models.join('\n')}`);
  }
  app.config = await setCurrentModel(model);
  return `[taiwei] Model set to ${model}.`;
}

async function handleCommand(app: TaiweiApp, line: string, rl: Interface): Promise<boolean> {
  const [rawCommand, action, ...args] = tokenize(line);
  const command = rawCommand?.toLowerCase();
  switch (command) {
    case '/help': output(HELP); break;
    case '/exit': rl.close(); return false;
    case '/stop': output(app.interrupt.cancel() ? '[taiwei] Cancelling active turn…' : '[taiwei] No active turn.'); break;
    case '/clear': app.context.clear(); output('[taiwei] Conversation cleared.'); break;
    case '/model': {
      output(await handleModelCommand(app, action)); break;
    }
    case '/agent': {
      if (!action || action === 'list') output(BUILTIN_AGENTS.map((profile) => `${profile.id === app.activeAgentId ? '*' : ' '} ${profile.id} (${profile.mode})`).join('\n'));
      else if (action === 'use' && args[0]) { getAgentProfile(args[0]); app.activeAgentId = args[0]; app.context.clear(); output(`[taiwei] Agent set to ${args[0]}.`); }
      else if (action === 'reset') { app.activeAgentId = 'build'; app.context.clear(); output('[taiwei] Agent reset to build.'); }
      else throw new Error('Usage: /agent list | /agent use <plan|build> | /agent reset');
      break;
    }
    case '/workspace': {
      const path = [action, ...args].filter(Boolean).join(' ').trim();
      if (!path) throw new Error('Usage: /workspace <path>');
      const resolved = expandHome(path);
      await mkdir(resolved, { recursive: true });
      if (!(await stat(resolved)).isDirectory()) throw new Error('Workspace path is not a directory');
      app.config.workspace.dir = path;
      await saveConfig(app.config);
      output(`[taiwei] Workspace set to ${resolved}.`);
      break;
    }
    case '/skill': {
      const pluginSkills = app.plugins.skills();
      if (action === 'list') {
        const installed = [...await app.skills.list(), ...pluginSkills];
        const active = new Set(app.context.listActiveSkills().map((skill) => skill.name));
        output(installed.length ? installed.map((skill) => `${active.has(skill.name) ? '*' : ' '} ${skill.name} — ${skill.description}`).join('\n') : 'No skills installed.');
      } else if (action === 'load' && args[0]) {
        const pluginSkill = pluginSkills.find((skill) => skill.name === args[0]);
        const skill = pluginSkill ?? await app.context.loadSkill(args[0]);
        if (pluginSkill) app.context.activateSkill(pluginSkill);
        output(`[taiwei] Loaded skill ${skill.name}.`);
      } else if (action === 'unload' && args[0]) output(app.context.unloadSkill(args[0]) ? `[taiwei] Unloaded ${args[0]}.` : `[taiwei] Skill ${args[0]} was not active.`);
      else throw new Error('Usage: /skill list | /skill load <name> | /skill unload <name>');
      break;
    }
    case '/cron': {
      if (action === 'list') {
        const jobs = await app.cronJobs.list();
        output(jobs.length ? jobs.map((job) => `${job.id} ${job.enabled ? 'active' : 'paused'} ${job.name} [${job.at ?? job.schedule}] next=${job.enabled ? app.scheduler.next(job)?.toLocaleString() ?? '-' : '-'}`).join('\n') : 'No cron jobs.');
      } else if (action === 'add' && args.length >= 3) {
        nextRun(args[1]);
        const job = await app.cronJobs.add(args[0], args[1], args.slice(2).join(' ')); await app.scheduler.reload();
        output(`[taiwei] Added cron job ${job.id}.`);
      } else if (['remove', 'pause', 'resume'].includes(action ?? '') && args[0]) {
        const ok = action === 'remove' ? await app.cronJobs.remove(args[0]) : await app.cronJobs.setEnabled(args[0], action === 'resume');
        if (ok) await app.scheduler.reload(); output(ok ? `[taiwei] Cron job ${action}d.` : '[taiwei] Cron job not found.');
      } else if (action === 'run' && args[0]) output(JSON.stringify(await app.scheduler.runNow(args[0]), null, 2));
      else if (action === 'history') output(JSON.stringify(await app.scheduler.ledger.list(args[0]), null, 2));
      else throw new Error('Usage: /cron list | add <name> <schedule> <prompt> | remove|pause|resume <id> | run <id> | history [id]');
      break;
    }
    case '/mcp': {
      if (action === 'reload') { await app.mcp.reload(); output('[taiwei] MCP connections reloaded.'); }
      else if (action === 'list') { const statuses = app.mcp.list(); output(statuses.length ? statuses.map((item) => `${item.connected ? 'connected' : 'offline'} ${item.name} — ${item.detail}`).join('\n') : 'No MCP servers configured.'); }
      else throw new Error('Usage: /mcp list | /mcp reload');
      break;
    }
    case '/memory': {
      if (action === 'show') output((await app.memory.read()).trim() || '(memory is empty)');
      else if (action === 'clear') { await app.memory.clear(); output('[taiwei] Memory cleared.'); }
      else throw new Error('Usage: /memory show | /memory clear');
      break;
    }
    case '/rag': {
      if (action === 'index') { const index = await buildIndex(); output(`[taiwei] Indexed ${index.chunks.length} chunks${index.vectors ? ' with embeddings' : ' (BM25 only; embedding unavailable, rebuild to retry)'}.`); }
      else if (action === 'search' && args.length) { const results = await retrieve(args.join(' ')); app.context.setRetrievedContext(renderRetrievedContext(results)); output(results.length ? results.map((item) => `${item.score.toFixed(3)} ${item.source}\n${item.text.slice(0, 300)}`).join('\n\n') : 'No matches.'); }
      else throw new Error('Usage: /rag index | /rag search <query>');
      break;
    }
    case '/history': {
      if (action === 'list') {
        const sessions = await listSessions(Number(args[0] ?? 10));
        output(sessions.length ? sessions.map((session) => `${session.sessionId} ${session.source} ${session.messageCount} ${new Date(session.updatedAt).toLocaleString()} — ${session.title}`).join('\n') : 'No history sessions.');
      } else if (action === 'search' && args.length) {
        const results = await searchMessages(args.join(' '));
        output(results.length ? results.map((result) => `${result.sessionId} ${new Date(result.timestamp).toLocaleString()} — ${result.title}\n${result.snippet}`).join('\n\n') : 'No history matches.');
      } else if (action === 'get' && args[0]) {
        const session = await getSession(args[0], Number(args[1] ?? 50));
        output(session ? JSON.stringify(session, null, 2) : `History session not found: ${args[0]}`);
      } else if (action === 'rebuild') {
        const imported = await rebuildHistoryDb();
        output(`[taiwei] Rebuilt history index from ${imported} gateway sessions.`);
      } else throw new Error('Usage: /history list [limit] | /history search <query> | /history get <id> [maxMessages] | /history rebuild');
      break;
    }
    case '/plugin': {
      if (action === 'reload') { await app.plugins.reload(); output('[taiwei] Plugins reloaded.'); }
      else if (action === 'list') { const statuses = app.plugins.list(); output(statuses.length ? statuses.map((item) => `${item.error ? 'error' : 'loaded'} ${item.name} — ${item.error ?? `${item.tools} tools, ${item.skills} skills`}`).join('\n') : 'No plugins installed.'); }
      else throw new Error('Usage: /plugin list | /plugin reload');
      break;
    }
    default: throw new Error(`Unknown command: ${command}. Use /help.`);
  }
  return true;
}

export async function runRepl(app: TaiweiApp): Promise<void> {
  if (app.config.autoLoadSkills !== false) {
    try {
      app.context.setAvailableSkills(await app.skills.list());
    } catch { /* Skill discovery is optional and must not prevent the REPL from starting. */ }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: color.cyan('taiwei> ') });
  let closing = false;
  let commandQueue: Promise<void> = Promise.resolve();
  let confirming = false;
  const historySessionId = randomUUID();
  const historyCreatedAt = Date.now();
  let historyTitle = '';
  const confirmDanger: ConfirmationHandler = (request) => new Promise((resolve) => {
    confirming = true;
    const level = request.level === 'warn' ? 'warning' : 'DANGER';
    rl.question(`\n[taiwei] ${level}: ${request.reason}\nWorkspace: ${request.workspace}\nCommand: ${request.command}\nAllow this command? [y/N] `, (answer) => {
      confirming = false;
      const approve = /^(?:y|yes)$/i.test(answer.trim());
      resolve({ approve, ...(approve ? { remember: app.config.security.remember } : {}) });
    });
  });
  output(`${color.cyan('taiwei')} ${color.dim(`model: ${app.config.model}`)} — type /help for commands`);
  const redraw = (text: string) => { process.stdout.write(`\n${text}\n`); if (!closing) rl.prompt(true); };
  app.interrupt.on('notification', ({ title, message }) => redraw(color.yellow(`[taiwei] ⏰ ${title}: ${message}`)));

  rl.on('SIGINT', () => {
    if (app.interrupt.cancel()) redraw(color.yellow('[taiwei] Cancelling active turn…'));
    else { output('\n[taiwei] Use /exit or Ctrl+D to quit.'); rl.prompt(); }
  });
  rl.on('line', (raw) => {
    if (confirming) return;
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }
    if (line === '/stop' && app.interrupt.active) {
      output('[taiwei] Cancelling active turn…'); app.interrupt.cancel(); return;
    }
    if (app.interrupt.active) { output('[taiwei] A turn is still running. Use /stop to cancel it.'); rl.prompt(); return; }
    commandQueue = commandQueue.then(async () => {
      try {
        if (line.startsWith('/')) await handleCommand(app, line, rl);
        else {
          process.stdout.write(color.dim('assistant> '));
          await app.run(line, { stream: true, confirmDanger });
          process.stdout.write('\n');
          try {
            let start = -1;
            for (let index = app.context.messages.length - 1; index >= 0; index -= 1) {
              const message = app.context.messages[index];
              if (message?.role === 'user' && message.content === line) { start = index; break; }
            }
            const turnMessages = start < 0 ? [] : app.context.messages.slice(start);
            const now = Date.now();
            historyTitle ||= `${Array.from(line.replace(/\s+/g, ' ').trim()).slice(0, 20).join('')}${Array.from(line).length > 20 ? '…' : ''}`;
            await upsertSession({
              id: historySessionId, title: historyTitle, source: 'cli', model: app.config.model,
              createdAt: historyCreatedAt, updatedAt: now,
            });
            for (const [index, message] of turnMessages.entries()) {
              await appendMessage({
                sessionId: historySessionId, role: message.role, content: message.content ?? '',
                toolName: message.role === 'tool' ? message.name : undefined,
                timestamp: now + index / 1_000,
              });
            }
          } catch { /* History indexing is optional and must not affect the REPL turn. */ }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') output('\n[taiwei] Turn cancelled.');
        else output(color.yellow(`[taiwei] ${(error as Error).message}`));
      }
      if (!closing) rl.prompt();
    });
  });
  rl.prompt();
  await new Promise<void>((resolve) => rl.once('close', () => { closing = true; resolve(); }));
}
