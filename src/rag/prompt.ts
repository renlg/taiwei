import type { SearchResult } from './retrieve.js';

export function renderRetrievedContext(results: SearchResult[]): string {
  if (!results.length) return '';
  return `Retrieved knowledge:\n${results.map((item) => `[${item.source}]\n${item.text}`).join('\n\n')}`;
}
