export interface RetryOptions {
  maxAttempts: number; baseDelayMs: number; maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>; random?: () => number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export class ProviderHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) { super(message); }
}

export function retryableProviderError(error: unknown): boolean {
  if (error instanceof ProviderHttpError) return error.status === 429 || error.status >= 500;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  return error instanceof TypeError || (error instanceof Error && /fetch|network|socket|ECONN|ETIMEDOUT/i.test(error.message));
}

export async function withProviderRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<{ value: T; attempts: number }> {
  const attempts = Math.max(1, Math.floor(options.maxAttempts));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return { value: await operation(attempt), attempts: attempt }; }
    catch (error) {
      lastError = error;
      if (attempt >= attempts || !retryableProviderError(error)) throw error;
      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const retryAfter = error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
      const delay = Math.max(retryAfter ?? 0, Math.round(exponential * (0.5 + random() * 0.5)));
      options.onRetry?.(attempt + 1, delay, error);
      await sleep(delay);
    }
  }
  throw lastError;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}
