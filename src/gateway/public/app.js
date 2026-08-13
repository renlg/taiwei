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
  attachmentButton: $('#attachment-button'),
  fileInput: $('#file-input'),
  attachmentList: $('#attachment-list'),
  contextMeter: $('#context-meter'),
  contextFill: $('#context-fill'),
  contextPercent: $('#context-percent'),
  contextTooltip: $('#context-tooltip'),
  scrollBottom: $('#scroll-bottom'),
  theme: $('#theme-toggle'),
  settingsOpen: $('#settings-open'),
  settingsModal: $('#settings-modal'),
  settingsForm: $('#settings-form'),
  settingsClose: $('#settings-close'),
  settingsError: $('#settings-error'),
  settingsReset: $('#settings-reset'),
  skillsOpen: $('#skills-open'),
  skillsModal: $('#skills-modal'),
  skillsClose: $('#skills-close'),
  skillsError: $('#skills-error'),
  skillList: $('#skill-list'),
  skillDetail: $('#skill-detail'),
  knowledgeOpen: $('#knowledge-open'),
  knowledgeModal: $('#knowledge-modal'),
  knowledgeClose: $('#knowledge-close'),
  knowledgeError: $('#knowledge-error'),
  knowledgeRebuild: $('#knowledge-rebuild'),
  knowledgeUpload: $('#knowledge-upload'),
  knowledgeFileInput: $('#knowledge-file-input'),
  knowledgeIndexStatus: $('#knowledge-index-status'),
  knowledgeSearchForm: $('#knowledge-search-form'),
  knowledgeSearchInput: $('#knowledge-search-input'),
  knowledgeResultsSection: $('#knowledge-results-section'),
  knowledgeResults: $('#knowledge-results'),
  knowledgeFiles: $('#knowledge-files'),
  mcpOpen: $('#mcp-open'),
  mcpModal: $('#mcp-modal'),
  mcpClose: $('#mcp-close'),
  mcpError: $('#mcp-error'),
  mcpReload: $('#mcp-reload'),
  mcpAdd: $('#mcp-add'),
  mcpList: $('#mcp-list'),
  mcpForm: $('#mcp-form'),
  mcpFormTitle: $('#mcp-form-title'),
  mcpFormClose: $('#mcp-form-close'),
  mcpFormError: $('#mcp-form-error'),
  mcpName: $('#mcp-name'),
  mcpTransport: $('#mcp-transport'),
  mcpCommandField: $('#mcp-command-field'),
  mcpCommand: $('#mcp-command'),
  mcpUrlField: $('#mcp-url-field'),
  mcpUrl: $('#mcp-url'),
  mcpArgs: $('#mcp-args'),
  mcpEnv: $('#mcp-env'),
  mcpEnabled: $('#mcp-enabled'),
  mcpCancel: $('#mcp-cancel'),
  mcpSave: $('#mcp-save'),
  workspaceInput: $('#workspace-input'),
  workspaceResolved: $('#workspace-resolved'),
  workspaceLabel: $('#workspace-label'),
  securityEnabled: $('#security-enabled'),
  securityTimeout: $('#security-timeout'),
  securityRemember: $('#security-remember'),
  patternList: $('#pattern-list'),
  patternAdd: $('#pattern-add'),
  hookTimeout: $('#hook-timeout'),
  hookFields: $('#hook-fields'),
  hookTestEvent: $('#hook-test-event'),
  hookTest: $('#hook-test'),
  hookTestResult: $('#hook-test-result'),
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
  contextWindow: 256000,
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: 256000, model: '' },
  attachments: [],
  workspace: '',
  settingsRemember: 'off',
  confirmations: new Map(),
  mcpServers: [],
  mcpStatuses: [],
  editingMcp: null,
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

function addPatternRow(value = '') {
  const row = document.createElement('div');
  row.className = 'pattern-row';
  const input = document.createElement('input');
  input.value = value;
  input.placeholder = '正则表达式';
  input.setAttribute('aria-label', '危险命令正则');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'pattern-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', '删除规则');
  remove.addEventListener('click', () => row.remove());
  row.append(input, remove);
  elements.patternList.append(row);
}

function renderSettings(settings) {
  elements.workspaceInput.value = settings.workspace.dir;
  elements.workspaceResolved.textContent = `解析为 ${settings.workspace.resolvedDir}`;
  elements.workspaceLabel.textContent = settings.workspace.resolvedDir;
  elements.workspaceLabel.title = `当前工作区：${settings.workspace.resolvedDir}`;
  elements.securityEnabled.checked = settings.security.enabled;
  elements.securityTimeout.value = settings.security.timeoutSeconds;
  elements.securityRemember.value = settings.security.remember;
  state.settingsRemember = settings.security.remember;
  elements.patternList.replaceChildren();
  settings.security.patterns.forEach(addPatternRow);
  elements.hookTimeout.value = settings.hookTimeoutSeconds;
  elements.hookFields.querySelectorAll('[data-hook-event]').forEach((textarea) => {
    textarea.value = (settings.hooks?.[textarea.dataset.hookEvent] || []).join('\n');
  });
  elements.hookTestResult.textContent = '';
}

async function loadSettings() {
  const settings = await requestJson('/api/settings');
  renderSettings(settings);
  return settings;
}

async function openSettings() {
  elements.settingsError.textContent = '';
  try {
    await loadSettings();
    elements.settingsModal.showModal();
    elements.workspaceInput.focus();
  } catch (error) { showToast(error.message); }
}

function closeResourcePanels(except) {
  for (const modal of [elements.skillsModal, elements.knowledgeModal, elements.mcpModal]) {
    if (modal !== except && modal.open) modal.close();
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderResourceEmpty(container, message) {
  const empty = document.createElement('div');
  empty.className = 'resource-empty';
  empty.textContent = message;
  container.replaceChildren(empty);
}

async function showSkillDetail(name, button) {
  elements.skillsError.textContent = '';
  elements.skillList.querySelectorAll('.skill-item').forEach((item) => item.classList.toggle('active', item === button));
  renderResourceEmpty(elements.skillDetail, '加载中…');
  try {
    const skill = await requestJson(`/api/skills/${encodeURIComponent(name)}`);
    const header = document.createElement('header');
    const title = document.createElement('h3'); title.textContent = skill.name;
    const description = document.createElement('p'); description.textContent = skill.description;
    header.append(title, description);
    const content = document.createElement('div');
    content.innerHTML = renderMarkdown(skill.content);
    elements.skillDetail.replaceChildren(header, content);
  } catch (error) {
    elements.skillsError.textContent = error.message;
    renderResourceEmpty(elements.skillDetail, '无法加载技能详情');
  }
}

async function loadSkills() {
  elements.skillsError.textContent = '';
  renderResourceEmpty(elements.skillList, '加载中…');
  renderResourceEmpty(elements.skillDetail, '选择一个技能查看详情');
  try {
    const { skills } = await requestJson('/api/skills');
    if (!skills.length) {
      renderResourceEmpty(elements.skillList, '暂无技能, 将 SKILL.md 放入 ~/.taiwei/skills/<name>/ 目录');
      return;
    }
    elements.skillList.replaceChildren();
    skills.forEach((skill) => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = 'skill-item';
      const name = document.createElement('strong'); name.textContent = skill.name;
      const description = document.createElement('span'); description.textContent = skill.description;
      item.append(name, description);
      item.addEventListener('click', () => showSkillDetail(skill.name, item));
      elements.skillList.append(item);
    });
  } catch (error) {
    elements.skillsError.textContent = error.message;
    renderResourceEmpty(elements.skillList, '技能加载失败');
  }
}

async function openSkills() {
  closeResourcePanels(elements.skillsModal);
  if (!elements.skillsModal.open) elements.skillsModal.showModal();
  elements.body.classList.remove('sidebar-open');
  await loadSkills();
}

function renderKnowledge(data) {
  const index = data.index;
  elements.knowledgeIndexStatus.textContent = index.exists
    ? `已索引 · ${index.chunks} chunks · ${index.hasVectors ? '含向量' : '仅 BM25'} · ${index.embedModel || '无 embedding 模型'}`
    : '尚未建立索引';
  if (!data.files.length) {
    renderResourceEmpty(elements.knowledgeFiles, '知识库为空, 上传 .md/.txt 文件开始使用');
    return;
  }
  elements.knowledgeFiles.replaceChildren();
  data.files.forEach((file) => {
    const row = document.createElement('div'); row.className = 'knowledge-file';
    const info = document.createElement('div'); info.className = 'knowledge-file-info';
    const path = document.createElement('span'); path.className = 'knowledge-file-path'; path.textContent = file.path; path.title = file.path;
    const meta = document.createElement('span'); meta.className = 'knowledge-file-meta';
    const modified = new Date(file.mtime);
    meta.textContent = `${formatBytes(file.size)} · ${Number.isNaN(modified.getTime()) ? file.mtime : modified.toLocaleString('zh-CN')}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'knowledge-delete'; remove.textContent = '×'; remove.setAttribute('aria-label', `删除 ${file.path}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`确定删除知识库文件「${file.path}」吗？`)) return;
      remove.disabled = true;
      try {
        await requestJson(`/api/knowledge?path=${encodeURIComponent(file.path)}`, { method: 'DELETE' });
        showToast(`已删除 ${file.path}`);
        await loadKnowledge();
      } catch (error) { elements.knowledgeError.textContent = error.message; remove.disabled = false; }
    });
    info.append(path, meta); row.append(info, remove); elements.knowledgeFiles.append(row);
  });
}

async function loadKnowledge() {
  elements.knowledgeError.textContent = '';
  renderResourceEmpty(elements.knowledgeFiles, '加载中…');
  try { renderKnowledge(await requestJson('/api/knowledge')); }
  catch (error) { elements.knowledgeError.textContent = error.message; renderResourceEmpty(elements.knowledgeFiles, '知识库加载失败'); }
}

async function openKnowledge() {
  closeResourcePanels(elements.knowledgeModal);
  if (!elements.knowledgeModal.open) elements.knowledgeModal.showModal();
  elements.body.classList.remove('sidebar-open');
  await loadKnowledge();
}

function mcpStatusText(server, status) {
  if (!server.enabled || status?.detail === 'disabled') return { kind: 'disabled', text: '⏸ 已禁用' };
  if (status?.connected) {
    const count = status.detail.match(/^(\d+) tools$/)?.[1];
    return { kind: 'connected', text: `✓ 已连接${count === undefined ? '' : ` · ${count} 个工具`}` };
  }
  return { kind: 'failed', text: `✗ ${status?.detail || '未连接'}` };
}

function mcpPayload(server, enabled = server.enabled) {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.transport === 'stdio' ? { command: server.command } : { url: server.url }),
    ...(server.args ? { args: server.args } : {}),
    env: {},
    preserveEnv: true,
    enabled,
  };
}

function renderMcp(data) {
  state.mcpServers = data.servers || [];
  state.mcpStatuses = data.statuses || [];
  if (!state.mcpServers.length) {
    renderResourceEmpty(elements.mcpList, '未配置 MCP 服务器, 点击「添加服务器」接入');
    return;
  }
  elements.mcpList.replaceChildren();
  for (const server of state.mcpServers) {
    const status = state.mcpStatuses.find((item) => item.name === server.name);
    const card = document.createElement('article'); card.className = 'mcp-server';
    const top = document.createElement('div'); top.className = 'mcp-server-top';
    const main = document.createElement('div'); main.className = 'mcp-server-main';
    const name = document.createElement('strong'); name.className = 'mcp-server-name'; name.textContent = server.name;
    const badge = document.createElement('span'); badge.className = 'mcp-transport-badge'; badge.textContent = server.transport;
    main.append(name, badge);
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'mcp-switch'; toggleLabel.title = server.enabled ? '点击禁用' : '点击启用';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = server.enabled; toggle.setAttribute('aria-label', `${server.enabled ? '禁用' : '启用'} ${server.name}`);
    const toggleTrack = document.createElement('span'); toggleLabel.append(toggle, toggleTrack); top.append(main, toggleLabel);
    const endpointValue = server.transport === 'stdio' ? [server.command, ...(server.args || [])].filter(Boolean).join(' ') : server.url || '';
    const endpoint = document.createElement('code'); endpoint.className = 'mcp-server-endpoint'; endpoint.textContent = endpointValue; endpoint.title = endpointValue;
    const statusLine = document.createElement('div');
    const renderedStatus = mcpStatusText(server, status); statusLine.className = `mcp-status ${renderedStatus.kind}`; statusLine.textContent = renderedStatus.text;
    const actions = document.createElement('div'); actions.className = 'mcp-server-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'mcp-action'; edit.textContent = '编辑';
    const test = document.createElement('button'); test.type = 'button'; test.className = 'mcp-action'; test.textContent = '测试连接';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mcp-action danger'; remove.textContent = '删除';
    actions.append(edit, test, remove); card.append(top, endpoint, statusLine, actions); elements.mcpList.append(card);
    toggle.addEventListener('change', async () => {
      toggle.disabled = true; elements.mcpError.textContent = '';
      try { renderMcp(await requestJson('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mcpPayload(server, toggle.checked)) })); }
      catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; elements.mcpError.textContent = error.message; }
    });
    edit.addEventListener('click', () => openMcpForm(server));
    test.addEventListener('click', async () => {
      test.disabled = true; test.textContent = '测试中…'; statusLine.className = 'mcp-status'; statusLine.textContent = '正在建立独立连接…';
      try {
        const result = await requestJson('/api/mcp/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: server.name }) });
        const display = mcpStatusText({ ...server, enabled: true }, result);
        statusLine.className = `mcp-status ${display.kind}`; statusLine.textContent = display.text;
      } catch (error) { statusLine.className = 'mcp-status failed'; statusLine.textContent = `✗ ${error.message}`; }
      finally { test.disabled = false; test.textContent = '测试连接'; }
    });
    remove.addEventListener('click', async () => {
      if (!confirm(`确定删除 MCP 服务器「${server.name}」吗？`)) return;
      remove.disabled = true; elements.mcpError.textContent = '';
      try {
        const result = await requestJson(`/api/mcp?name=${encodeURIComponent(server.name)}`, { method: 'DELETE' });
        renderMcp(result); closeMcpForm(); showToast(`已删除 ${server.name}`);
      } catch (error) { remove.disabled = false; elements.mcpError.textContent = error.message; }
    });
  }
}

async function loadMcp() {
  elements.mcpError.textContent = '';
  renderResourceEmpty(elements.mcpList, '加载中…');
  try { renderMcp(await requestJson('/api/mcp')); }
  catch (error) { elements.mcpError.textContent = error.message; renderResourceEmpty(elements.mcpList, 'MCP 服务器加载失败'); }
}

async function openMcp() {
  closeResourcePanels(elements.mcpModal);
  closeMcpForm();
  if (!elements.mcpModal.open) elements.mcpModal.showModal();
  elements.body.classList.remove('sidebar-open');
  await loadMcp();
}

function updateMcpTransportFields() {
  const stdio = elements.mcpTransport.value === 'stdio';
  elements.mcpCommandField.hidden = !stdio;
  elements.mcpUrlField.hidden = stdio;
  elements.mcpCommand.required = stdio;
  elements.mcpUrl.required = !stdio;
}

function openMcpForm(server) {
  state.editingMcp = server || null;
  elements.mcpFormTitle.textContent = server ? `编辑 ${server.name}` : '添加服务器';
  elements.mcpFormError.textContent = '';
  elements.mcpName.value = server?.name || '';
  elements.mcpName.readOnly = Boolean(server);
  elements.mcpTransport.value = server?.transport || 'stdio';
  elements.mcpCommand.value = server?.command || '';
  elements.mcpUrl.value = server?.url || '';
  elements.mcpArgs.value = (server?.args || []).join(', ');
  elements.mcpEnv.value = (server?.envKeys || []).map((key) => `${key}=***`).join('\n');
  elements.mcpEnabled.checked = server?.enabled !== false;
  elements.mcpForm.hidden = false;
  updateMcpTransportFields();
  elements.mcpName.focus();
}

function closeMcpForm() {
  state.editingMcp = null;
  elements.mcpForm.hidden = true;
  elements.mcpFormError.textContent = '';
}

function parseMcpEnv(value) {
  const env = {};
  let preserveEnv = Boolean(state.editingMcp);
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`环境变量格式无效：${line}`);
    const key = line.slice(0, separator).trim();
    const item = line.slice(separator + 1).trim();
    if (!key) throw new Error(`环境变量 key 不能为空：${line}`);
    if (item === '***') { preserveEnv = true; continue; }
    env[key] = item;
  }
  return { env, preserveEnv };
}

function renderKnowledgeResults(results) {
  elements.knowledgeResultsSection.hidden = false;
  if (!results.length) { renderResourceEmpty(elements.knowledgeResults, '未找到相关内容'); return; }
  elements.knowledgeResults.replaceChildren();
  results.forEach((result) => {
    const item = document.createElement('article'); item.className = 'knowledge-result';
    const score = document.createElement('span'); score.className = 'knowledge-result-score'; score.textContent = `score ${Number(result.score).toFixed(4)}`;
    const text = document.createElement('div'); text.className = 'knowledge-result-text'; text.textContent = result.text;
    item.append(score, text); elements.knowledgeResults.append(item);
  });
}

function enqueueConfirmation(request, answerView) {
  if (!answerView.stack.querySelector('.bubble')?.textContent && !answerView.stack.querySelector('.tool-list')) answerView.row.remove();
  const row = document.createElement('div');
  row.className = 'message-row confirmation-row';
  row.dataset.confirmationId = request.id;
  const card = document.createElement('section');
  card.className = 'confirmation-card pending';
  const heading = document.createElement('header');
  heading.innerHTML = '<span class="confirmation-icon" aria-hidden="true">⚠️</span><div><h3>危险命令确认</h3><p></p></div>';
  heading.querySelector('p').textContent = request.reason || '此命令需要你的确认';
  const workspace = document.createElement('div');
  workspace.className = 'confirmation-workspace';
  workspace.textContent = `工作区：${request.workspace || ''}`;
  const commandWrap = document.createElement('div');
  commandWrap.className = 'confirmation-command-wrap';
  const command = document.createElement('pre');
  command.className = 'confirmation-command';
  command.textContent = request.command;
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'confirmation-copy'; copy.textContent = '复制';
  copy.addEventListener('click', () => copyText(request.command, copy));
  commandWrap.append(command, copy);
  const controls = document.createElement('div');
  controls.className = 'confirmation-controls';
  const rememberLabel = document.createElement('label');
  rememberLabel.className = 'confirmation-remember';
  const remember = document.createElement('input');
  remember.type = 'checkbox';
  const rememberText = document.createElement('span'); rememberText.textContent = '记住选择';
  const rememberMode = document.createElement('select');
  rememberMode.innerHTML = '<option value="session">本次会话</option><option value="permanent">永久</option>';
  rememberMode.value = state.settingsRemember === 'permanent' ? 'permanent' : 'session';
  remember.checked = state.settingsRemember !== 'off';
  rememberMode.disabled = !remember.checked;
  remember.addEventListener('change', () => { rememberMode.disabled = !remember.checked; });
  rememberLabel.append(remember, rememberText, rememberMode);
  const countdown = document.createElement('span');
  countdown.className = 'confirmation-countdown';
  controls.append(rememberLabel, countdown);
  const actions = document.createElement('footer');
  const reject = document.createElement('button');
  reject.type = 'button'; reject.className = 'secondary-button danger-button'; reject.textContent = '拒绝';
  const approve = document.createElement('button');
  approve.type = 'button'; approve.className = 'primary-button'; approve.textContent = '允许运行';
  actions.append(reject, approve);
  const status = document.createElement('div');
  status.className = 'confirmation-status';
  card.append(heading, workspace, commandWrap, controls, actions, status);
  row.append(card);
  elements.messages.append(row);
  const deadline = Date.now() + Number(request.timeoutSeconds || 60) * 1000;
  const updateCountdown = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    countdown.textContent = `剩余 ${remaining}s`;
    if (!remaining) decideConfirmation(request.id, false, 'timeout');
  };
  state.confirmations.set(request.id, { request, card, timer: 0, remember, rememberMode });
  updateCountdown();
  const pending = state.confirmations.get(request.id);
  if (pending) pending.timer = setInterval(updateCountdown, 1000);
  reject.addEventListener('click', () => decideConfirmation(request.id, false));
  approve.addEventListener('click', () => decideConfirmation(request.id, true));
  autoScroll(true);
}

async function decideConfirmation(id, approve, outcome = approve ? 'approved' : 'rejected') {
  const pending = state.confirmations.get(id);
  if (!pending || !pending.card.classList.contains('pending')) return;
  clearInterval(pending.timer);
  pending.card.classList.remove('pending');
  pending.card.classList.add(outcome);
  pending.card.querySelector('.confirmation-controls').hidden = true;
  pending.card.querySelector('footer').hidden = true;
  const status = pending.card.querySelector('.confirmation-status');
  status.textContent = outcome === 'approved' ? '✓ 已允许' : outcome === 'timeout' ? '已超时（自动拒绝）' : '✕ 已拒绝';
  state.confirmations.delete(id);
  try {
    await requestJson('/api/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, approve, remember: approve && pending.remember.checked ? pending.rememberMode.value : 'off' }),
    });
  } catch (error) {
    if (error.status === 404) {
      pending.card.classList.remove('approved', 'rejected');
      pending.card.classList.add('timeout');
      status.textContent = '已超时（自动拒绝）';
    } else showToast(error.message);
  }
}

async function rejectPendingConfirmations() {
  await Promise.all([...state.confirmations.keys()].map((id) => decideConfirmation(id, false)));
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
  const contextWindow = Math.max(1, Number(usage.contextWindow) || state.contextWindow || 256000);
  const totalTokens = Math.max(0, Number(usage.totalTokens) || 0);
  const percentage = Math.min(100, (totalTokens / contextWindow) * 100);
  elements.contextFill.style.strokeDashoffset = String(100 - percentage);
  elements.contextPercent.textContent = `${Math.round(percentage)}%`;
  elements.contextMeter.classList.toggle('warning', percentage >= 70 && percentage < 90);
  elements.contextMeter.classList.toggle('danger', percentage >= 90);
  elements.contextMeter.setAttribute('aria-valuenow', percentage.toFixed(1));
  elements.contextMeter.setAttribute('aria-valuetext', `${percentage.toFixed(1)}%，${formatTokens(totalTokens)} / ${formatTokens(contextWindow)} tokens`);
  elements.contextTooltip.textContent = `总计 ${formatTokens(totalTokens)} · 提示 ${formatTokens(usage.promptTokens)} · 补全 ${formatTokens(usage.completionTokens)} · 窗口 ${formatTokens(contextWindow)} tokens · ${percentage.toFixed(1)}%`;
}

function setStreaming(streaming) {
  elements.body.classList.toggle('streaming', streaming);
  elements.input.disabled = streaming;
  elements.attachmentButton.disabled = streaming || state.attachments.length >= 5;
  elements.send.disabled = streaming || state.attachments.some((file) => file.uploading) || !elements.input.value.trim();
  elements.attachmentList.querySelectorAll('button').forEach((button) => { button.disabled = streaming; });
  document.querySelectorAll('.new-chat').forEach((button) => { button.disabled = streaming; });
  document.querySelectorAll('.session-item').forEach((item) => item.setAttribute('aria-disabled', String(streaming)));
  if (streaming) setStatus('streaming', '思考中');
}

function formatFileSize(value) {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderAttachments() {
  elements.attachmentList.replaceChildren();
  for (const attachment of state.attachments) {
    const chip = document.createElement('div');
    chip.className = `attachment-chip${attachment.uploading ? ' uploading' : ''}`;
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = attachment.name;
    name.title = attachment.name;
    const size = document.createElement('span');
    size.className = 'attachment-size';
    size.textContent = attachment.uploading ? '上传中…' : formatFileSize(attachment.size);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `移除 ${attachment.name}`);
    remove.disabled = Boolean(state.controller);
    remove.addEventListener('click', () => {
      state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      renderAttachments();
      resizeInput();
    });
    chip.append(name, size, remove);
    elements.attachmentList.append(chip);
  }
  elements.attachmentButton.disabled = Boolean(state.controller) || state.attachments.length >= 5;
  elements.send.disabled = Boolean(state.controller) || state.attachments.some((file) => file.uploading) || !elements.input.value.trim();
}

async function uploadFile(file) {
  const attachment = { id: crypto.randomUUID(), name: file.name, size: file.size, type: file.type, uploading: true };
  state.attachments.push(attachment);
  renderAttachments();
  try {
    const response = await authenticatedFetch('/api/upload', {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name),
        ...(state.current?.id ? { 'x-session-id': state.current.id } : {}),
      },
      body: file,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showLogin();
      throw new Error(body.error || `上传失败 (${response.status})`);
    }
    Object.assign(attachment, body, { uploading: false });
  } catch (error) {
    state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
    showToast(`${file.name}：${error.message}`);
  }
  renderAttachments();
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
    const avatarImg = document.createElement('img');
    avatarImg.className = 'avatar-img';
    avatarImg.src = '/logo.png?v={{ASSET_VERSION}}';
    avatarImg.alt = 'taiwei';
    avatar.append(avatarImg);
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
    state.attachments = [];
    renderAttachments();
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
    state.attachments = [];
    renderAttachments();
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

async function submit(message, files = []) {
  if (state.controller) return;
  if (!state.current && !await createSession()) return;
  const userMessage = { role: 'user', content: message, timestamp: new Date().toISOString() };
  addMessage(userMessage, { forceScroll: true });
  const assistantMessage = { role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: [] };
  let answerView = addMessage(assistantMessage, { streaming: true, forceScroll: true });
  const toolViews = [];
  let answer = '';
  let segmentText = '';
  let serverError = '';
  let usageCheckpoint = 0;
  state.controller = new AbortController();
  setStreaming(true);
  try {
    const response = await authenticatedFetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        sessionId: state.current.id,
        files: files.map(({ name, path, size, type }) => ({ name, path, size, type })),
      }),
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
          const text = item.data.text || '';
          answer += text;
          segmentText += text;
          updateAssistant(answerView, segmentText);
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
        } else if (item.event === 'confirm') {
          if (segmentText || answerView.stack.querySelector('.tool-list')) finalizeAssistant(answerView, segmentText);
          enqueueConfirmation(item.data, answerView);
          segmentText = '';
          answerView = addMessage({ role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: [] }, { streaming: true, forceScroll: true });
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
          const finalAnswer = item.data.text || answer;
          if (!answer && finalAnswer) segmentText = finalAnswer;
          answer = finalAnswer;
          if (item.data.sessionId) state.current.id = item.data.sessionId;
          finalizeAssistant(answerView, segmentText);
        } else if (item.event === 'error') serverError = item.data.message || '未知错误';
      }
      if (done) break;
    }
    if (serverError) {
      if (!segmentText && !answerView.stack.querySelector('.tool-list')) answerView.row.remove();
      else finalizeAssistant(answerView, segmentText);
      addMessage({ role: 'assistant', content: `发生错误：${serverError}`, status: 'error', timestamp: new Date().toISOString() }, { forceScroll: true });
      setStatus('error', '出错了');
    } else {
      finalizeAssistant(answerView, segmentText);
      setStatus('idle', '就绪');
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      finalizeAssistant(answerView, segmentText);
      const stopped = document.createElement('div');
      stopped.className = 'stop-note';
      stopped.textContent = '⏹ 已停止';
      answerView.stack.insertBefore(stopped, answerView.meta);
      setStatus('idle', '已停止');
    } else {
      if (!segmentText && !answerView.stack.querySelector('.tool-list')) answerView.row.remove();
      else finalizeAssistant(answerView, segmentText);
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
  elements.send.disabled = Boolean(state.controller) || state.attachments.some((file) => file.uploading) || !elements.input.value.trim();
}

elements.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (!message || state.controller || state.attachments.some((file) => file.uploading)) return;
  const files = state.attachments.filter((file) => file.path);
  state.attachments = [];
  renderAttachments();
  elements.input.value = '';
  resizeInput();
  submit(message, files);
});

elements.attachmentButton.addEventListener('click', () => {
  if (!state.controller && state.attachments.length < 5) elements.fileInput.click();
});

elements.fileInput.addEventListener('change', async () => {
  const selected = Array.from(elements.fileInput.files || []);
  elements.fileInput.value = '';
  if (!selected.length) return;
  if (!state.current && !await createSession()) return;
  const available = Math.max(0, 5 - state.attachments.length);
  if (selected.length > available) showToast('每条消息最多添加 5 个附件');
  await Promise.all(selected.slice(0, available).map(uploadFile));
});

elements.input.addEventListener('input', resizeInput);
elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.stop.addEventListener('click', async () => {
  if (!state.controller) return;
  void rejectPendingConfirmations();
  authenticatedFetch('/api/stop', { method: 'POST' }).catch(() => {});
  state.controller.abort();
});

elements.settingsOpen.addEventListener('click', openSettings);
elements.settingsClose.addEventListener('click', () => elements.settingsModal.close());
elements.skillsOpen.addEventListener('click', openSkills);
elements.skillsClose.addEventListener('click', () => elements.skillsModal.close());
elements.knowledgeOpen.addEventListener('click', openKnowledge);
elements.knowledgeClose.addEventListener('click', () => elements.knowledgeModal.close());
elements.mcpOpen.addEventListener('click', openMcp);
elements.mcpClose.addEventListener('click', () => elements.mcpModal.close());
for (const modal of [elements.skillsModal, elements.knowledgeModal, elements.mcpModal]) {
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
}
elements.mcpModal.addEventListener('close', closeMcpForm);
elements.mcpAdd.addEventListener('click', () => openMcpForm());
elements.mcpFormClose.addEventListener('click', closeMcpForm);
elements.mcpCancel.addEventListener('click', closeMcpForm);
elements.mcpTransport.addEventListener('change', updateMcpTransportFields);
elements.mcpReload.addEventListener('click', async () => {
  elements.mcpError.textContent = '';
  elements.mcpReload.disabled = true;
  elements.mcpReload.textContent = '重载中…';
  try { renderMcp(await requestJson('/api/mcp/reload', { method: 'POST' })); showToast('MCP 连接已重载'); }
  catch (error) { elements.mcpError.textContent = error.message; }
  finally { elements.mcpReload.disabled = false; elements.mcpReload.textContent = '重载连接'; }
});
elements.mcpForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.mcpFormError.textContent = '';
  if (!elements.mcpForm.reportValidity()) return;
  try {
    const transport = elements.mcpTransport.value;
    const args = elements.mcpArgs.value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    const { env, preserveEnv } = parseMcpEnv(elements.mcpEnv.value);
    const payload = {
      name: elements.mcpName.value.trim(),
      transport,
      ...(transport === 'stdio' ? { command: elements.mcpCommand.value.trim() } : { url: elements.mcpUrl.value.trim() }),
      args,
      env,
      preserveEnv,
      enabled: elements.mcpEnabled.checked,
    };
    elements.mcpSave.disabled = true; elements.mcpSave.textContent = '保存中…';
    const result = await requestJson('/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    renderMcp(result); closeMcpForm(); showToast(`已保存 ${payload.name}`);
  } catch (error) { elements.mcpFormError.textContent = error.message; }
  finally { elements.mcpSave.disabled = false; elements.mcpSave.textContent = '保存并重载'; }
});
elements.knowledgeUpload.addEventListener('click', () => elements.knowledgeFileInput.click());
elements.knowledgeFileInput.addEventListener('change', async () => {
  const [file] = elements.knowledgeFileInput.files;
  elements.knowledgeFileInput.value = '';
  if (!file) return;
  elements.knowledgeError.textContent = '';
  elements.knowledgeUpload.disabled = true;
  elements.knowledgeUpload.textContent = '上传中…';
  try {
    await requestJson('/api/knowledge/upload', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
    });
    showToast(`已上传 ${file.name}`);
    await loadKnowledge();
  } catch (error) { elements.knowledgeError.textContent = error.message; }
  finally { elements.knowledgeUpload.disabled = false; elements.knowledgeUpload.textContent = '上传文件'; }
});
elements.knowledgeRebuild.addEventListener('click', async () => {
  elements.knowledgeError.textContent = '';
  elements.knowledgeRebuild.disabled = true;
  elements.knowledgeRebuild.textContent = '重建中…';
  try {
    const result = await requestJson('/api/knowledge/rebuild', { method: 'POST' });
    showToast(`索引完成：${result.chunks} chunks，${result.hasVectors ? '含向量' : '仅 BM25'}`);
    await loadKnowledge();
  } catch (error) { elements.knowledgeError.textContent = error.message; }
  finally { elements.knowledgeRebuild.disabled = false; elements.knowledgeRebuild.textContent = '重建索引'; }
});
elements.knowledgeSearchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = elements.knowledgeSearchInput.value.trim();
  elements.knowledgeError.textContent = '';
  if (!query) { elements.knowledgeError.textContent = '请输入搜索关键词'; return; }
  const button = elements.knowledgeSearchForm.querySelector('button');
  button.disabled = true; button.textContent = '搜索中…';
  try {
    const { results } = await requestJson(`/api/knowledge/search?q=${encodeURIComponent(query)}&limit=5`);
    renderKnowledgeResults(results);
  } catch (error) { elements.knowledgeError.textContent = error.message; }
  finally { button.disabled = false; button.textContent = '搜索'; }
});
elements.patternAdd.addEventListener('click', () => addPatternRow());
elements.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.settingsError.textContent = '';
  const patterns = [...elements.patternList.querySelectorAll('input')].map((input) => input.value.trim()).filter(Boolean);
  const hooks = Object.fromEntries([...elements.hookFields.querySelectorAll('[data-hook-event]')].map((textarea) => [
    textarea.dataset.hookEvent,
    textarea.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  ]));
  try {
    const result = await requestJson('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspace: { dir: elements.workspaceInput.value.trim() },
        security: {
          enabled: elements.securityEnabled.checked,
          timeoutSeconds: Number(elements.securityTimeout.value),
          remember: elements.securityRemember.value,
          patterns,
        },
        hooks,
        hookTimeoutSeconds: Number(elements.hookTimeout.value),
      }),
    });
    elements.workspaceLabel.textContent = result.workspace.resolvedDir;
    elements.workspaceLabel.title = `当前工作区：${result.workspace.resolvedDir}`;
    state.workspace = result.workspace.resolvedDir;
    state.settingsRemember = result.security.remember;
    elements.settingsModal.close();
    showToast('设置已保存');
  } catch (error) { elements.settingsError.textContent = error.message; }
});
elements.hookTest.addEventListener('click', async () => {
  const event = elements.hookTestEvent.value;
  const textarea = elements.hookFields.querySelector(`[data-hook-event="${event}"]`);
  const command = textarea.value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  elements.hookTestResult.textContent = '';
  if (!command) { elements.hookTestResult.textContent = '请先为该事件填写至少一条命令。'; return; }
  elements.hookTest.disabled = true;
  elements.hookTest.textContent = '测试中…';
  try {
    const result = await requestJson('/api/hooks/test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event, command }),
    });
    elements.hookTestResult.textContent = [
      `exit: ${result.exitCode === null ? 'null' : result.exitCode}${result.timedOut ? ' (timeout)' : ''}`,
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n');
  } catch (error) { elements.hookTestResult.textContent = error.message; }
  finally { elements.hookTest.disabled = false; elements.hookTest.textContent = '测试首条命令'; }
});
elements.settingsReset.addEventListener('click', async () => {
  try {
    await requestJson('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resetSecurity: true }) });
    await loadSettings();
    showToast('安全设置已重置');
  } catch (error) { elements.settingsError.textContent = error.message; }
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
    await rejectPendingConfirmations();
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
    state.workspace = info.workspace || '';
    elements.workspaceLabel.textContent = state.workspace;
    elements.workspaceLabel.title = `当前工作区：${state.workspace}`;
    state.models = models?.models?.length ? models.models : [state.currentModel];
    if (!state.models.includes(state.currentModel)) state.models.unshift(state.currentModel);
    renderModels();
    const username = info.username || '';
    elements.usernameLabels.forEach((element) => { element.textContent = username; });
    elements.userAvatar.textContent = Array.from(username)[0]?.toUpperCase() || 'U';
    elements.userTrigger.hidden = !info.authEnabled;
    renderSessionList();
    await loadSettings();
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
