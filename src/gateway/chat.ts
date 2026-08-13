import type { TaiweiApp } from '../app.js';
import { AgentContext } from '../agent/context.js';
import type { AgentEvent } from '../agent/loop.js';
import type { ChatMessage } from '../llm/client.js';

export interface ChatSink {
  event(event: AgentEvent): void;
  error(error: Error): void;
}

export interface ChatBridge {
  run(message: string, sink: ChatSink, history?: ChatMessage[]): Promise<void>;
  stop(): boolean;
}

export class AgentChatBridge implements ChatBridge {
  constructor(private readonly app: TaiweiApp) {}

  async run(message: string, sink: ChatSink, history: ChatMessage[] = []): Promise<void> {
    const context = new AgentContext(this.app.memory, this.app.skills);
    context.setMessages(history);
    for (const skill of this.app.context.listActiveSkills()) context.activateSkill(skill);
    try {
      await this.app.run(message, { context, onEvent: (event) => sink.event(event) });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      sink.error(reason.name === 'AbortError' ? new Error('Turn cancelled') : reason);
    }
  }

  stop(): boolean { return this.app.interrupt.cancel(); }
}
