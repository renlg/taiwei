import { randomUUID } from 'node:crypto';
import type { AgentProfile } from '../agents/profiles.js';

export interface DelegateRequest { task: string; profile: AgentProfile; parentProfile: AgentProfile; parentSessionId?: string; depth: number; signal?: AbortSignal }
export type DelegateRunner = (request: DelegateRequest & { childSessionId: string; signal: AbortSignal }) => Promise<string>;

export class DelegationManager {
  private active = 0;
  constructor(private readonly runner: DelegateRunner, private readonly maxConcurrent = 3, private readonly maxDepth = 2) {}
  get activeCount(): number { return this.active; }
  async delegate(request: DelegateRequest): Promise<{ sessionId: string; result: string }> {
    if (request.depth >= this.maxDepth) throw new Error(`Delegation depth limit reached (${this.maxDepth})`);
    if (this.active >= this.maxConcurrent) throw new Error(`Delegation parallel limit reached (${this.maxConcurrent})`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const childSessionId = randomUUID();
    this.active += 1;
    try { return { sessionId: childSessionId, result: await this.runner({ ...request, childSessionId, signal: controller.signal }) }; }
    finally { this.active -= 1; request.signal?.removeEventListener('abort', abort); }
  }
}
