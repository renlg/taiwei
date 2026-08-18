import type { ToolSpec, ToolConfigSchema } from '../registry.js';

const CONFIG: ToolConfigSchema = {
  provider: { type: 'string', default: 'tavily', label: '搜索提供商', description: 'tavily 或 serper' },
  apiKey: { type: 'string', default: '', label: 'API Key', description: '留空则读取环境变量 TAIWEI_WEB_SEARCH_API_KEY' },
};

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchTavily(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: limit }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Tavily search failed: HTTP ${response.status}`);
  const data = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? []).map((item) => ({ title: item.title ?? '', url: item.url ?? '', snippet: item.content ?? '' }));
}

async function searchSerper(query: string, limit: number, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ q: query, num: limit }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Serper search failed: HTTP ${response.status}`);
  const data = await response.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.organic ?? []).map((item) => ({ title: item.title ?? '', url: item.link ?? '', snippet: item.snippet ?? '' }));
}

export const webSearchTool: ToolSpec = {
  name: 'web_search',
  description: 'Search the public web and return a list of results with titles, URLs, and snippets.',
  configSchema: CONFIG,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Number of results (1-10, default 5)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query must be a non-empty string');
    const limit = Math.max(1, Math.min(10, typeof args.limit === 'number' ? Math.floor(args.limit) : 5));
    const provider = typeof context.toolConfig?.provider === 'string' ? context.toolConfig.provider : 'tavily';
    const configuredKey = typeof context.toolConfig?.apiKey === 'string' ? context.toolConfig.apiKey : '';
    const apiKey = configuredKey || process.env.TAIWEI_WEB_SEARCH_API_KEY || '';
    if (!apiKey) {
      return { error: '未配置网络搜索 API Key。请在设置的工具面板为 web_search 配置 apiKey，或设置环境变量 TAIWEI_WEB_SEARCH_API_KEY。' };
    }
    const results = provider === 'serper' ? await searchSerper(query, limit, apiKey) : await searchTavily(query, limit, apiKey);
    return { results };
  },
};
