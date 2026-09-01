import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { getAgentProfile } from '../../agents/profiles.js';
import { resolveWorkspaceDir } from '../../config/config.js';
import type { SessionUsage } from '../sessions.js';
import { HttpError, json, openAiError, openAiSse, readJson } from '../http.js';
import { formatGatewayTurnError, joinedOpenAiMessages, openAiModels } from '../openai-format.js';
import type { EarlyRouteContext } from './route-context.js';

/** Handles GET /v1/models and POST /v1/chat/completions (OpenAI-compatible endpoints). */
export async function handleOpenAiRoutes(ctx: EarlyRouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname, auth } = ctx;
  if (!pathname.startsWith('/v1/')) return false;
  const authenticatedUsername = auth?.username;
  const authenticatedViaApiKey = auth?.viaApiKey === true;
  const accessConfig = ctx.accessConfig;
  if (method === 'GET' && pathname === '/v1/models') {
    json(response, 200, { object: 'list', data: openAiModels(await runtime.modelState.resolveModels()) });
    return true;
  }
  if (method === 'POST' && pathname === '/v1/chat/completions') {
    const body = await readJson(request) as {
      model?: unknown; messages?: unknown; stream?: unknown; mode?: unknown;
      skills?: unknown; skipDangerous?: unknown; directory?: unknown;
    };
    const extensionFields = ['mode', 'skills', 'skipDangerous', 'directory'] as const;
    const hasExtensions = extensionFields.some((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (hasExtensions && !authenticatedViaApiKey) {
      openAiError(response, 403, 'Taiwei extensions require API-key authentication', 'forbidden');
      return true;
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw new HttpError(400, 'model must be a non-empty string');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new HttpError(400, 'stream must be a boolean');
    if (body.mode !== undefined && (typeof body.mode !== 'string' || !body.mode.trim())) throw new HttpError(400, 'mode must be a non-empty string');
    if (body.skills !== undefined && (!Array.isArray(body.skills) || body.skills.some((name) => typeof name !== 'string' || !name.trim()))) {
      throw new HttpError(400, 'skills must be an array of non-empty strings');
    }
    if (body.skipDangerous !== undefined && typeof body.skipDangerous !== 'boolean') throw new HttpError(400, 'skipDangerous must be a boolean');
    if (body.directory !== undefined && (typeof body.directory !== 'string' || !body.directory.trim())) throw new HttpError(400, 'directory must be a non-empty string');
    const input = joinedOpenAiMessages(body.messages);
    const runAgentId = typeof body.mode === 'string' ? body.mode.trim() : 'build';
    try { getAgentProfile(runAgentId); }
    catch (error) { throw new HttpError(400, (error as Error).message); }
    const activeSkillNames = Array.isArray(body.skills) ? body.skills.map((name) => (name as string).trim()) : undefined;
    if (activeSkillNames) {
      const missing: string[] = [];
      for (const name of activeSkillNames) {
        try { await runtime.userSkillStore.load('admin', name); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          try { await runtime.skillLoader.load(name, { includeDisabled: true }); }
          catch { missing.push(name); }
        }
      }
      if (missing.length) throw new HttpError(400, `Unknown skills: ${[...new Set(missing)].join(', ')}`);
    }
    const listedModels = await runtime.modelState.resolveModels();
    const runModel = typeof body.model === 'string' ? body.model.trim() : listedModels.current;
    const providerMatch = listedModels.providers?.find((provider) => provider.models.some((model) => model.id === runModel));
    const known = Boolean(providerMatch) || listedModels.models.includes(runModel);
    if (!known && listedModels.source !== 'fallback') throw new HttpError(400, `Unknown model: ${runModel}`);
    const runProviderId = providerMatch?.id ?? listedModels.currentProvider;
    const defaultWorkspace = resolveWorkspaceDir(accessConfig);
    const workspace = typeof body.directory === 'string'
      ? resolve(isAbsolute(body.directory.trim()) ? body.directory.trim() : resolve(defaultWorkspace, body.directory.trim()))
      : defaultWorkspace;
    await mkdir(workspace, { recursive: true });
    const completionId = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
    const created = Math.floor(Date.now() / 1_000);
    const activeContextWindow = await runtime.contextWindowFor(runModel);
    const streaming = body.stream === true;
    if (streaming) {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.flushHeaders?.();
      openAiSse(response, {
        id: completionId, object: 'chat.completion.chunk', created, model: runModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
    }
    let answer = '';
    let finalText: string | undefined;
    let turnError: Error | undefined;
    let usage: SessionUsage | undefined;
    let streamedText = false;
    const runtimeSessionId = `openai:${authenticatedUsername ?? 'admin'}:${completionId}`;
    await runtime.options.chat.run(input.message, {
      event: (event) => {
        if (event.type === 'token') {
          answer += event.text;
          if (streaming) {
            streamedText = true;
            openAiSse(response, {
              id: completionId, object: 'chat.completion.chunk', created, model: runModel,
              choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
            });
          }
        } else if (event.type === 'usage') {
          usage = {
            promptTokens: event.usage.promptTokens,
            completionTokens: event.usage.completionTokens,
            totalTokens: event.usage.totalTokens,
            contextWindow: event.usage.contextWindow ?? activeContextWindow,
            model: event.model || runModel,
          };
        } else if (event.type === 'done') {
          finalText = event.text;
        }
      },
      error: (error) => { turnError = error; },
      confirm: () => Promise.resolve({ approve: authenticatedViaApiKey && body.skipDangerous === true }),
    }, [], undefined, undefined, runAgentId, 'admin', authenticatedUsername ?? 'admin', runtimeSessionId,
    runProviderId, runModel, workspace, undefined, undefined, undefined, activeSkillNames);
    if (turnError) {
      if (streaming) {
        openAiSse(response, { error: { message: formatGatewayTurnError(turnError), type: 'server_error', code: null } });
        openAiSse(response, '[DONE]');
        response.end();
        return true;
      }
      throw new HttpError(500, formatGatewayTurnError(turnError));
    }
    const text = finalText ?? answer;
    const calculatedUsage = usage ?? {
      promptTokens: Math.ceil(input.promptText.length / 4),
      completionTokens: Math.ceil(text.length / 4),
      totalTokens: Math.ceil(input.promptText.length / 4) + Math.ceil(text.length / 4),
    };
    if (streaming) {
      if (!streamedText && text) {
        openAiSse(response, {
          id: completionId, object: 'chat.completion.chunk', created, model: runModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        });
      }
      openAiSse(response, {
        id: completionId, object: 'chat.completion.chunk', created, model: runModel,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      openAiSse(response, '[DONE]');
      response.end();
      return true;
    }
    json(response, 200, {
      id: completionId, object: 'chat.completion', created, model: runModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: calculatedUsage.promptTokens,
        completion_tokens: calculatedUsage.completionTokens,
        total_tokens: calculatedUsage.totalTokens,
      },
    });
    return true;
  }
  return false;
}
