import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { imageGenTool, videoGenTool } from '../src/tools/impl/media.js';
import { PolicyEngine } from '../src/security/policy.js';

async function withMediaProvider(
  responder: (url: string, method: string, body: Record<string, unknown> | null) => Response,
  run: (requests: Array<{ url: string; method: string; body: Record<string, unknown> | null; authorization: string | null }>) => Promise<void>,
  configOverrides: Record<string, unknown> = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'taiwei-media-test-'));
  const previousHome = process.env.TAIWEI_HOME;
  const previousBaseUrl = process.env.TAIWEI_BASE_URL;
  const previousApiKey = process.env.TAIWEI_API_KEY;
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> | null; authorization: string | null }> = [];
  process.env.TAIWEI_HOME = directory;
  delete process.env.TAIWEI_BASE_URL;
  delete process.env.TAIWEI_API_KEY;
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    baseUrl: 'https://media.example/v1/', apiKey: 'media-secret', model: 'test-model',
    ...configOverrides,
  }));
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const authorization = new Headers(init?.headers).get('authorization');
    requests.push({ url, method, body, authorization });
    return responder(url, method, body);
  }) as typeof fetch;
  try { await run(requests); }
  finally {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.TAIWEI_HOME; else process.env.TAIWEI_HOME = previousHome;
    if (previousBaseUrl === undefined) delete process.env.TAIWEI_BASE_URL; else process.env.TAIWEI_BASE_URL = previousBaseUrl;
    if (previousApiKey === undefined) delete process.env.TAIWEI_API_KEY; else process.env.TAIWEI_API_KEY = previousApiKey;
    await rm(directory, { recursive: true, force: true });
  }
}

test('generate_image calls the image endpoint and returns displayable markdown', async () => withMediaProvider(
  () => Response.json({ data: [{ url: 'https://cdn.example/generated.png' }] }),
  async (requests) => {
    const output = await imageGenTool.execute({ prompt: '一只龙虾', size: '1024x1024' }, { cwd: process.cwd() });
    assert.match(String(output), /!\[生成的图片\]\(https:\/\/cdn\.example\/generated\.png\)/);
    assert.deepEqual(requests[0], {
      url: 'https://media.example/v1/images/generations',
      method: 'POST',
      authorization: 'Bearer media-secret',
      body: { model: 'image-free', prompt: '一只龙虾', n: 1, size: '1024x1024', quality: 'high' },
    });
  },
));

test('generate_image makes sequential calls and returns every generated image', async () => {
  let responseIndex = 0;
  await withMediaProvider(
    () => Response.json({ data: [{ url: `https://cdn.example/generated-${++responseIndex}.png` }] }),
    async (requests) => {
      const output = String(await imageGenTool.execute({ prompt: '三只龙虾', n: 3, quality: 'high' }, { cwd: process.cwd() }));
      assert.equal(requests.length, 3);
      assert.deepEqual(requests.map(({ body }) => body?.n), [1, 1, 1]);
      assert.deepEqual(requests.map(({ body }) => body?.quality), ['high', 'high', 'high']);
      assert.deepEqual(requests.map(({ body }) => body?.prompt), [
        '三只龙虾, variation 1', '三只龙虾, variation 2', '三只龙虾, variation 3',
      ]);
      assert.match(output, /图片生成成功（3 张）/);
      for (let index = 1; index <= 3; index += 1) {
        assert.match(output, new RegExp(`!\\[生成的图片 ${index}\\]\\(https://cdn\\.example/generated-${index}\\.png\\)`));
      }
    },
  );
});

test('generate_image passes a reference image without altering the prompt and omits it otherwise', async () => withMediaProvider(
  () => Response.json({ data: [{ url: 'https://cdn.example/reference-result.png' }] }),
  async (requests) => {
    await imageGenTool.execute({ prompt: '调整色调', n: 2, image: 'https://cdn.example/reference.png' }, { cwd: process.cwd() });
    await imageGenTool.execute({ prompt: '无参考图' }, { cwd: process.cwd() });
    assert.deepEqual(requests.slice(0, 2).map(({ body }) => body?.image), [
      'https://cdn.example/reference.png', 'https://cdn.example/reference.png',
    ]);
    assert.deepEqual(requests.slice(0, 2).map(({ body }) => body?.prompt), ['调整色调', '调整色调']);
    assert.equal(Object.hasOwn(requests[2].body ?? {}, 'image'), false);
  },
));

test('generate_image surfaces the upstream error message with the model style hint on 4xx', async () => withMediaProvider(
  () => Response.json({ error: { message: 'quota exceeded' } }, { status: 429 }),
  async () => {
    const output = await imageGenTool.execute({ prompt: '海报' }, { cwd: process.cwd() });
    assert.match(String(output), /图片生成失败: quota exceeded\n\n该图片模型样式：/);
  },
));

test('admin-only media models deny guests before calling the provider', async () => withMediaProvider(
  () => Response.json({ error: 'provider should not be called' }, { status: 500 }),
  async (requests) => {
    const image = await imageGenTool.execute({ prompt: '私有图片' }, { cwd: process.cwd(), role: 'guest' });
    const video = await videoGenTool.execute({ prompt: '私有视频' }, { cwd: process.cwd(), role: 'guest' });
    assert.equal(image, '图片生成失败: 你没有权限使用该模型，仅管理员可用');
    assert.equal(video, '视频生成失败: 你没有权限使用该模型，仅管理员可用');
    assert.equal(requests.length, 0);
  },
  {
    defaultProvider: 'image-provider',
    providers: [
      {
        id: 'image-provider', name: 'Image', type: 'openai-compatible', modality: 'image',
        baseUrl: 'https://media.example/v1', defaultModel: 'image-free',
        models: [{
          id: 'image-free', provider: 'image-provider', displayName: 'Image Free', adminOnly: true,
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 256000 },
        }],
      },
      {
        id: 'video-provider', name: 'Video', type: 'openai-compatible', modality: 'video',
        baseUrl: 'https://media.example/v1', defaultModel: 'video-free',
        models: [{
          id: 'video-free', provider: 'video-provider', displayName: 'Video Free', adminOnly: true,
          capabilities: { tools: true, vision: false, reasoning: false, streaming: true, contextWindow: 256000 },
        }],
      },
    ],
  },
));

test('generate_video clamps duration to 1..15 and sends the requested size', async () => withMediaProvider(
  (_url, method) => method === 'POST'
    ? Response.json({ id: 'video_clamp' })
    : Response.json({ internal_status: 'completed', url: 'https://cdn.example/video/result.mp4' }),
  async (requests) => {
    for (const duration of [undefined, 100, 0, -8, 8]) {
      const output = await videoGenTool.execute({ prompt: '海浪', ...(duration === undefined ? {} : { duration }), size: '1080p' }, { cwd: process.cwd() });
      assert.match(String(output), /\[▶️ 查看视频\]\(https:\/\/cdn\.example\/video\/result\.mp4\)/);
    }
    const creates = requests.filter(({ method }) => method === 'POST');
    assert.deepEqual(creates.map(({ body }) => body?.duration), [10, 15, 1, 1, 8]);
    assert.ok(creates.every(({ url }) => url === 'https://media.example/v1/videos'));
    assert.ok(creates.every(({ body }) => body?.model === 'video-free' && body.size === '1080p'));
  },
));

test('generate_video maps quality to size, lets size win, and conditionally sends a reference image', async () => withMediaProvider(
  (_url, method) => method === 'POST'
    ? Response.json({ video_id: 'video_quality' })
    : Response.json({ internal_status: 'completed', url: 'https://cdn.example/video/result.mp4' }),
  async (requests) => {
    await videoGenTool.execute({ prompt: '低清', quality: 'low', image: 'https://cdn.example/first-frame.png' }, { cwd: process.cwd() });
    await videoGenTool.execute({ prompt: '高清', quality: 'high' }, { cwd: process.cwd() });
    await videoGenTool.execute({ prompt: '显式尺寸', quality: 'low', size: '4k' }, { cwd: process.cwd() });
    const creates = requests.filter(({ method }) => method === 'POST');
    assert.deepEqual(creates.map(({ body }) => body?.size), ['480p', '1080p', '4k']);
    assert.equal(creates[0].body?.image, 'https://cdn.example/first-frame.png');
    assert.equal(Object.hasOwn(creates[1].body ?? {}, 'image'), false);
    assert.equal(Object.hasOwn(creates[2].body ?? {}, 'image'), false);
  },
));

test('generate_video creates an async task, polls it, and returns the completed mp4', async () => {
  let polls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => originalSetTimeout(callback, 0)) as typeof setTimeout;
  try {
    await withMediaProvider(
      (_url, method) => {
        if (method === 'POST') return Response.json({ id: 'video_abc', task_id: 'task_x' });
        polls += 1;
        return polls === 1
          ? Response.json({ internal_status: 'inference', internal_progress: 30 })
          : Response.json({ internal_status: 'completed', url: 'https://example.com/out.mp4' });
      },
      async (requests) => {
        const output = String(await videoGenTool.execute({ prompt: '海浪' }, { cwd: process.cwd() }));
        assert.match(output, /out\.mp4/);
        assert.equal(requests[0].method, 'POST');
        assert.equal(requests[0].url, 'https://media.example/v1/videos');
        assert.equal(requests.some(({ url }) => url.endsWith('/videos/generations')), false);
        assert.deepEqual(requests.slice(1).map(({ method, url }) => ({ method, url })), [
          { method: 'GET', url: 'https://media.example/v1/videos/video_abc' },
          { method: 'GET', url: 'https://media.example/v1/videos/video_abc' },
        ]);
      },
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('generate_video reports an async task failure', async () => withMediaProvider(
  (_url, method) => method === 'POST'
    ? Response.json({ id: 'video_failed' })
    : Response.json({ internal_status: 'failed', error: 'boom' }),
  async () => {
    const output = String(await videoGenTool.execute({ prompt: '失败视频' }, { cwd: process.cwd() }));
    assert.match(output, /视频生成失败:.*boom/);
  },
));

test('generate_video surfaces the model style hint on a 4xx create failure', async () => withMediaProvider(
  () => Response.json({ error: { message: 'invalid size' } }, { status: 400 }),
  async () => {
    const output = await videoGenTool.execute({ prompt: '海浪' }, { cwd: process.cwd() });
    assert.match(String(output), /视频生成失败: invalid size\n\n该视频模型样式：/);
  },
));

test('guest policy allows image and video generation', () => {
  const policy = new PolicyEngine();
  const input = { role: 'guest' as const, agentMode: 'build' as const, sessionId: 'guest', args: {}, cwd: '/tmp/workspace', workspaceRoot: '/tmp/workspace', identity: 'guest' };
  assert.equal(policy.decide({ ...input, tool: 'generate_image' }).effect, 'allow');
  assert.equal(policy.decide({ ...input, tool: 'generate_video' }).effect, 'allow');
});
