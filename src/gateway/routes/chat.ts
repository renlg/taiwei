import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { getAgentProfile } from '../../agents/profiles.js';
import { resolveWorkspaceDir } from '../../config/config.js';
import type { ChatMessage, ContentBlock } from '../../llm/client.js';
import { HttpError, json, readJson } from '../http.js';
import { openSse, sendSse } from '../sse.js';
import { attachmentContext, attachmentGenerationInstructions, buildMultimodalContent } from '../attachments.js';
import { contentWithTurnError, formatGatewayTurnError, providerFailureStatus } from '../openai-format.js';
import { firstAllowedModel, grantedModelsFor, modelAllowedForRole, modelForSelection } from '../models-policy.js';
import { sanitizeContextMessages, type SessionAttachment, type SessionMessage, type SessionToolCall } from '../sessions.js';
import type { PendingTurn } from '../runtime.js';
import type { RouteContext } from './route-context.js';

/** Handles POST /api/chat — the streaming agent turn. */
export async function handleChatRoute(ctx: RouteContext): Promise<boolean> {
  const { runtime, request, response, method, pathname } = ctx;
  const { options, configState, modelState, contextWindowFor, uploadsDirectory, historyIndex, log } = runtime;
  const { pendingTurns, stopRequested, modelFailureCounts, sessionIdentity, skillLoader, userSkillStore } = runtime;
  const { activeSessions, activeFolders, requestIdentityUsername, turnMemory } = ctx.scope;
  const { role: authenticatedRole, username: authenticatedUsername, token: authenticatedToken, viaApiKey: authenticatedViaApiKey, guestId } = ctx.scope.auth;
  if (method !== 'POST' || pathname !== '/api/chat') return false;

  const body = await readJson(request) as {
    message?: unknown; sessionId?: unknown; files?: unknown; provider?: unknown;
    model?: unknown; mode?: unknown; skills?: unknown; skipDangerous?: unknown; directory?: unknown;
  };
  const extendedFields = ['provider', 'model', 'mode', 'skills', 'skipDangerous', 'directory'] as const;
  const hasExtendedParameters = extendedFields.some((field) => Object.prototype.hasOwnProperty.call(body, field));
  // skills（技能注入）允许 admin 登录会话使用（UI 技能选择）；其余扩展覆盖仍仅限 API-key
  const isAdminSession = authenticatedRole === 'admin' && Boolean(authenticatedToken);
  const hasOnlySkillsOverride = Object.keys(body).every((key) => key === 'message' || key === 'sessionId' || key === 'files' || key === 'skills');
  if (hasExtendedParameters && !authenticatedViaApiKey && !(isAdminSession && hasOnlySkillsOverride)) {
    json(response, 403, { error: 'Gateway chat overrides require X-API-Key authentication' });
    return true;
  }
  if (typeof body?.message !== 'string' || !body.message.trim()) {
    json(response, 400, { error: 'message must be a non-empty string' });
    return true;
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    json(response, 400, { error: 'sessionId must be a string' });
    return true;
  }
  if (body.provider !== undefined && (typeof body.provider !== 'string' || !body.provider.trim())) {
    throw new HttpError(400, 'provider must be a non-empty string');
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) {
    throw new HttpError(400, 'model must be a non-empty string');
  }
  if (body.mode !== undefined && (typeof body.mode !== 'string' || !body.mode.trim())) {
    throw new HttpError(400, 'mode must be a non-empty string');
  }
  if (body.skills !== undefined && (!Array.isArray(body.skills) || body.skills.some((name) => typeof name !== 'string' || !name.trim()))) {
    throw new HttpError(400, 'skills must be an array of non-empty strings');
  }
  if (body.skipDangerous !== undefined && typeof body.skipDangerous !== 'boolean') {
    throw new HttpError(400, 'skipDangerous must be a boolean');
  }
  if (body.directory !== undefined && (typeof body.directory !== 'string' || !body.directory.trim())) {
    throw new HttpError(400, 'directory must be a non-empty string');
  }
  const session = typeof body.sessionId === 'string'
    ? await activeSessions.get(body.sessionId)
    : await activeSessions.create(
        'build', (await activeFolders.defaultFolder()).id, undefined, undefined,
        await sessionIdentity(authenticatedRole, requestIdentityUsername),
      );
  if (!session) {
    json(response, 404, { error: 'Session not found' });
    return true;
  }
  if (session.identity
    && (session.identity.role !== authenticatedRole || session.identity.username !== requestIdentityUsername)) {
    json(response, 403, { error: 'forbidden' });
    return true;
  }
  const chatRole = session.identity?.role ?? authenticatedRole;
  const chatIdentity = authenticatedViaApiKey
    ? authenticatedUsername!
    : session.identity?.username ?? authenticatedUsername ?? authenticatedRole;
  const runAgentId = typeof body.mode === 'string' ? body.mode.trim() : session.agentId ?? 'build';
  try { getAgentProfile(runAgentId); }
  catch (error) { throw new HttpError(400, (error as Error).message); }
  const activeSkillNames = Array.isArray(body.skills) ? body.skills.map((name) => (name as string).trim()) : undefined;
  if (activeSkillNames) {
    const missing: string[] = [];
    const skillOwner = chatRole === 'guest' ? guestId : 'admin';
    if (!skillOwner) throw new HttpError(403, 'Guest skill owner is unavailable');
    for (const name of activeSkillNames) {
      try { await userSkillStore.load(skillOwner, name); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (chatRole === 'guest') {
          missing.push(name);
          continue;
        }
        try { await skillLoader.load(name, { includeDisabled: true }); }
        catch { missing.push(name); }
      }
    }
    if (missing.length) throw new HttpError(400, `Unknown skills: ${[...new Set(missing)].join(', ')}`);
  }
  const config = await configState.load();
  const grantedModels = grantedModelsFor(config, chatIdentity);
  const listedModels = await modelState.resolveModels();
  let runProviderId = typeof body.provider === 'string' ? body.provider.trim() : session.providerId ?? listedModels.currentProvider;
  let runModel = typeof body.model === 'string'
    ? body.model.trim()
    : session.currentModel ?? await modelState.getCurrentModel();
  const selectedProvider = listedModels.providers?.find((item) => item.id === runProviderId);
  const selectedModel = modelForSelection(listedModels, runProviderId, runModel);
  const known = selectedProvider ? Boolean(selectedModel) : listedModels.models.includes(runModel);
  if (!known && listedModels.source !== 'fallback') {
    json(response, 400, { error: `Unknown model: ${runModel}`, models: listedModels.models });
    return true;
  }
  if (!modelAllowedForRole(chatRole, selectedProvider, runModel, grantedModels)) {
    if (body.model !== undefined || body.provider !== undefined) {
      throw new HttpError(403, `${chatRole === 'guest' ? 'Guest' : 'This account'} cannot select this model`);
    }
    const fallback = firstAllowedModel(listedModels, chatRole, grantedModels);
    if (!fallback) throw new HttpError(403, '当前账号没有可用模型');
    runModel = fallback.model;
    runProviderId = fallback.provider;
    session.currentModel = runModel;
    session.providerId = runProviderId;
    session.updatedAt = new Date().toISOString();
    await activeSessions.save(session);
  }
  const message = body.message.trim();
  const sessionFolder = session.folderId ? await activeFolders.get(session.folderId) : undefined;
  if (session.folderId && !sessionFolder) throw new HttpError(404, 'Session folder not found');
  // Guest 的工作目录固定为租户根（/home/<guestN>/projects），UI 文件夹只做会话分类，不改变写权限边界；
  // admin 的工作目录跟随会话所在文件夹。
  const defaultWorkspace = resolveWorkspaceDir(config);
  const workspace = typeof body.directory === 'string'
    ? resolve(isAbsolute(body.directory.trim()) ? body.directory.trim() : resolve(defaultWorkspace, body.directory.trim()))
    : guestId
      ? (await activeFolders.defaultFolder()).path
      : sessionFolder?.path ?? defaultWorkspace;
  await mkdir(workspace, { recursive: true });
  if (options.hooks) {
    options.hooks.configure(config.hooks, config.hookTimeoutSeconds, workspace);
    const gate = await options.hooks.run('beforeMessage', { sessionId: session.id, message });
    if (gate.block) {
      json(response, 403, { error: gate.reason ?? 'Message blocked by hook', blockedByHook: true });
      return true;
    }
  }
  const agentMessageBase = `${message}${await attachmentContext(body.files, uploadsDirectory)}`;
  const messageAttachments: SessionAttachment[] | undefined = Array.isArray(body.files) && body.files.length
    ? body.files.map((file: { name?: string; path?: string; url?: string; type?: string }) => ({
      name: file.name ?? file.path?.split('/').pop() ?? 'attachment',
      url: file.url ?? file.path ?? '',
      ...(file.type ? { type: file.type } : {}),
    }))
    : undefined;
  const history = activeSessions.toChatHistory(session);
  const activeModel = runModel;
  const activeContextWindow = await contextWindowFor(activeModel);
  const activeProviderId = runProviderId;
  let visionEnabled = false;
  try {
    const providers = config.providers ?? [];
    const provider = activeProviderId ? providers.find((p) => p.id === activeProviderId) : providers[0];
    if (provider) {
      const modelDef = (provider.models ?? []).find((m) => m.id === activeModel);
      visionEnabled = modelDef?.capabilities?.vision === true;
    }
  } catch {}
  const multimodalEnabled = visionEnabled && config.gateway.multimodal?.enabled !== false;
  let agentMessage = agentMessageBase;
  let userContent: ContentBlock[] | undefined;
  if (multimodalEnabled && Array.isArray(body.files) && body.files.length > 0) {
    const multimodal = await buildMultimodalContent(body.files, uploadsDirectory);
    if (multimodal.blocks.length > 0) {
      const genInstructions = attachmentGenerationInstructions(body.files);
      const textWithInstructions = genInstructions ? `${message}\n${genInstructions}` : message;
      userContent = [...multimodal.blocks, { type: 'text', text: textWithInstructions }];
      agentMessage = `${agentMessageBase}${genInstructions}`;
    }
  }
  if (!session.messages.some((item) => item.role === 'user')) session.title = activeSessions.titleFrom(message) || session.title;
  session.messages.push({ role: 'user', content: message, ...(agentMessage !== message ? { agentContent: agentMessage } : {}), ...(messageAttachments ? { attachments: messageAttachments } : {}), timestamp: new Date().toISOString() });
  openSse(response);
  let completed = false;
  let answer = '';
  let finalText: string | undefined;
  let turnError: Error | undefined;
  let contextMessages: ChatMessage[] | undefined;
  const toolCalls: SessionToolCall[] = [];
  const runtimeSessionId = `${guestId ?? authenticatedUsername ?? authenticatedRole}:${session.id}`;
  const turnId = randomUUID();
  let pendingSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingFinalization: Promise<void> | undefined;
  let routeFinalized = false;
  let routePendingMessage: SessionMessage | undefined;
  let routePendingTurn: PendingTurn | undefined;
  const failureKey = `${runtimeSessionId}:${activeProviderId ?? 'default'}:${activeModel}`;
  const finalizeRoute = async (status: 'success' | 'stopped' | 'error', error?: unknown, stoppedMessage?: string) => {
    if (routeFinalized) return;
    routeFinalized = true;
    if (pendingSaveTimer) { clearTimeout(pendingSaveTimer); pendingSaveTimer = undefined; }
    if (pendingDeadlineTimer) { clearTimeout(pendingDeadlineTimer); pendingDeadlineTimer = undefined; }
    pendingTurns.delete(runtimeSessionId);
    stopRequested.delete(runtimeSessionId);
    const currentPending = routePendingMessage && session.messages.includes(routePendingMessage)
      ? routePendingMessage
      : undefined;
    const partial = finalText ?? routePendingTurn?.answer ?? answer ?? currentPending?.content ?? '';
    let healthHint = '';
    if (status === 'error') {
      const failureStatus = providerFailureStatus(error);
      if (failureStatus === 400 || (failureStatus !== undefined && failureStatus >= 500)) {
        const failures = (modelFailureCounts.get(failureKey) ?? 0) + 1;
        modelFailureCounts.set(failureKey, failures);
        if (failures >= 3) healthHint = `当前模型已连续出错 ${failures} 次，建议在右上角切换到其他可用模型（例如 good 模型）。`;
      }
    } else if (status === 'success') {
      modelFailureCounts.delete(failureKey);
    }
    if (currentPending && status === 'error') {
      currentPending.content = contentWithTurnError(partial, formatGatewayTurnError(error));
      if (healthHint) currentPending.content += `\n\n${healthHint}`;
      currentPending.toolCalls = routePendingTurn?.toolCalls.length ? [...routePendingTurn.toolCalls] : currentPending.toolCalls;
      currentPending.status = 'error';
    } else if (currentPending && status === 'stopped') {
      currentPending.content = stoppedMessage
        ? (partial ? `${partial}\n\n[中断] ${stoppedMessage}` : stoppedMessage)
        : partial || '运行已中断。';
      currentPending.toolCalls = routePendingTurn?.toolCalls.length ? [...routePendingTurn.toolCalls] : currentPending.toolCalls;
      currentPending.status = 'stopped';
    } else if (currentPending && (partial || toolCalls.length || finalText !== undefined)) {
      currentPending.content = partial;
      currentPending.toolCalls = toolCalls.length ? [...toolCalls] : undefined;
      currentPending.status = undefined;
    } else if (currentPending) {
      const idx = session.messages.indexOf(currentPending);
      if (idx >= 0) session.messages.splice(idx, 1);
    } else if (status === 'error') {
      session.messages.push({
        role: 'assistant', content: `${contentWithTurnError('', formatGatewayTurnError(error))}${healthHint ? `\n\n${healthHint}` : ''}`,
        timestamp: new Date().toISOString(), status: 'error',
      });
    }
    session.updatedAt = new Date().toISOString();
    try { await activeSessions.save(session); }
    catch (saveError) { routeFinalized = false; throw saveError; }
  };
  ctx.sseErrorPersistence.handler = async (error) => {
    if (pendingFinalization) await pendingFinalization;
    else await finalizeRoute('error', error);
  };
  const pendingMessage: SessionMessage = {
    role: 'assistant', content: '', timestamp: new Date().toISOString(), status: 'pending',
  };
  routePendingMessage = pendingMessage;
  session.messages.push(pendingMessage);
  session.updatedAt = new Date().toISOString();
  await activeSessions.save(session);
  const pendingTurn: PendingTurn = {
    turnId, sessionId: session.id, runtimeSessionId,
    startedAt: new Date().toISOString(), answer: '', toolCalls: [], lastSavedAt: Date.now(),
  };
  routePendingTurn = pendingTurn;
  // 本回合开始前遗留的停止意图不应作用于新回合（避免陈旧 stopRequested 条目
  // 在 SSE 断开时误停正常运行的新 turn）。
  stopRequested.delete(runtimeSessionId);
  pendingTurns.set(runtimeSessionId, pendingTurn);
  pendingDeadlineTimer = setTimeout(() => {
    if (routeFinalized) return;
    pendingFinalization = finalizeRoute('stopped', undefined, '运行超时，已自动中断。');
    options.chat.stop(runtimeSessionId);
    void pendingFinalization.catch((error) => {
      log(`[taiwei] failed to finalize timed out turn ${turnId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, options.pendingTurnTimeoutMs ?? 15 * 60_000);
  pendingDeadlineTimer.unref?.();
  const throttledSave = () => {
    if (pendingSaveTimer || routeFinalized) return;
    pendingSaveTimer = setTimeout(async () => {
      pendingSaveTimer = undefined;
      if (routeFinalized) return;
      pendingTurn.lastSavedAt = Date.now();
      pendingMessage.content = pendingTurn.answer;
      pendingMessage.toolCalls = pendingTurn.toolCalls.length ? [...pendingTurn.toolCalls] : undefined;
      session.updatedAt = new Date().toISOString();
      try { await activeSessions.save(session); } catch {}
    }, 1000);
  };
  response.once('close', () => {
    if (!completed && !stopRequested.has(runtimeSessionId)) {
      log(`[taiwei] SSE disconnected for ${session.id} (turn ${turnId}), continuing in background`);
    } else if (!completed) {
      options.chat.stop(runtimeSessionId);
    }
  });
  await options.chat.run(agentMessage, {
    event: (event) => {
      if (event.type === 'token') {
        answer += event.text;
        pendingTurn.answer = answer;
        sendSse(response, 'token', { text: event.text });
        throttledSave();
      } else if (event.type === 'tool') {
        toolCalls.push({ name: event.name, args: event.args });
        pendingTurn.toolCalls = [...toolCalls];
        sendSse(response, 'tool', { name: event.name, args: event.args });
        throttledSave();
      } else if (event.type === 'tool_result') {
        const call = [...toolCalls].reverse().find((item) => item.name === event.name && item.result === undefined);
        if (call) call.result = event.result;
        pendingTurn.toolCalls = [...toolCalls];
        sendSse(response, 'tool_result', { name: event.name, result: event.result });
        throttledSave();
      } else if (event.type === 'model_iterate') {
        sendSse(response, 'model_iterate', event);
      } else if (event.type === 'compressing') {
        sendSse(response, 'compressing', {});
      } else if (event.type === 'usage') {
        session.usage = {
          promptTokens: event.usage.promptTokens,
          completionTokens: event.usage.completionTokens,
          totalTokens: event.usage.totalTokens,
          contextWindow: event.usage.contextWindow ?? activeContextWindow,
          model: event.model || activeModel,
          compressed: event.compressed === true,
        };
        pendingTurn.usage = session.usage;
        sendSse(response, 'usage', session.usage);
      } else {
        finalText = event.text;
        sendSse(response, 'done', { text: event.text, sessionId: session.id });
      }
    },
    error: (error) => { turnError = error; sendSse(response, 'error', { message: formatGatewayTurnError(error) }); },
    context: (messages) => { contextMessages = messages; },
    confirm: (request) => {
      if (authenticatedViaApiKey) return Promise.resolve({ approve: body.skipDangerous === true });
      sendSse(response, 'confirm', request);
      return runtime.confirmations.wait(request);
    },
  }, history, session.id, turnMemory, runAgentId, chatRole, chatIdentity, runtimeSessionId, runProviderId, runModel, workspace, userContent,
  session.identity ? {
    osUsername: session.identity.osUsername,
    giteaUsername: session.identity.giteaUsername,
    giteaOrgName: session.identity.giteaOrgName,
  } : undefined, guestId, activeSkillNames, grantedModels);
  if (contextMessages) session.contextMessages = sanitizeContextMessages(contextMessages);
  const stopped = turnError?.message === 'Turn cancelled';
  if (pendingFinalization) await pendingFinalization;
  else await finalizeRoute(turnError ? (stopped ? 'stopped' : 'error') : 'success', turnError);
  ctx.sseErrorPersistence.handler = undefined;
  if (historyIndex && !guestId) {
    try {
      await historyIndex.upsertSession({
        id: session.id, title: session.title, source: 'gateway', model: session.usage?.model,
        createdAt: session.createdAt, updatedAt: session.updatedAt,
      });
      for (const storedMessage of session.messages) {
        await historyIndex.appendMessage({
          sessionId: session.id, role: storedMessage.role, content: storedMessage.content,
          timestamp: storedMessage.timestamp,
        });
        for (const tool of storedMessage.toolCalls ?? []) {
          await historyIndex.appendMessage({
            sessionId: session.id, role: 'tool', content: tool.result ?? '', toolName: tool.name,
            timestamp: storedMessage.timestamp,
          });
        }
      }
    } catch (error) {
      log(`[taiwei] history index update skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  completed = true;
  response.end();
  return true;
}
