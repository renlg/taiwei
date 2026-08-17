import { loadConfig } from '../../config/config.js';
import type { ToolSpec, ToolContext } from '../registry.js';

interface MediaResponse {
  data?: Array<{ url?: unknown; video_url?: unknown; b64_json?: unknown }>;
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

export const imageGenTool: ToolSpec = {
  name: 'generate_image',
  description: '生成图片。当用户要求画图/生成图片/设计图/示意图/海报/头像/logo等视觉内容时调用。生成结果会自动在聊天中显示。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要生成的图片内容描述。' },
      model: { type: 'string', enum: ['agnes-image-2.1-flash', 'image-free'], default: 'agnes-image-2.1-flash' },
      size: { type: 'string', default: '1024x1024' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const prompt = argumentString(args.prompt, '');
    if (!prompt) return '图片生成失败: prompt 不能为空';
    try {
      const body = await postMedia('/images/generations', {
        model: argumentString(args.model, 'agnes-image-2.1-flash'),
        prompt,
        n: 1,
        size: argumentString(args.size, '1024x1024'),
      }, context);
      const item = body.data?.[0];
      if (typeof item?.url === 'string' && item.url.trim()) return `图片生成成功：\n![生成的图片](${item.url})`;
      if (typeof item?.b64_json === 'string' && item.b64_json.trim()) return `图片生成成功：\n![生成的图片](data:image/png;base64,${item.b64_json})`;
      return '图片生成失败: 上游响应中没有图片 URL 或 b64_json';
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

export const videoGenTool: ToolSpec = {
  name: 'generate_video',
  description: '生成视频。当用户要求生成/制作视频时调用。时长限制 1-15 秒，超过 15 秒会自动截断为 15 秒。生成结果会自动在聊天中显示。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要生成的视频内容描述。' },
      model: { type: 'string', enum: ['agnes-video-v2.0', 'free-video'], default: 'agnes-video-v2.0' },
      duration: { type: 'number', description: '视频时长（秒），会限制在 1 到 15 秒。', default: 5, minimum: 1, maximum: 15 },
      size: { type: 'string', description: '480p、720p、1080p、4k 或 WxH。', default: '720p' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  async execute(args, context) {
    const prompt = argumentString(args.prompt, '');
    if (!prompt) return '视频生成失败: prompt 不能为空';
    try {
      const body = await postMedia('/videos/generations', {
        model: argumentString(args.model, 'agnes-video-v2.0'),
        prompt,
        duration: clampDuration(args.duration),
        size: argumentString(args.size, '720p'),
      }, context);
      const item = body.data?.[0];
      const url = typeof item?.url === 'string' ? item.url : item?.video_url;
      if (typeof url === 'string' && url.trim()) return `视频生成成功：\n[▶️ 查看视频](${url})\n${url}`;
      return '视频生成失败: 上游响应中没有视频 URL';
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return `视频生成失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};
