import { EventEmitter } from 'node:events';

export interface ProactiveNotification { title: string; message: string; }

export class InterruptManager extends EventEmitter {
  private controller?: AbortController;

  beginTurn(): AbortSignal {
    if (this.controller) throw new Error('A turn is already running');
    this.controller = new AbortController();
    return this.controller.signal;
  }

  endTurn(): void { this.controller = undefined; }
  get active(): boolean { return Boolean(this.controller); }
  cancel(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }

  notify(notification: ProactiveNotification): void { this.emit('notification', notification); }
}

export class TurnQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
