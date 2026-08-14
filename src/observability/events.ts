import { EventEmitter } from 'node:events';

export interface ObservabilityEvent {
  type: string; timestamp?: string; runId: string; sessionId: string; agentId?: string;
  tool?: string; model?: string; latencyMs?: number; usage?: unknown; retryAttempt?: number;
  outcome: string; [key: string]: unknown;
}

export const observability = new EventEmitter();
export function emitEvent(event: ObservabilityEvent): void {
  observability.emit('event', { timestamp: new Date().toISOString(), ...event });
}
