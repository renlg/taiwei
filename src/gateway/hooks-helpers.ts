import { HOOK_EVENTS, type HookCommands, type HookEvent } from '../hooks/runner.js';
import { HttpError } from './http.js';

export function validateHooks(value: unknown): HookCommands {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'hooks must be an object');
  const record = value as Record<string, unknown>;
  return Object.fromEntries(HOOK_EVENTS.map((event) => {
    const commands = record[event];
    if (!Array.isArray(commands) || !commands.every((command) => typeof command === 'string')) {
      throw new HttpError(400, `hooks.${event} must be an array of command strings`);
    }
    return [event, commands.map((command) => command.trim()).filter(Boolean)];
  })) as unknown as HookCommands;
}

export function sampleHookFields(event: HookEvent, workspace: string): Record<string, unknown> {
  if (event === 'beforeMessage') return { sessionId: 'test-session', message: 'Hook test message' };
  if (event === 'beforeLLM') return { sessionId: 'test-session', model: 'test-model', messagesCount: 1, lastMessagePreview: 'Hook test message' };
  if (event === 'afterLLM') return { sessionId: 'test-session', model: 'test-model', contentPreview: 'Hook test response', usage: { promptTokens: 10, completionTokens: 5 } };
  if (event === 'beforeTool') return { sessionId: 'test-session', tool: 'bash', args: { command: 'echo hook-test' }, cwd: workspace };
  return { sessionId: 'test-session', tool: 'bash', args: { command: 'echo hook-test' }, ok: true, resultPreview: 'hook-test' };
}
