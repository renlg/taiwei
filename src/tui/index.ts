import { emitKeypressEvents } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { TaiweiApp } from '../app.js';
import type { ChatMessage } from '../llm/client.js';
import { appendMessage, getSession, listSessions, upsertSession } from '../history/db.js';
import { BUILTIN_AGENTS, getAgentProfile } from '../agents/profiles.js';
import { resolveModelCatalog } from '../config/model.js';
import { completeCommand, parseInput, renderLine } from './state.js';

const ansi = {
  clear: '\x1b[2J\x1b[H', eraseLine: '\x1b[2K', home: '\r', hide: '\x1b[?25l', show: '\x1b[?25h',
  bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', reset: '\x1b[0m',
};
interface ViewMessage { role: 'user' | 'assistant' | 'tool' | 'status'; text: string; running?: boolean; }

export class TerminalTui {
  private messages: ViewMessage[] = [];
  private draft = '';
  private inputHistory: string[] = [];
  private historyIndex = -1;
  private busy = false;
  private closed = false;
  private sessionId: string = randomUUID();
  private sessionCreatedAt = Date.now();
  private title = '';
  private tokens = 0;
  private model: string;
  private providerId: string;
  private selectedSession = 0;

  constructor(private readonly app: TaiweiApp) {
    this.model = app.config.model;
    this.providerId = app.config.defaultProvider;
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) throw new Error('TUI requires a TTY');
    await this.pickSession();
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write(ansi.hide);
    const onResize = () => this.render(); process.on('SIGWINCH', onResize);
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => { void this.key(text, key); };
    process.stdin.on('keypress', onKey);
    this.render();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => { if (this.closed) { clearInterval(timer); resolve(); } }, 25); timer.unref?.();
    });
    process.stdin.off('keypress', onKey); process.off('SIGWINCH', onResize);
    process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write(`${ansi.show}${ansi.reset}${ansi.clear}`);
  }

  private async pickSession(): Promise<void> {
    let sessions: Awaited<ReturnType<typeof listSessions>> = [];
    try { sessions = await listSessions(8); } catch { return; }
    if (!sessions.length) return;
    const choices = [{ sessionId: '', title: 'New session', source: '', messageCount: 0, updatedAt: Date.now() }, ...sessions];
    emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write(ansi.hide);
    await new Promise<void>((resolve) => {
      const paint = () => process.stdout.write(`${ansi.clear}${ansi.bold}Resume a session${ansi.reset}\n\n${choices.map((item, index) => `${index === this.selectedSession ? `${ansi.cyan}>` : ' '} ${item.title}${ansi.reset}${item.sessionId ? ` ${ansi.dim}${item.sessionId.slice(0, 8)} · ${item.messageCount} messages${ansi.reset}` : ''}`).join('\n')}\n\n${ansi.dim}j/k or arrows · Enter select${ansi.reset}`);
      const listener = (_text: string, key: { name?: string; ctrl?: boolean }) => {
        if (key.ctrl && (key.name === 'c' || key.name === 'd')) { this.selectedSession = 0; finish(); return; }
        if (key.name === 'up' || key.name === 'k') this.selectedSession = (this.selectedSession - 1 + choices.length) % choices.length;
        else if (key.name === 'down' || key.name === 'j') this.selectedSession = (this.selectedSession + 1) % choices.length;
        else if (key.name === 'return') { finish(); return; }
        paint();
      };
      const finish = () => { process.stdin.off('keypress', listener); resolve(); };
      process.stdin.on('keypress', listener); paint();
    });
    process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write(ansi.show);
    const choice = choices[this.selectedSession]; if (choice?.sessionId) await this.resume(choice.sessionId);
  }

  private async key(text: string, key: { name?: string; ctrl?: boolean }): Promise<void> {
    if (key.ctrl && key.name === 'd') { if (!this.busy) this.closed = true; return; }
    if (key.ctrl && key.name === 'c') {
      if (this.busy) this.app.stopSession(this.sessionId); else this.draft = '';
      this.renderInput(); return;
    }
    if (key.ctrl && key.name === 'l') { this.messages = []; this.render(); return; }
    if (this.busy) return;
    if (key.name === 'return') { const value = this.draft; this.draft = ''; this.renderInput(); await this.submit(value); return; }
    if (key.name === 'backspace') this.draft = Array.from(this.draft).slice(0, -1).join('');
    else if (key.name === 'up') this.moveHistory(1);
    else if (key.name === 'down') this.moveHistory(-1);
    else if (key.name === 'tab') this.draft = completeCommand(this.draft);
    else if (text && !key.ctrl && !/^[\x00-\x1f]$/.test(text)) this.draft += text;
    this.renderInput();
  }

  private moveHistory(direction: number): void {
    if (!this.inputHistory.length) return;
    this.historyIndex = Math.max(-1, Math.min(this.inputHistory.length - 1, this.historyIndex + direction));
    this.draft = this.historyIndex < 0 ? '' : this.inputHistory[this.inputHistory.length - 1 - this.historyIndex]!;
  }

  private async submit(raw: string): Promise<void> {
    let parsed; try { parsed = parseInput(raw); } catch (error) { this.status((error as Error).message, true); return; }
    if (parsed.kind === 'empty') return;
    this.inputHistory.push(raw); this.historyIndex = -1;
    if (parsed.kind === 'command') { await this.command(parsed.command, parsed.args); return; }
    this.messages.push({ role: 'user', text: parsed.text }, { role: 'assistant', text: '' });
    this.title ||= Array.from(parsed.text).slice(0, 30).join(''); this.busy = true; this.render();
    const assistant = this.messages.at(-1)!;
    try {
      const answer = await this.app.run(parsed.text, {
        sessionId: this.sessionId, runtimeSessionId: `tui:${this.sessionId}`, context: this.app.context,
        agentId: this.app.activeAgentId, providerId: this.providerId, model: this.model,
        onEvent: (event) => {
          if (event.type === 'token') { assistant.text += event.text; this.render(); }
          else if (event.type === 'tool') { this.messages.push({ role: 'tool', text: `🔧 ${event.name}(${JSON.stringify(event.args).slice(0, 120)})`, running: true }); this.render(); }
          else if (event.type === 'tool_result') { const tool = [...this.messages].reverse().find((item) => item.role === 'tool' && item.running); if (tool) { tool.running = false; tool.text += ` → ${event.result.slice(0, 100)}`; } this.render(); }
          else if (event.type === 'usage') { this.tokens += event.usage.totalTokens; this.renderStatus(); }
        },
      });
      if (!assistant.text) assistant.text = answer;
      await this.persist(parsed.text, answer);
    } catch (error) { assistant.text ||= (error as Error).name === 'AbortError' ? '[cancelled]' : `[error] ${(error as Error).message}`; }
    finally { this.busy = false; this.render(); }
  }

  private async command(command: string, args: string[]): Promise<void> {
    try {
      if (command === '/exit') { this.closed = true; return; }
      if (command === '/stop') { this.app.stopSession(this.sessionId); return; }
      if (command === '/clear') { this.app.context.clear(); this.messages = []; this.status('Conversation cleared'); return; }
      if (command === '/help') { this.status('/resume <id> · /export <path> · /agent [plan|build|research] · /model [provider/model] · /clear · /exit'); return; }
      if (command === '/resume' && args[0]) { await this.resume(args[0]); this.render(); return; }
      if (command === '/export' && args[0]) { const session = await getSession(this.sessionId, 10_000); await writeFile(args.join(' '), `${JSON.stringify(session, null, 2)}\n`, 'utf8'); this.status(`Exported ${args.join(' ')}`); return; }
      if (command === '/agent') {
        if (!args[0]) this.status(BUILTIN_AGENTS.map((item) => `${item.id === this.app.activeAgentId ? '*' : ' '} ${item.id} (${item.mode})`).join('\n'));
        else { getAgentProfile(args[0]); this.app.activeAgentId = args[0]; this.status(`Agent set to ${args[0]}`); }
        return;
      }
      if (command === '/model') { await this.modelCommand(args[0]); return; }
      this.status(`Unsupported TUI command: ${command}. Use --repl for the full legacy command set.`, true);
    } catch (error) { this.status((error as Error).message, true); }
  }

  private async modelCommand(value?: string): Promise<void> {
    const catalog = await resolveModelCatalog();
    if (!value) { this.status((catalog.providers ?? []).map((provider) => `${provider.name}: ${provider.models.map((model) => `${provider.id === this.providerId && model.id === this.model ? '*' : ''}${model.id}`).join(', ')}`).join('\n')); return; }
    const slash = value.indexOf('/'); const providerId = slash > 0 ? value.slice(0, slash) : this.providerId; const model = slash > 0 ? value.slice(slash + 1) : value;
    const provider = catalog.providers?.find((item) => item.id === providerId);
    if (!provider || !provider.models.some((item) => item.id === model)) throw new Error(`Unknown provider/model: ${providerId}/${model}`);
    this.providerId = providerId; this.model = model; this.status(`Model set for this session: ${providerId}/${model}`);
  }

  private async resume(id: string): Promise<void> {
    const session = await getSession(id, 10_000); if (!session) throw new Error(`Session not found: ${id}`);
    this.sessionId = id; this.sessionCreatedAt = session.createdAt; this.title = session.title;
    const messages: ChatMessage[] = session.messages.flatMap((message): ChatMessage[] => {
      if (message.role === 'system' || message.role === 'user') return [{ role: message.role, content: message.content }];
      if (message.role === 'assistant') return [{ role: 'assistant', content: message.content }];
      return []; // Indexed history lacks tool_call_id, so tool rows remain visual-only when resumed.
    });
    this.app.context.setMessages(messages);
    this.messages = session.messages.map((message) => ({ role: message.role === 'tool' ? 'tool' : message.role as 'user' | 'assistant', text: message.content }));
    if (session.model) this.model = session.model;
  }

  private async persist(prompt: string, answer: string): Promise<void> {
    const now = Date.now();
    await upsertSession({ id: this.sessionId, title: this.title, source: 'tui', model: this.model, createdAt: this.sessionCreatedAt, updatedAt: now, agentId: this.app.activeAgentId });
    await appendMessage({ sessionId: this.sessionId, role: 'user', content: prompt, timestamp: now });
    await appendMessage({ sessionId: this.sessionId, role: 'assistant', content: answer, timestamp: now + .001 });
  }

  private status(text: string, error = false): void { this.messages.push({ role: 'status', text: `${error ? '⚠ ' : ''}${text}` }); this.render(); }
  private dimensions(): { width: number; height: number } { return { width: Math.max(40, process.stdout.columns ?? 80), height: Math.max(10, process.stdout.rows ?? 24) }; }
  private render(): void {
    const { width, height } = this.dimensions(); const paneHeight = height - 3;
    const lines = this.messages.flatMap((message) => message.text.split('\n').map((line) => {
      const prefix = message.role === 'user' ? `${ansi.cyan}you ›${ansi.reset} ` : message.role === 'assistant' ? `${ansi.green}ai  ›${ansi.reset} ` : message.role === 'tool' ? `${ansi.dim}` : `${ansi.yellow}`;
      return `${prefix}${renderLine(line, Math.max(1, width - 6))}${message.role === 'tool' || message.role === 'status' ? ansi.reset : ''}`;
    })).slice(-paneHeight);
    process.stdout.write(`${ansi.clear}${this.statusText(width)}\n${lines.join('\n')}\n${'\n'.repeat(Math.max(0, paneHeight - lines.length))}`);
    this.renderInput();
  }
  private statusText(width: number): string { return `${ansi.bold}${renderLine(` taiwei · ${this.sessionId.slice(0, 8)} · ${this.app.activeAgentId} · ${this.providerId}/${this.model} · ${this.tokens} tokens`, width)}${ansi.reset}`; }
  private renderStatus(): void { const { width } = this.dimensions(); process.stdout.write(`\x1b[1;1H${this.statusText(width)}`); }
  private renderInput(): void { const { width, height } = this.dimensions(); process.stdout.write(`\x1b[${height};1H${ansi.eraseLine}${this.busy ? `${ansi.dim}thinking…${ansi.reset}` : `${ansi.cyan}›${ansi.reset} ${renderLine(this.draft, width - 2).trimEnd()}`}`); }
}

export async function runTui(app: TaiweiApp): Promise<void> { await new TerminalTui(app).run(); }
