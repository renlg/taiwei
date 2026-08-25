import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeContextMessages, SessionStore, type GatewaySession } from '../src/gateway/sessions.js';
import type { ChatMessage } from '../src/llm/client.js';

const validCall = {
  id: 'call-valid',
  type: 'function' as const,
  function: { name: 'read_file', arguments: '{"path":"README.md"}' },
};

test('sanitizeContextMessages keeps valid calls and removes calls with empty arguments', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant', content: null, tool_calls: [
        validCall,
        { id: 'call-empty', type: 'function', function: { name: 'bash', arguments: '' } },
      ],
    },
    { role: 'tool', content: 'read result', tool_call_id: 'call-valid' },
    { role: 'tool', content: 'bad result', tool_call_id: 'call-empty' },
  ];

  assert.deepEqual(sanitizeContextMessages(messages), [
    { role: 'assistant', content: null, tool_calls: [validCall] },
    { role: 'tool', content: 'read result', tool_call_id: 'call-valid' },
  ]);
});

test('sanitizeContextMessages removes an assistant with only invalid calls and its tool results', () => {
  const messages = [
    { role: 'user', content: 'run it' },
    {
      role: 'assistant', content: null, tool_calls: [
        { id: 'call-empty', type: 'function', function: { name: 'bash', arguments: '   ' } },
        { id: 'call-json', type: 'function', function: { name: 'read_file', arguments: '{bad json}' } },
      ],
    },
    { role: 'tool', content: 'first result', tool_call_id: 'call-empty' },
    { role: 'tool', content: 'second result', tool_call_id: 'call-json' },
    { role: 'assistant', content: 'finished' },
  ] as ChatMessage[];

  assert.deepEqual(sanitizeContextMessages(messages), [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: 'finished' },
  ]);
});

test('sanitizeContextMessages preserves normal messages and valid tool calls', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: null, tool_calls: [validCall] },
    { role: 'tool', content: 'result', tool_call_id: 'call-valid' },
    { role: 'assistant', content: 'done' },
  ];

  assert.deepEqual(sanitizeContextMessages(messages), messages);
});

test('toChatHistory sanitizes previously persisted dirty context messages', () => {
  const dirtyCall = {
    id: 'call-dirty', type: 'function', function: { name: 'bash', arguments: 42 },
  } as unknown as typeof validCall;
  const session: GatewaySession = {
    id: '00000000-0000-0000-0000-000000000000',
    title: 'dirty history',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
    contextMessages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null, tool_calls: [dirtyCall] },
      { role: 'tool', content: 'dirty result', tool_call_id: 'call-dirty' },
    ],
  };

  assert.deepEqual(new SessionStore().toChatHistory(session), [{ role: 'user', content: 'hello' }]);
  assert.equal((session.contextMessages?.[1] as { tool_calls?: unknown[] }).tool_calls?.length, 1);
});
