const $ = (selector) => document.querySelector(selector);
const elements = {
  body: document.body,
  loginScreen: $('#login-screen'),
  loginForm: $('#login-form'),
  loginUsername: $('#login-username'),
  loginPassword: $('#login-password'),
  loginError: $('#login-error'),
  loginSubmit: $('#login-submit'),
  appShell: $('#app-shell'),
  logout: $('#logout'),
  userMenu: $('#user-menu'),
  userTrigger: $('#user-trigger'),
  userPopover: $('#user-popover'),
  userAvatar: $('.user-avatar'),
  usernameLabels: document.querySelectorAll('[data-username]'),
  sessionList: $('#session-list'),
  sessionCount: $('#session-count'),
  title: $('#session-title'),
  status: $('#status-pill'),
  model: $('#model-name'),
  modelSwitcher: $('#model-switcher'),
  modelTrigger: $('#model-trigger'),
  modelMenu: $('#model-menu'),
  modelOptions: $('#model-options'),
  modelError: $('#model-error'),
  chat: $('#chat-scroll'),
  messages: $('#messages'),
  welcome: $('#welcome'),
  composer: $('#composer'),
  input: $('#input'),
  send: $('#send'),
  stop: $('#stop'),
  contextMeter: $('#context-meter'),
  contextFill: $('#context-fill'),
  contextTooltip: $('#context-tooltip'),
  scrollBottom: $('#scroll-bottom'),
  theme: $('#theme-toggle'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarClose: $('#sidebar-close'),
  scrim: $('#mobile-scrim'),
  toast: $('#toast'),
};

const state = {
  sessions: [],
  current: null,
  controller: null,
  followOutput: true,
  loadVersion: 0,
  toastTimer: 0,
  authToken: localStorage.getItem('taiwei-token') || '',
  models: [],
  currentModel: 'OpenAI compatible',
  switchingModel: false,
  contextWindow: 128000,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: 128000, model: '' },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function inlineMarkdown(value) {
  const code = [];
  let output = value.replace(/`([^`\n]+)`/g, (_, content) => {
    code.push(`<code>${content}</code>`);
    return `\u0000INLINE${code.length - 1}\u0000`;
  });
  output = output
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return output.replace(/\u0000INLINE(\d+)\u0000/g, (_, index) => code[Number(index)]);
}

function renderMarkdown(source) {
  const blocks = [];
  const withoutCode = String(source).replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const safeCode = escapeHtml(code.replace(/\n$/, ''));
    const safeLanguage = escapeHtml(language.trim() || '代码');
    blocks.push(`<div class="code-block"><header><span>${safeLanguage}</span><button type="button" data-copy-code>复制</button></header><pre><code>${safeCode}</code></pre></div>`);
    return `\n\u0000BLOCK${blocks.length - 1}\u0000\n`;
  });
  const lines = escapeHtml(withoutCode).split(/\r?\n/);
  const output = [];
  let listType = '';
  const closeList = () => { if (listType) { output.push(`</${listType}>`); listType = ''; } };

  for (const line of lines) {
    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) { closeList(); output.push(blocks[Number(block[1])]); continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? 'ul' : 'ol';
      if (listType !== nextType) { closeList(); listType = nextType; output.push(`<${listType}>`); }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    if (!line.trim()) continue;
    const h3 = line.match(/^###\s+(.+)$/);
    const h4 = line.match(/^####\s+(.+)$/);
    const quote = line.match(/^&gt;\s?(.+)$/);
    if (h4) output.push(`<h4>${inlineMarkdown(h4[1])}</h4>`);
    else if (h3) output.push(`<h3>${inlineMarkdown(h3[1])}</h3>`);
    else if (quote) output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
    else output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return output.join('');
}

function formatTime(timestamp = new Date().toISOString()) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function relativeTime(timestamp) {
  const difference = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(difference) || difference < 45_000) return '刚刚';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`;
  if (difference < 604_800_000) return `${Math.floor(difference / 86_400_000)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 1800);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { const previous = button.textContent; button.textContent = '已复制'; setTimeout(() => { button.textContent = previous; }, 1200); }
    showToast('已复制到剪贴板');
  } catch { showToast('复制失败，请手动选择'); }
}

function setStatus(kind, label) {
  elements.status.className = `status-pill ${kind}`;
  elements.status.querySelector('span').textContent = label;
}

function formatTokens(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

function renderUsage(usage = state.usage) {
  const contextWindow = Math.max(1, Number(usage.contextWindow) || state.contextWindow || 128000);
  const totalTokens = Math.max(0, Number(usage.totalTokens) || 0);
  const percentage = Math.min(100, (totalTokens / contextWindow) * 100);
  elements.contextFill.style.width = `${percentage}%`;
  elements.contextMeter.classList.toggle('warning', percentage >= 70 && percentage < 90);
  elements.contextMeter.classList.toggle('danger', percentage >= 90);
  elements.contextMeter.setAttribute('aria-valuenow', percentage.toFixed(1));
  elements.contextMeter.setAttribute('aria-valuetext', `${percentage.toFixed(1)}%，${formatTokens(totalTokens)} / ${formatTokens(contextWindow)} tokens`);
  elements.contextTooltip.textContent = `总计 ${formatTokens(totalTokens)} · 提示 ${formatTokens(usage.promptTokens)} · 补全 ${formatTokens(usage.completionTokens)} · 窗口 ${formatTokens(contextWindow)} tokens · ${percentage.toFixed(1)}%`;
}

function setStreaming(streaming) {
  elements.body.classList.toggle('streaming', streaming);
  elements.input.disabled = streaming;
  elements.send.disabled = streaming || !elements.input.value.trim();
  document.querySelectorAll('.new-chat').forEach((button) => { button.disabled = streaming; });
  document.querySelectorAll('.session-item').forEach((item) => item.setAttribute('aria-disabled', String(streaming)));
  if (streaming) setStatus('streaming', '思考中');
}

function autoScroll(force = false) {
  if (force || state.followOutput) requestAnimationFrame(() => { elements.chat.scrollTop = elements.chat.scrollHeight; });
}

function renderTools(container, calls = []) {
  if (!calls.length) return null;
  const list = document.createElement('div');
  list.className = 'tool-list';
  for (const call of calls) {
    const details = document.createElement('details');
    details.className = `tool-entry${call.result !== undefined ? ' done' : ''}`;
    const summary = document.createElement('summary');
    const dot = document.createElement('i');
    dot.className = 'tool-state';
    const label = document.createElement('span');
    const preview = JSON.stringify(call.args || {});
    label.textContent = `🔧 ${call.name} ${preview.length > 70 ? `${preview.slice(0, 70)}…` : preview}`;
    const detail = document.createElement('pre');
    detail.className = 'tool-detail';
    detail.textContent = JSON.stringify(call.args || {}, null, 2) + (call.result !== undefined ? `\n\n结果\n${call.result}` : '\n\n正在运行…');
    summary.append(dot, label);
    details.append(summary, detail);
    list.append(details);
  }
  container.append(list);
  return list;
}

function addMessage(message, options = {}) {
  elements.welcome.classList.add('hidden');
  const row = document.createElement('article');
  const visualRole = message.status === 'error' ? 'error' : message.role;
  row.className = `message-row ${visualRole}`;
  row.dataset.role = message.role;
  if (message.role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '🦞';
    row.append(avatar);
  }
  const stack = document.createElement('div');
  stack.className = 'message-stack';
  renderTools(stack, message.toolCalls);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (message.role === 'assistant') bubble.innerHTML = renderMarkdown(message.content || '');
  else bubble.textContent = message.content;
  if (options.streaming) {
    const caret = document.createElement('span');
    caret.className = 'streaming-caret';
    bubble.append(caret);
  }
  stack.append(bubble);
  if (message.status === 'stopped') {
    const stopped = document.createElement('div');
    stopped.className = 'stop-note';
    stopped.textContent = '⏹ 已停止';
    stack.append(stopped);
  }
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const time = document.createElement('time');
  time.textContent = formatTime(message.timestamp);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-message';
  copy.textContent = '复制';
  copy.addEventListener('click', () => copyText(message.content || '', copy));
  meta.append(time, copy);
  stack.append(meta);
  row.append(stack);
  elements.messages.append(row);
  autoScroll(options.forceScroll);
  return { row, stack, bubble, meta, message };
}

function updateAssistant(view, content, streaming = true) {
  view.message.content = content;
  view.bubble.innerHTML = renderMarkdown(content);
  if (streaming) {
    const caret = document.createElement('span');
    caret.className = 'streaming-caret';
    view.bubble.append(caret);
  }
  autoScroll();
}

function finalizeAssistant(view, content) {
  updateAssistant(view, content, false);
  const copy = view.meta.querySelector('.copy-message');
  copy.onclick = () => copyText(content, copy);
  view.meta.querySelector('time').textContent = formatTime();
}

function renderSessionList() {
  elements.sessionList.replaceChildren();
  elements.sessionCount.textContent = String(state.sessions.length);
  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '暂无历史会话';
    elements.sessionList.append(empty);
    return;
  }
  for (const session of state.sessions) {
    const item = document.createElement('div');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.className = `session-item${state.current?.id === session.id ? ' active' : ''}`;
    item.title = session.title;
    const copy = document.createElement('span');
    copy.className = 'session-copy';
    const title = document.createElement('span');
    title.className = 'session-name';
    title.textContent = session.title;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${relativeTime(session.updatedAt)} · ${session.messageCount} 条`;
    copy.append(title, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'session-delete';
    remove.textContent = '🗑';
    remove.title = '删除会话';
    remove.setAttribute('aria-label', `删除 ${session.title}`);
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (state.controller || !confirm(`删除会话“${session.title}”？`)) return;
      await deleteSession(session.id);
    });
    item.append(copy, remove);
    item.addEventListener('click', () => { if (!state.controller) loadSession(session.id); });
    item.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !state.controller) { event.preventDefault(); loadSession(session.id); }
    });
    elements.sessionList.append(item);
  }
  setStreaming(Boolean(state.controller));
}

function renderConversation(session) {
  elements.messages.replaceChildren();
  elements.title.textContent = session?.title || '新会话';
  const messages = session?.messages || [];
  elements.welcome.classList.toggle('hidden', messages.length > 0);
  for (const message of messages) addMessage(message);
  state.usage = session?.usage
    ? { ...session.usage, contextWindow: state.contextWindow, model: state.currentModel }
    : {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      contextWindow: state.contextWindow,
      model: state.currentModel,
    };
  renderUsage();
  state.followOutput = true;
  autoScroll(true);
}

function authenticatedOptions(options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.authToken) headers.set('authorization', `Bearer ${state.authToken}`);
  return { ...options, headers };
}

async function authenticatedFetch(path, options) {
  return fetch(path, authenticatedOptions(options));
}

function showLogin() {
  localStorage.removeItem('taiwei-token');
  state.authToken = '';
  closeUserMenu();
  elements.appShell.hidden = true;
  elements.loginScreen.hidden = false;
  elements.loginPassword.value = '';
  elements.loginUsername.focus();
}

function showChat() {
  elements.loginScreen.hidden = true;
  elements.appShell.hidden = false;
}

async function requestJson(path, options) {
  const response = await authenticatedFetch(path, options);
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try { message = (await response.json()).error || message; } catch {}
    const error = new Error(message);
    error.status = response.status;
    if (response.status === 401) showLogin();
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function closeModelMenu() {
  elements.modelMenu.hidden = true;
  elements.modelTrigger.setAttribute('aria-expanded', 'false');
}

function closeUserMenu() {
  elements.userPopover.hidden = true;
  elements.userTrigger.setAttribute('aria-expanded', 'false');
}

function renderModels() {
  elements.model.textContent = state.currentModel;
  elements.modelTrigger.title = `当前模型：${state.currentModel}`;
  elements.modelOptions.replaceChildren();
  for (const name of state.models) {
    const option = document.createElement('button');
    const active = name === state.currentModel;
    option.type = 'button';
    option.className = `model-option${active ? ' active' : ''}`;
    option.dataset.model = name;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(active));
    option.innerHTML = `<span class="model-option-mark">${active ? '✓' : ''}</span><span>${escapeHtml(name)}</span>`;
    elements.modelOptions.append(option);
  }
}

async function selectModel(name) {
  if (state.switchingModel || name === state.currentModel) { closeModelMenu(); return; }
  const previous = state.currentModel;
  state.switchingModel = true;
  elements.modelSwitcher.classList.add('loading');
  elements.modelError.textContent = '';
  try {
    const result = await requestJson('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    state.currentModel = result.current;
    state.contextWindow = result.contextWindow || state.contextWindow;
    state.usage = { ...state.usage, contextWindow: state.contextWindow, model: state.currentModel };
    if (state.current) state.current.usage = state.usage;
    renderUsage();
    if (!state.models.includes(result.current)) state.models.push(result.current);
    renderModels();
    closeModelMenu();
    showToast(`已切换到 ${result.current}`);
  } catch (error) {
    state.currentModel = previous;
    elements.modelError.textContent = error.message;
    renderModels();
  } finally {
    state.switchingModel = false;
    elements.modelSwitcher.classList.remove('loading');
  }
}

elements.modelTrigger.addEventListener('click', () => {
  const opening = elements.modelMenu.hidden;
  elements.modelMenu.hidden = !opening;
  elements.modelTrigger.setAttribute('aria-expanded', String(opening));
  elements.modelError.textContent = '';
  if (opening) elements.modelOptions.querySelector('.active, .model-option')?.focus();
});

elements.modelOptions.addEventListener('click', (event) => {
  const option = event.target.closest('[data-model]');
  if (option) selectModel(option.dataset.model);
});

elements.userTrigger.addEventListener('click', () => {
  const opening = elements.userPopover.hidden;
  elements.userPopover.hidden = !opening;
  elements.userTrigger.setAttribute('aria-expanded', String(opening));
  if (opening) elements.logout.focus();
});

async function refreshSessions() {
  state.sessions = await requestJson('/api/sessions');
  renderSessionList();
}

async function loadSession(id) {
  const version = ++state.loadVersion;
  try {
    const session = await requestJson(`/api/sessions/${encodeURIComponent(id)}`);
    if (version !== state.loadVersion) return;
    state.current = session;
    renderConversation(session);
    renderSessionList();
    elements.body.classList.remove('sidebar-open');
    setStatus('idle', '就绪');
  } catch (error) { showToast(error.message); }
}

async function createSession() {
  if (state.controller) return null;
  try {
    const session = await requestJson('/api/sessions', { method: 'POST' });
    state.current = session;
    await refreshSessions();
    renderConversation(session);
    elements.body.classList.remove('sidebar-open');
    elements.input.focus();
    return session;
  } catch (error) { showToast(error.message); return null; }
}

async function deleteSession(id) {
  try {
    await requestJson(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const wasCurrent = state.current?.id === id;
    if (wasCurrent) state.current = null;
    await refreshSessions();
    if (wasCurrent && state.sessions.length) await loadSession(state.sessions[0].id);
    else if (wasCurrent) renderConversation(null);
    showToast('会话已删除');
  } catch (error) { showToast(error.message); }
}

function parseEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try { return { event, data: JSON.parse(data.join('\n')) }; } catch { return null; }
}

async function submit(message) {
  if (state.controller) return;
  if (!state.current && !await createSession()) return;
  const userMessage = { role: 'user', content: message, timestamp: new Date().toISOString() };
  addMessage(userMessage, { forceScroll: true });
  const assistantMessage = { role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: [] };
  const answerView = addMessage(assistantMessage, { streaming: true, forceScroll: true });
  const toolViews = [];
  let answer = '';
  let serverError = '';
  let usageCheckpoint = 0;
  state.controller = new AbortController();
  setStreaming(true);
  try {
    const response = await authenticatedFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, sessionId: state.current.id }),
      signal: state.controller.signal,
    });
    if (!response.ok || !response.body) {
      let detail = `请求失败 (${response.status})`;
      try { detail = (await response.json()).error || detail; } catch {}
      if (response.status === 401) showLogin();
      throw new Error(detail);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : blocks.pop() || '';
      for (const block of blocks) {
        const item = parseEvent(block);
        if (!item) continue;
        if (item.event === 'token') {
          answer += item.data.text || '';
          updateAssistant(answerView, answer);
          const estimatedTokens = Math.ceil(Math.max(0, answer.length - usageCheckpoint) / 4);
          renderUsage({
            ...state.usage,
            completionTokens: state.usage.completionTokens + estimatedTokens,
            totalTokens: state.usage.totalTokens + estimatedTokens,
          });
        } else if (item.event === 'tool') {
          const call = { name: item.data.name, args: item.data.args || {} };
          assistantMessage.toolCalls.push(call);
          let list = answerView.stack.querySelector('.tool-list');
          if (!list) { list = document.createElement('div'); list.className = 'tool-list'; }
          const holder = document.createElement('div');
          renderTools(holder, [call]);
          const details = holder.firstElementChild.firstElementChild;
          list.append(details);
          toolViews.push({ call, details });
          answerView.stack.insertBefore(list, answerView.bubble);
          autoScroll();
        } else if (item.event === 'tool_result') {
          const target = [...toolViews].reverse().find((entry) => entry.call.name === item.data.name && entry.call.result === undefined);
          if (target) {
            target.call.result = item.data.result;
            target.details.classList.add('done');
            target.details.querySelector('.tool-detail').textContent = `${JSON.stringify(target.call.args, null, 2)}\n\n结果\n${item.data.result}`;
          }
        } else if (item.event === 'usage') {
          state.usage = {
            promptTokens: item.data.promptTokens || 0,
            completionTokens: item.data.completionTokens || 0,
            totalTokens: item.data.totalTokens || 0,
            contextWindow: item.data.contextWindow || state.contextWindow,
            model: item.data.model || state.currentModel,
          };
          state.contextWindow = state.usage.contextWindow;
          state.current.usage = state.usage;
          usageCheckpoint = answer.length;
          renderUsage();
        } else if (item.event === 'done') {
          answer = item.data.text || answer;
          if (item.data.sessionId) state.current.id = item.data.sessionId;
          finalizeAssistant(answerView, answer);
        } else if (item.event === 'error') serverError = item.data.message || '未知错误';
      }
      if (done) break;
    }
    if (serverError) {
      if (!answer) answerView.row.remove();
      else finalizeAssistant(answerView, answer);
      addMessage({ role: 'assistant', content: `发生错误：${serverError}`, status: 'error', timestamp: new Date().toISOString() }, { forceScroll: true });
      setStatus('error', '出错了');
    } else {
      finalizeAssistant(answerView, answer);
      setStatus('idle', '就绪');
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      finalizeAssistant(answerView, answer);
      const stopped = document.createElement('div');
      stopped.className = 'stop-note';
      stopped.textContent = '⏹ 已停止';
      answerView.stack.insertBefore(stopped, answerView.meta);
      setStatus('idle', '已停止');
    } else {
      if (!answer) answerView.row.remove();
      else finalizeAssistant(answerView, answer);
      addMessage({ role: 'assistant', content: `连接失败：${error.message}`, status: 'error', timestamp: new Date().toISOString() }, { forceScroll: true });
      setStatus('error', '连接失败');
    }
  } finally {
    state.controller = null;
    setStreaming(false);
    elements.input.focus();
    setTimeout(async () => {
      try {
        await refreshSessions();
        if (state.current) {
          const fresh = await requestJson(`/api/sessions/${encodeURIComponent(state.current.id)}`);
          state.current = fresh;
          elements.title.textContent = fresh.title;
          state.usage = fresh.usage ?? state.usage;
          renderUsage();
          renderSessionList();
        }
      } catch {}
    }, 180);
  }
}

function resizeInput() {
  elements.input.style.height = 'auto';
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 170)}px`;
  elements.send.disabled = Boolean(state.controller) || !elements.input.value.trim();
}

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message || state.controller) return;
  elements.input.value = '';
  resizeInput();
  submit(message);
});

elements.input.addEventListener('input', resizeInput);
elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.stop.addEventListener('click', () => {
  if (!state.controller) return;
  authenticatedFetch('/api/stop', { method: 'POST' }).catch(() => {});
  state.controller.abort();
});

elements.chat.addEventListener('scroll', () => {
  const distance = elements.chat.scrollHeight - elements.chat.scrollTop - elements.chat.clientHeight;
  state.followOutput = distance < 110;
  elements.scrollBottom.classList.toggle('visible', !state.followOutput);
}, { passive: true });

elements.scrollBottom.addEventListener('click', () => {
  state.followOutput = true;
  elements.scrollBottom.classList.remove('visible');
  autoScroll(true);
});

document.addEventListener('click', (event) => {
  if (!elements.modelSwitcher.contains(event.target)) closeModelMenu();
  if (!elements.userMenu.contains(event.target)) closeUserMenu();
  const codeButton = event.target.closest('[data-copy-code]');
  if (codeButton) copyText(codeButton.closest('.code-block').querySelector('code').textContent, codeButton);
  const chip = event.target.closest('[data-prompt]');
  if (chip && !state.controller) {
    elements.input.value = chip.dataset.prompt;
    resizeInput();
    elements.input.focus();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    const modelWasOpen = !elements.modelMenu.hidden;
    const userWasOpen = !elements.userPopover.hidden;
    closeModelMenu();
    closeUserMenu();
    if (userWasOpen) elements.userTrigger.focus();
    else if (modelWasOpen) elements.modelTrigger.focus();
  }
});

document.querySelectorAll('.new-chat').forEach((button) => button.addEventListener('click', createSession));
elements.sidebarToggle.addEventListener('click', () => {
  if (matchMedia('(max-width: 680px)').matches) elements.body.classList.toggle('sidebar-open');
  else {
    elements.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('taiwei-sidebar-collapsed', elements.body.classList.contains('sidebar-collapsed') ? '1' : '0');
  }
});
elements.sidebarClose.addEventListener('click', () => elements.body.classList.remove('sidebar-open'));
elements.scrim.addEventListener('click', () => elements.body.classList.remove('sidebar-open'));

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  elements.loginSubmit.disabled = true;
  elements.loginSubmit.textContent = '登录中…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: elements.loginUsername.value, password: elements.loginPassword.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `登录失败 (${response.status})`);
    state.authToken = body.token;
    localStorage.setItem('taiwei-token', body.token);
    await loadChat();
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.loginPassword.select();
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = '登录';
  }
});

elements.logout.addEventListener('click', async () => {
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  try { await authenticatedFetch('/api/logout', { method: 'POST' }); } catch {}
  state.sessions = [];
  state.current = null;
  showLogin();
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.theme.textContent = theme === 'dark' ? '☾' : '☀';
  elements.theme.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
}

elements.theme.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('taiwei-theme', next);
  applyTheme(next);
});

async function loadChat() {
  try {
    const modelsRequest = requestJson('/api/models').catch(() => null);
    const [sessions, info, models] = await Promise.all([requestJson('/api/sessions'), requestJson('/api/info'), modelsRequest]);
    showChat();
    state.sessions = sessions;
    state.currentModel = models?.current || info.model || state.currentModel;
    state.contextWindow = info.contextWindow || state.contextWindow;
    state.models = models?.models?.length ? models.models : [state.currentModel];
    if (!state.models.includes(state.currentModel)) state.models.unshift(state.currentModel);
    renderModels();
    const username = info.username || '';
    elements.usernameLabels.forEach((element) => { element.textContent = username; });
    elements.userAvatar.textContent = Array.from(username)[0]?.toUpperCase() || 'U';
    elements.userTrigger.hidden = !info.authEnabled;
    renderSessionList();
    if (sessions.length) await loadSession(sessions[0].id);
    else renderConversation(null);
  } catch (error) {
    if (error.status === 401) return;
    setStatus('error', '服务离线');
    showToast(`无法连接网关：${error.message}`);
  }
  elements.input.focus();
}

async function initialize() {
  const savedTheme = localStorage.getItem('taiwei-theme');
  applyTheme(savedTheme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  if (localStorage.getItem('taiwei-sidebar-collapsed') === '1') elements.body.classList.add('sidebar-collapsed');
  resizeInput();
  await loadChat();
}

initialize();
