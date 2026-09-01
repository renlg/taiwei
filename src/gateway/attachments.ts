import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { ContentBlock } from '../llm/client.js';
import { HttpError, sanitizeFilename, withinDirectory } from './http.js';

export const MAX_FILES_PER_MESSAGE = 5;
export const ATTACHMENT_TEXT_LIMIT = 8_000;
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;
export const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv', '.log',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.java', '.go', '.c', '.h', '.cc',
  '.cpp', '.cxx', '.hpp', '.html', '.htm', '.css', '.scss', '.less', '.sql', '.sh', '.bash',
  '.zsh', '.fish', '.xml', '.toml', '.ini', '.conf', '.env', '.rs', '.rb', '.php', '.swift',
  '.kt', '.kts', '.scala', '.vue', '.svelte', '.tex', '.rst', '.properties', '.gradle', '.dockerfile',
]);
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);

export interface UploadedFile {
  name: string;
  path: string;
  url: string;
  size: number;
  type: string;
  content?: string;
  contentTruncated?: boolean;
}

export function isImageFile(name: string, mimeType: string | undefined, extension: string): boolean {
  if (IMAGE_EXTENSIONS.has(extension)) return true;
  if (typeof mimeType === 'string' && mimeType.startsWith('image/')) return true;
  return false;
}

export function isTextFile(name: string, mimeType: string | undefined, extension: string): boolean {
  if (isImageFile(name, mimeType, extension)) return false;
  if (TEXT_EXTENSIONS.has(extension) || name.toLowerCase() === 'dockerfile') return true;
  const normalizedMime = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalizedMime?.startsWith('text/') === true
    || normalizedMime === 'application/json'
    || normalizedMime === 'application/ld+json'
    || normalizedMime === 'application/javascript'
    || normalizedMime === 'application/xml'
    || normalizedMime === 'application/yaml'
    || normalizedMime === 'application/x-yaml';
}

export function uploadedText(data: Buffer, name: string, mimeType: string): { content?: string; contentTruncated?: true } {
  if (!isTextFile(name, mimeType, extname(name).toLowerCase())) return {};
  const decoded = data.toString('utf8');
  return {
    content: decoded.slice(0, ATTACHMENT_TEXT_LIMIT),
    ...(decoded.length > ATTACHMENT_TEXT_LIMIT ? { contentTruncated: true as const } : {}),
  };
}

export function validateAttachedContent(candidate: Partial<UploadedFile>, textFile: boolean): { content?: string; truncated: boolean } {
  if (candidate.contentTruncated !== undefined && typeof candidate.contentTruncated !== 'boolean') {
    throw new HttpError(400, 'Invalid attachment contentTruncated flag');
  }
  if (candidate.content === undefined) {
    if (candidate.contentTruncated !== undefined) throw new HttpError(400, 'Attachment contentTruncated requires content');
    return { truncated: false };
  }
  if (!textFile) throw new HttpError(400, 'Attachment content is only allowed for text files');
  if (typeof candidate.content !== 'string') throw new HttpError(400, 'Attachment content must be a string');
  if (candidate.content.length > ATTACHMENT_TEXT_LIMIT) {
    throw new HttpError(400, `Attachment content must contain at most ${ATTACHMENT_TEXT_LIMIT} characters`);
  }
  return { content: candidate.content, truncated: candidate.contentTruncated === true };
}

function buildGenerationInstructions(imageRefs: Array<{ name: string; url: string }>): string {
  const lines: string[] = [];
  lines.push('');
  if (imageRefs.length > 0) {
    lines.push('以上图片可在图片/视频生成任务中用作参考图（保持人物/风格一致性）。');
    lines.push(`调用 generate_image 时，将图片 URL 传给 image 参数；调用 generate_video 时同理。可使用的参考图：${imageRefs.map((ref) => ref.url).join(', ')}`);
  }
  lines.push('注意：只有图片类型文件（MIME 为 image/* 或扩展名为 png/jpg/jpeg/webp/gif/bmp）才能作为 generate_image 和 generate_video 的 image 参数。非图片文件绝不能传给生成工具的 image 参数。');
  return lines.join('\n');
}

export async function attachmentContext(files: unknown, uploadsDirectory: string): Promise<string> {
  if (files === undefined) return '';
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_MESSAGE) throw new HttpError(400, `files must contain at most ${MAX_FILES_PER_MESSAGE} uploads`);
  const sections: string[] = [];
  const imageRefs: Array<{ name: string; url: string }> = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Invalid uploaded file metadata');
    const candidate = item as Partial<UploadedFile>;
    if (typeof candidate.path !== 'string') throw new HttpError(400, 'Invalid uploaded file path');
    const remote = candidate.path.startsWith('http://') || candidate.path.startsWith('https://');
    if (!remote && !withinDirectory(candidate.path, uploadsDirectory)) throw new HttpError(400, 'Invalid uploaded file path');
    const info = remote ? undefined : await stat(candidate.path).catch(() => undefined);
    if (!remote && !info?.isFile()) throw new HttpError(400, 'Uploaded file does not exist');
    const name = sanitizeAttachmentName(candidate);
    const extension = extname(name).toLowerCase();
    let remoteExtension = '';
    if (remote) {
      try { remoteExtension = extname(new URL(candidate.path).pathname).toLowerCase(); } catch {}
    }
    const effectiveExtension = remoteExtension || extension;
    const mimeType = typeof candidate.type === 'string' ? candidate.type : undefined;
    const fileUrl = remote ? candidate.path : (typeof candidate.url === 'string' && candidate.url ? candidate.url : resolve(candidate.path));
    const textFile = isTextFile(name, mimeType, effectiveExtension);
    const attachedText = validateAttachedContent(candidate, textFile);
    if (isImageFile(name, mimeType, effectiveExtension)) {
      sections.push(`[图片] ${name}: ${fileUrl}`);
      if (remote || typeof candidate.url === 'string') {
        imageRefs.push({ name, url: fileUrl });
      }
    } else if (textFile) {
      if (attachedText.content !== undefined) {
        sections.push(`[附件: ${name}]\n${attachedText.content}${attachedText.truncated ? '\n[内容已截断]' : ''}`);
      } else {
        sections.push(`[文本] ${name}: ${fileUrl}`);
      }
    } else {
      sections.push(`[附件] ${name}: ${fileUrl}`);
    }
  }
  if (!sections.length) return '';
  const instructions = buildGenerationInstructions(imageRefs);
  return `\n\n---用户上传文件---\n${sections.join('\n')}${instructions}`;
}

function sanitizeAttachmentName(candidate: Partial<UploadedFile>): string {
  return sanitizeFilename(typeof candidate.name === 'string' ? candidate.name : candidate.path!.split('/').pop() ?? 'attachment');
}

export function attachmentGenerationInstructions(files: unknown): string {
  if (!Array.isArray(files) || files.length === 0) return '';
  const imageRefs: Array<{ name: string; url: string }> = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<UploadedFile>;
    const name = sanitizeFilename(typeof candidate.name === 'string' ? candidate.name : '');
    const extension = extname(name).toLowerCase();
    const mimeType = typeof candidate.type === 'string' ? candidate.type : undefined;
    if (!isImageFile(name, mimeType, extension)) continue;
    const remote = typeof candidate.path === 'string' && (candidate.path.startsWith('http://') || candidate.path.startsWith('https://'));
    const url = remote ? candidate.path : (typeof candidate.url === 'string' ? candidate.url : '');
    if (url) imageRefs.push({ name, url });
  }
  if (imageRefs.length === 0 && !files.some((item) => item && typeof item === 'object')) return '';
  return buildGenerationInstructions(imageRefs);
}

const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

function imageMimeType(extension: string): string {
  return IMAGE_MIME_MAP[extension] ?? 'image/png';
}

export async function buildMultimodalContent(files: unknown, uploadsDirectory: string): Promise<{ blocks: ContentBlock[]; fallbackText: string }> {
  if (files === undefined) return { blocks: [], fallbackText: '' };
  if (!Array.isArray(files) || files.length > MAX_FILES_PER_MESSAGE) throw new HttpError(400, `files must contain at most ${MAX_FILES_PER_MESSAGE} uploads`);
  const blocks: ContentBlock[] = [];
  const fallbackSections: string[] = [];
  for (const item of files) {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Invalid uploaded file metadata');
    const candidate = item as Partial<UploadedFile>;
    if (typeof candidate.path !== 'string') throw new HttpError(400, 'Invalid uploaded file path');
    const remote = candidate.path.startsWith('http://') || candidate.path.startsWith('https://');
    if (!remote && !withinDirectory(candidate.path, uploadsDirectory)) throw new HttpError(400, 'Invalid uploaded file path');
    const info = remote ? undefined : await stat(candidate.path).catch(() => undefined);
    if (!remote && !info?.isFile()) throw new HttpError(400, 'Uploaded file does not exist');
    const name = sanitizeAttachmentName(candidate);
    const extension = extname(name).toLowerCase();
    let remoteExtension = '';
    if (remote) {
      try { remoteExtension = extname(new URL(candidate.path).pathname).toLowerCase(); } catch {}
    }
    const effectiveExtension = remoteExtension || extension;
    const mimeType = typeof candidate.type === 'string' ? candidate.type : undefined;
    const textFile = isTextFile(name, mimeType, effectiveExtension);
    const attachedText = validateAttachedContent(candidate, textFile);
    if (IMAGE_EXTENSIONS.has(effectiveExtension)) {
      if (remote) {
        blocks.push({ type: 'image_url', image_url: { url: candidate.path } });
        blocks.push({ type: 'text', text: `[用户上传了图片: ${name}]` });
      } else if (info!.size <= MAX_IMAGE_BASE64_BYTES) {
        const buffer = await readFile(candidate.path);
        const base64 = buffer.toString('base64');
        const mime = imageMimeType(effectiveExtension);
        blocks.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
        blocks.push({ type: 'text', text: `[用户上传了图片: ${name}]` });
      } else {
        fallbackSections.push(`![${name}](${resolve(candidate.path)})`);
        blocks.push({ type: 'text', text: `[图片 ${name} 超过大小限制，无法内联]` });
      }
    } else if (textFile) {
      if (attachedText.content !== undefined) {
        blocks.push({ type: 'text', text: `[附件: ${name}]\n${attachedText.content}${attachedText.truncated ? '\n[内容已截断]' : ''}` });
      } else if (remote) {
        fallbackSections.push(`[附件: ${name}] 路径: ${candidate.path} (可通过工具读取)`);
        blocks.push({ type: 'text', text: `[附件: ${name}] 路径: ${candidate.path}` });
      } else {
        const decoded = await readFile(candidate.path, 'utf8');
        const content = decoded.slice(0, ATTACHMENT_TEXT_LIMIT);
        const truncated = decoded.length > ATTACHMENT_TEXT_LIMIT ? '\n[内容已截断]' : '';
        const lang = effectiveExtension.slice(1) || 'text';
        blocks.push({ type: 'text', text: `[文件: ${name}]\n\`\`\`${lang}\n${content}${truncated}\n\`\`\`` });
      }
    } else {
      const path = remote ? candidate.path : resolve(candidate.path);
      fallbackSections.push(`[附件: ${name}] 路径: ${path} (可通过工具读取)`);
      blocks.push({ type: 'text', text: `[附件: ${name}] 路径: ${path}` });
    }
  }
  const fallbackText = fallbackSections.length ? `\n\n${fallbackSections.join('\n\n')}` : '';
  return { blocks, fallbackText };
}
