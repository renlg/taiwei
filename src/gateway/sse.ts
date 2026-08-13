import type { ServerResponse } from 'node:http';

export type SseEvent = 'token' | 'tool' | 'tool_result' | 'usage' | 'done' | 'error';

export function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();
}

export function sendSse(response: ServerResponse, event: SseEvent, data: unknown): void {
  if (!response.destroyed && !response.writableEnded) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
