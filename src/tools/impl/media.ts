import { loadConfig, type TaiweiConfig } from '../../config/config.js';
import type { ToolSpec, ToolContext } from '../registry.js';

interface MediaItem {
  url?: unknown;
  video_url?: unknown;
  b64_json?: unknown;
}

interface MediaResponse {
  data?: MediaItem[];
  error?: { message?: unknown } | string;
  message?: unknown;
}

function errorMessage(body: MediaResponse, status: number): string {
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string' && body.error.message.trim()) return body.error.message;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  return `上游服务返回 HTTP ${status}`;
}

async function postMedia(path: string, payload: Record<string, unknown>, context: ToolContext): Promise<MediaResponse> {
  const config = await loadConfig();
  const timeout = AbortSignal.timeout(60_000);
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal,
  });
  const raw = await response.text();
  let body: MediaResponse;
  try { body = raw ? JSON.parse(raw) as MediaResponse : {}; }
  catch { body = { message: raw }; }
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body;
}

function argumentString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function imageCount(value: unknown): number {
  const count = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.min(4, Math.max(1, count));
}

export function findModelAdminOnly(config: TaiweiConfig, providerId: string | undefined, modelId: string): boolean {
  const preferred = providerId ? config.providers.find((provider) => provider.id === providerId) : undefined;
  const preferredModel = preferred?.models?.find((model) => model.id === modelId);
  if (preferredModel) return preferredModel.adminOnly === true;
  return config.providers.some((provider) => provider.models?.some((model) => model.id === modelId && model.adminOnly === true));
}

function mediaProviderId(config: TaiweiConfig, modality: 'image' | 'video', modelId: string): string | undefined {
  return config.providers.find((provider) => provider.modality === modality
    && provider.models?.some((model) => model.id === modelId))?.id;
}

function imageMarkdown(item: MediaItem | undefined, index?: number): string | null {
  const label = index === undefined ? '生成的图片' : `生成的图片 ${index}`;
  if (typeof item?.url === 'string' && item.url.trim()) return `![${label}](${item.url})`;
  if (typeof item?.b64_json === 'string' && item.b64_json.trim()) return `![${label}](data:image/png;base64,${item.b64_json})`;
  return null;
}

const IMAGE_URL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);

function validateReferenceImage(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '参考图 URL 必须是 http/https 协议';
    const ext = (parsed.pathname.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
    if (ext && IMAGE_URL_EXTENSIONS.has(ext)) return null;
    return `参考图 URL 不是图片类型（${url}）。只有图片文件（png/jpg/jpeg/webp/gif/bmp）才能用作参考图`;
  } catch {
    return `参考图 URL 无效（${url}）`;
  }
}

export const imageGenTool: ToolSpec = {
  name: 'generate_image',
  description: '生成图片。当用户要求画图/生成图片/设计图/示意图/海报/头像/logo等视觉内容时调用。生成结果会自动在聊天中显示。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要生成的图片内容描述。' },
      model: { type: 'string', enum: ['image-free'], default: 'image-free' },
      size: { type: 'string', default: '1024x1024' },
      n: { type: 'integer', description: '生成图片数量（最多 4 张），多张会依次生成。', default: 1, minimum: 1, maximum: 4 },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: '图片质量：low 较快、medium 均衡、high 更清晰。', default: 'high' },
      image: { type: 'string', description: '参考图 URL（可选）；上游暂不保证支持参考图。' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const prompt = argumentString(args.prompt, '');
    if (!prompt) return '图片生成失败: prompt 不能为空';
    try {
      const model = argumentString(args.model, 'image-free');
      const config = await loadConfig();
      if (context.role !== 'admin' && findModelAdminOnly(config, mediaProviderId(config, 'image', model), model)) {
        return '图片生成失败: 你没有权限使用该模型，仅管理员可用';
      }
      const count = imageCount(args.n);
      const quality = argumentString(args.quality, 'high');
      const referenceImage = argumentString(args.image, '');
      const imageError = validateReferenceImage(referenceImage);
      if (imageError) return `图片生成失败: ${imageError}`;
      const images: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const requestPrompt = count > 1 && !referenceImage ? `${prompt}, variation ${index + 1}` : prompt;
        const payload: Record<string, unknown> = {
          model,
          prompt: requestPrompt,
          n: 1,
          size: argumentString(args.size, '1024x1024'),
          quality,
          ...(referenceImage ? { image: referenceImage } : {}),
        };
        const body = await postMedia('/images/generations', payload, context);
        const markdown = imageMarkdown(body.data?.[0], count > 1 ? index + 1 : undefined);
        if (!markdown) return '图片生成失败: 上游响应中没有图片 URL 或 b64_json';
        images.push(markdown);
      }
      return count > 1
        ? `图片生成成功（${count} 张）：\n${images.join('\n')}`
        : `图片生成成功：\n${images[0]}`;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return `图片生成失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

function clampDuration(value: unknown): number {
  const duration = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 5;
  return Math.min(15, Math.max(1, duration));
}

type VideoTaskResponse = MediaResponse & Record<string, unknown>;

const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 180_000;

async function getMedia(path: string, context: ToolContext, timeoutMs = 60_000): Promise<VideoTaskResponse> {
  const config = await loadConfig();
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(60_000, timeoutMs)));
  const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'GET',
    headers: {
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    signal,
  });
  const raw = await response.text();
  let body: VideoTaskResponse;
  try { body = raw ? JSON.parse(raw) as VideoTaskResponse : {}; }
  catch { body = { message: raw }; }
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body;
}

function compactJson(value: unknown, maxLength = 500): string {
  let text: string;
  try { text = JSON.stringify(value); }
  catch { text = String(value); }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function taskIdFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  const videoId = candidate.match(/video_[A-Za-z0-9_-]+/)?.[0];
  if (videoId) return videoId;
  const pathId = candidate.match(/\/videos\/([^/?#]+)/)?.[1];
  if (pathId) return pathId;
  if (/^[A-Za-z0-9._-]+$/.test(candidate)) return candidate;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    return taskIdFrom(parsed.video_id) ?? taskIdFrom(parsed.id) ?? taskIdFrom(parsed.task_id);
  } catch {
    return null;
  }
}

function findMp4Url(value: unknown, seen = new Set<object>()): string | null {
  if (typeof value === 'string') {
    const candidate = value.trim();
    return /^https?:\/\/.*\.mp4$/i.test(candidate) ? candidate : null;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMp4Url(item, seen);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findMp4Url(item, seen);
    if (found) return found;
  }
  return null;
}

function videoTaskError(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return compactJson(value);
}

function waitForVideoPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, VIDEO_POLL_INTERVAL_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const videoGenTool: ToolSpec = {
  name: 'generate_video',
  description: '生成视频。当用户要求生成/制作视频时调用。时长限制 1-15 秒，超过 15 秒会自动截断为 15 秒。生成结果会自动在聊天中显示。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要生成的视频内容描述。' },
      model: { type: 'string', enum: ['video-free'], default: 'video-free' },
      duration: { type: 'number', description: '视频时长（秒），会限制在 1 到 15 秒。', default: 10, minimum: 1, maximum: 15 },
      size: { type: 'string', description: '480p、720p、1080p、4k 或 WxH。', default: '720p' },
      quality: { type: 'string', enum: ['low', 'medium', 'high'], description: '视频质量别名：low→480p、medium→720p、high→1080p；同时提供 size 时以 size 为准。', default: 'medium' },
      image: { type: 'string', description: '参考图/首帧图片 URL（可选）；上游支持可能有限。' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const prompt = argumentString(args.prompt, '');
    if (!prompt) return '视频生成失败: prompt 不能为空';
    try {
      const model = argumentString(args.model, 'video-free');
      const config = await loadConfig();
      if (context.role !== 'admin' && findModelAdminOnly(config, mediaProviderId(config, 'video', model), model)) {
        return '视频生成失败: 你没有权限使用该模型，仅管理员可用';
      }
      const qualitySizes: Record<string, string> = { low: '480p', medium: '720p', high: '1080p' };
      const requestedSize = argumentString(args.size, '');
      const quality = argumentString(args.quality, 'medium');
      const referenceImage = argumentString(args.image, '');
      const imageError = validateReferenceImage(referenceImage);
      if (imageError) return `视频生成失败: ${imageError}`;
      const body = await postMedia('/videos', {
        model,
        prompt,
        duration: clampDuration(args.duration === undefined ? 10 : args.duration),
        size: requestedSize || qualitySizes[quality] || '720p',
        ...(referenceImage ? { image: referenceImage } : {}),
      }, context);
      const task = body as VideoTaskResponse;
      const videoId = taskIdFrom(task.video_id) ?? taskIdFrom(task.id) ?? taskIdFrom(task.task_id);
      if (!videoId) return `视频生成失败: 创建响应中没有可用的视频任务 ID: ${compactJson(body)}`;

      const deadline = Date.now() + VIDEO_POLL_TIMEOUT_MS;
      let lastStatus = 'unknown';
      let lastError: unknown = null;
      while (Date.now() < deadline) {
        const poll = await getMedia(`/videos/${encodeURIComponent(videoId)}`, context, deadline - Date.now());
        lastStatus = typeof poll.internal_status === 'string' ? poll.internal_status : 'unknown';
        lastError = poll.error;
        if (poll.error != null || ['failed', 'error'].includes(lastStatus.toLowerCase())) {
          return `视频生成失败: ${poll.error != null ? videoTaskError(poll.error) : lastStatus}`;
        }
        if (lastStatus.toLowerCase() === 'completed') {
          const url = findMp4Url(poll);
          if (url) return `视频生成成功：\n[▶️ 查看视频](${url})\n${url}`;
          return `视频生成失败: 任务已完成但响应中没有 mp4 URL: ${compactJson(poll)}`;
        }
        await waitForVideoPoll(context.signal);
      }
      return `视频生成失败: 等待视频生成超时（internal_status=${lastStatus}, error=${compactJson(lastError)}）`;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return `视频生成失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
