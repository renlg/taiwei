import type { ToolSpec } from '../registry.js';
import { getSession, listSessions, searchMessages } from '../../history/db.js';

export interface HistoryToolAccess {
  searchMessages: typeof searchMessages;
  listSessions: typeof listSessions;
  getSession: typeof getSession;
}

export function createHistoryTools(access: HistoryToolAccess = { searchMessages, listSessions, getSession }): ToolSpec[] { return [
  {
    name: 'session_search',
    description: '搜索历史会话中的消息。当用户问“之前说过什么、做过什么”或需要找回过去讨论时使用；支持中文内容检索。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要在历史消息中搜索的文字' }, limit: { type: 'number', description: '最多返回多少条结果，默认 5' } },
      required: ['query'], additionalProperties: false,
    },
    async execute(args) {
      const results = await access.searchMessages(String(args.query ?? ''), Number(args.limit ?? 5));
      return results.length ? results : { results: [], message: 'No matching historical messages.' };
    },
  },
  {
    name: 'session_list',
    description: '列出最近的历史会话及标题、来源、消息数和更新时间，用于定位可能相关的过去会话。',
    parameters: {
      type: 'object', properties: { limit: { type: 'number', description: '最多返回多少个会话，默认 10' } }, additionalProperties: false,
    },
    execute: (args) => access.listSessions(Number(args.limit ?? 10)),
  },
  {
    name: 'session_get',
    description: '按会话 ID 读取历史会话的元数据和最近消息；通常先用 session_search 或 session_list 找到 ID。',
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '历史会话 ID' }, maxMessages: { type: 'number', description: '最多读取最近多少条消息，默认 50' } },
      required: ['sessionId'], additionalProperties: false,
    },
    async execute(args) {
      const sessionId = String(args.sessionId ?? '').trim();
      const session = await access.getSession(sessionId, Number(args.maxMessages ?? 50));
      return session ?? { error: `History session not found: ${sessionId}` };
    },
  },
]; }

export const historyTools = createHistoryTools();
