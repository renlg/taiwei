export interface TurnController {
  running: boolean;
  abortController?: AbortController;
  pendingConfirmations: Map<string, unknown>;
  queue: number;
}

export class SessionRuntime {
  private readonly sessions = new Map<string, TurnController & { tail: Promise<void> }>();
  private active = 0;
  private readonly capacityWaiters: Array<() => void> = [];

  constructor(readonly maxConcurrentTurns = 4) {
    if (!Number.isInteger(maxConcurrentTurns) || maxConcurrentTurns < 1) throw new Error('maxConcurrentTurns must be a positive integer');
  }

  controller(sessionId: string): TurnController {
    return this.ensure(sessionId);
  }

  run<T>(sessionId: string, task: (signal: AbortSignal, controller: TurnController) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
    const state = this.ensure(sessionId);
    state.queue += 1;
    const execute = async () => {
      await this.acquire();
      state.queue -= 1;
      const controller = new AbortController();
      state.abortController = controller;
      state.running = true;
      const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
      try { return await task(signal, state); }
      finally {
        state.running = false;
        state.abortController = undefined;
        state.pendingConfirmations.clear();
        this.release();
      }
    };
    const result = state.tail.then(execute, execute);
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  stop(sessionId: string): boolean {
    const controller = this.sessions.get(sessionId)?.abortController;
    if (!controller) return false;
    controller.abort();
    return true;
  }

  get activeTurns(): number { return this.active; }

  private ensure(sessionId: string): TurnController & { tail: Promise<void> } {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { running: false, pendingConfirmations: new Map(), queue: 0, tail: Promise.resolve() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrentTurns) { this.active += 1; return; }
    await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.capacityWaiters.shift()?.();
  }
}
