import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { json } from '../http.js';
import type { RouteContext } from './route-context.js';

export const STATIC_ASSET_VERSION = '80';

const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** Serves static files from the public directory, then falls through to 404. */
export async function handleStaticRoutes(ctx: RouteContext): Promise<boolean> {
  const { runtime, response, method, pathname } = ctx;
  const staticMatch = pathname.match(/^\/([^/]+)(\.[^.]+)$/);
  const staticContentType = staticMatch ? STATIC_CONTENT_TYPES[staticMatch[2].toLowerCase()] : undefined;
  if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || staticContentType)) {
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const fileContent = await readFile(join(runtime.publicDirectory, filename));
    const isHtml = filename.endsWith('.html');
    const content = isHtml
      ? Buffer.from(fileContent.toString('utf8').replaceAll('{{ASSET_VERSION}}', STATIC_ASSET_VERSION))
      : fileContent;
    response.writeHead(200, {
      'content-type': staticContentType ?? STATIC_CONTENT_TYPES['.html'],
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=3600',
      'content-length': content.byteLength,
    });
    response.end(method === 'HEAD' ? undefined : content);
    return true;
  }
  json(response, 404, { error: 'Not found' });
  return true;
}
