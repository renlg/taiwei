import assert from 'node:assert/strict';
import test from 'node:test';
import { openAICompatibleStream } from '../src/llm/client.js';

test('a stream failure after text emission is not retried or sent to fallback', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const emitted: string[] = [];
  const attempts: string[] = [];
  globalThis.fetch = async () => {
    calls += 1;
    let read = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!read) {
          read = true;
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好，这是"}}]}\n\n'));
          return;
        }
        controller.error(new Error('mid-stream disconnect'));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    await assert.rejects(openAICompatibleStream({
      baseUrl: 'http://provider.invalid', apiKey: '', model: 'primary', fallbackModel: 'fallback', messages: [], tools: [],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
      onText: (text) => emitted.push(text),
      onAttempt: (event) => attempts.push(`${event.model}:${event.outcome}`),
    }), /mid-stream disconnect/);
    assert.equal(calls, 1);
    assert.deepEqual(emitted, ['你好，这是']);
    assert.deepEqual(attempts, ['primary:start']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
