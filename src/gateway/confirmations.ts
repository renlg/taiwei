import type { ConfirmationDecision, ConfirmationRequest } from '../security/commands.js';

interface PendingConfirmation {
  resolve: (decision: ConfirmationDecision) => void;
  timer: NodeJS.Timeout;
}

export class ConfirmationBroker {
  private readonly pending = new Map<string, PendingConfirmation>();

  wait(request: ConfirmationRequest): Promise<ConfirmationDecision> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(request.id, { approve: false }), Math.max(1, request.timeoutSeconds) * 1_000);
      this.pending.set(request.id, { resolve, timer });
    });
  }

  decide(id: string, decision: ConfirmationDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }

  cancel(id: string): boolean { return this.decide(id, { approve: false }); }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}
