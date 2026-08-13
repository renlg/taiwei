import type { TaiweiApp } from '../app.js';
import type { AgentEvent } from '../agent/loop.js';

export interface ChatSink {
  event(event: AgentEvent): void;
  error(error: Error): void;
}

export interface ChatBridge {
  run(message: string, sink: ChatSink): Promise<void>;
  stop(): boolean;
}

export class AgentChatBridge implements ChatBridge {
  constructor(private readonly app: TaiweiApp) {}

  async run(message: string, sink: ChatSink): Promise<void> {
    try {
      await this.app.run(message, { onEvent: (event) => sink.event(event) });
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      sink.error(reason.name === 'AbortError' ? new Error('Turn cancelled') : reason);
    }
  }

  stop(): boolean { return this.app.interrupt.cancel(); }
}
