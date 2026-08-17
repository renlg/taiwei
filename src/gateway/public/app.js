const $ = (selector) => document.querySelector(selector);
const elements = {
  body: document.body,
  loginScreen: $('#login-screen'),
  loginForm: $('#login-form'),
  loginUsername: $('#login-username'),
  loginPassword: $('#login-password'),
  loginError: $('#login-error'),
  loginSubmit: $('#login-submit'),
  adminLoginFields: $('#admin-login-fields'),
  oauthLoginPanel: $('#oauth-login-panel'),
  oauthLogin: $('#oauth-login'),
  loginDescription: $('#login-description'),
  loginTabs: document.querySelectorAll('[data-login-role]'),
  appShell: $('#app-shell'),
  logout: $('#logout'),
  guestLogout: $('#guest-logout'),
  userMenu: $('#user-menu'),
  userTrigger: $('#user-trigger'),
  userPopover: $('#user-popover'),
  userAvatar: $('.user-avatar'),
  guestModeLabel: $('#guest-mode-label'),
  usernameLabels: document.querySelectorAll('[data-username]'),
  sessionList: $('#session-list'),
  sessionCount: $('#session-count'),
  folderAdd: $('#folder-add'),
  title: $('#session-title'),
  status: $('#status-pill'),
  model: $('#model-name'),
  modelSwitcher: $('#model-switcher'),
  modelTrigger: $('#model-trigger'),
  modelMenu: $('#model-menu'),
  modelOptions: $('#model-options'),
  modelError: $('#model-error'),
  agentSelector: $('#agent-selector'),
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
  customPromptSettings: $('.custom-prompt-settings'),
  customPromptToggle: $('#custom-prompt-toggle'),
  customPromptStatus: $('#custom-prompt-status'),
  customPromptInput: $('#custom-prompt-input'),
  customPromptCount: $('#custom-prompt-count'),
  customPromptFeedback: $('#custom-prompt-feedback'),
  customPromptSave: $('#custom-prompt-save'),
  customPromptClear: $('#custom-prompt-clear'),
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
  toolsOpen: $('#tools-open'),
  toolsModal: $('#tools-modal'),
  toolsClose: $('#tools-close'),
  toolsError: $('#tools-error'),
  toolsReload: $('#tools-reload'),
  toolsList: $('#tools-list'),
  pluginsList: $('#plugins-list'),
  memoryOpen: $('#memory-open'),
  memoryModal: $('#memory-modal'),
  memoryClose: $('#memory-close'),
  memoryStatus: $('#memory-status'),
  memoryRefresh: $('#memory-refresh'),
  memoryError: $('#memory-error'),
  memoryContent: $('#memory-content'),
  memoryFeedback: $('#memory-feedback'),
  memoryClear: $('#memory-clear'),
  memorySave: $('#memory-save'),
  memoryRebuild: $('#memory-rebuild'),
  memoryIndexStatus: $('#memory-index-status'),
  extendedMemoryList: $('#extended-memory-list'),
  cronOpen: $('#cron-open'), cronModal: $('#cron-modal'), cronClose: $('#cron-close'), cronError: $('#cron-error'), cronList: $('#cron-list'), cronHistory: $('#cron-history'),
  deploymentsOpen: $('#deployments-open'), deploymentsModal: $('#deployments-modal'), deploymentsClose: $('#deployments-close'), deploymentsError: $('#deployments-error'), deploymentsResult: $('#deployments-result'), deploymentsList: $('#deployments-list'),
  confirmModal: $('#confirm-modal'), confirmForm: $('#confirm-form'), confirmIcon: $('#confirm-icon'), confirmTitle: $('#confirm-title'), confirmDesc: $('#confirm-desc'), confirmObject: $('#confirm-object'), confirmInput: $('#confirm-input'), confirmOk: $('#confirm-ok'), confirmCancel: $('#confirm-cancel'),
  workspaceInput: $('#workspace-input'),
  workspaceResolved: $('#workspace-resolved'),
  workspaceLabel: $('#workspace-label'),
  workspaceSettings: $('.workspace-settings'),
  workspaceToggle: $('#workspace-toggle'),
  workspaceStatus: $('#workspace-status'),
  securityEnabled: $('#security-enabled'),
  securityTimeout: $('#security-timeout'),
  securityRemember: $('#security-remember'),
  patternList: $('#pattern-list'),
  patternAdd: $('#pattern-add'),
  securitySettings: $('.security-settings'),
  securityToggle: $('#security-toggle'),
  securityStatus: $('#security-status'),
  hooksSettings: $('.hooks-settings'),
  hooksToggle: $('#hooks-toggle'),
  hooksStatus: $('#hooks-status'),
  hookTimeout: $('#hook-timeout'),
  hookFields: $('#hook-fields'),
  hookTestEvent: $('#hook-test-event'),
  hookTest: $('#hook-test'),
  hookTestResult: $('#hook-test-result'),
  shareSettings: $('.share-settings'),
  shareToggle: $('#share-toggle'),
  shareStatus: $('#share-status'),
  shareCreate: $('#share-create'),
  shareDisable: $('#share-disable'),
  shareLinkRow: $('#share-link-row'),
  shareUrl: $('#share-url'),
  shareCopy: $('#share-copy'),
  auditSettings: $('.audit-settings'), auditToggle: $('#audit-toggle'), auditStatus: $('#audit-status'), auditFilter: $('#audit-filter'), auditList: $('#audit-list'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarClose: $('#sidebar-close'),
  scrim: $('#mobile-scrim'),
  toast: $('#toast'),
};

const state = {
  sessions: [],
  folders: [],
  expandedFolders: new Set(),
  current: null,
  controller: null,
  followOutput: true,
  loadVersion: 0,
  toastTimer: 0,
  authToken: localStorage.getItem('taiwei-token') || '',
  shareToken: localStorage.getItem('taiwei_share_token') || '',
  role: localStorage.getItem('taiwei-role') || 'admin',
  username: localStorage.getItem('taiwei-username') || '',
  loginRole: 'admin',
  models: [],
  providers: [],
  currentProvider: 'default',
  currentModel: 'OpenAI compatible',
  currentAgent: 'build',
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
  tools: [],
  plugins: [],
  savedMemory: '',
  memoryFeedbackTimer: 0,
};

const WORKSPACE_OPEN_STORAGE_KEY = 'taiwei-settings-workspace-open';
const SECURITY_OPEN_STORAGE_KEY = 'taiwei-settings-security-open';
const HOOKS_OPEN_STORAGE_KEY = 'taiwei-settings-hooks-open';
const CUSTOM_PROMPT_OPEN_STORAGE_KEY = 'taiwei-settings-customprompt-open';
const SHARE_OPEN_STORAGE_KEY = 'taiwei-settings-share-open';
const AUDIT_OPEN_STORAGE_KEY = 'taiwei-settings-audit-open';
const LAST_MODEL_STORAGE_PREFIX = 'taiwei-last-model:';

function lastModelStorageKey() {
  return `${LAST_MODEL_STORAGE_PREFIX}${state.role}:${state.username || 'local'}`;
}

function loadLastModel() {
  try {
    const value = JSON.parse(localStorage.getItem(lastModelStorageKey()) || 'null');
    return value && typeof value.model === 'string'
      ? { model: value.model, provider: typeof value.provider === 'string' ? value.provider : undefined }
      : null;
  } catch { return null; }
}

function saveLastModel(model, provider) {
  localStorage.setItem(lastModelStorageKey(), JSON.stringify({ model, provider }));
}
const MAX_CUSTOM_PROMPT_LENGTH = 20000;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function containsMedia(result) {
  if (result === undefined || result === null) return false;
  const text = String(result);
  return /!\[[^\]]*\]\(https?:\/\/[^)\s]+\)/i.test(text)
    || /<img\b/i.test(text)
    || /\.(?:mp4|webm|mov)(?:\?[^\s<]*)?$/i.test(text)
    || /https?:\/\/[^\s<>"']+\.(?:mp4|webm|mov)(?:\?[^\s<>"']*)?(?=[\s<>"')]|$)/i.test(text);
}

function inlineMarkdown(value) {
  const code = [];
  const media = [];
  const keepMedia = (html) => {
    media.push(html);
    return `\u0000MEDIA${media.length - 1}\u0000`;
  };
  const isVideoUrl = (url) => /\.(?:mp4|webm|mov)(?:\?[^\s<]*)?$/i.test(url)
    || /\/video\//i.test(url)
    || /^https?:\/\/(?:video[.-]|[^/]*[.-]video[.-])/i.test(url);
  let output = value.replace(/`([^`\n]+)`/g, (_, content) => {
    code.push(`<code>${content}</code>`);
    return `\u0000INLINE${code.length - 1}\u0000`;
  });
  output = output
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => keepMedia(`<img src="${url}" alt="${alt}" loading="lazy" style="max-width:100%;border-radius:8px;">`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) => isVideoUrl(url)
      ? keepMedia(`<video src="${url}" controls style="max-width:100%;border-radius:8px;" aria-label="${label}"></video>`)
      : keepMedia(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`))
    .replace(/(^|[^\w"'>])(https?:\/\/[^\s<]+)/g, (_, prefix, url) => prefix + (isVideoUrl(url)
      ? keepMedia(`<video src="${url}" controls style="max-width:100%;border-radius:8px;"></video>`)
      : keepMedia(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return output
    .replace(/\u0000INLINE(\d+)\u0000/g, (_, index) => code[Number(index)])
    .replace(/\u0000MEDIA(\d+)\u0000/g, (_, index) => media[Number(index)]);
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
  let imageLines = [];
  const closeList = () => { if (listType) { output.push(`</${listType}>`); listType = ''; } };
  const flushImages = () => {
    if (!imageLines.length) return;
    const countClass = imageLines.length <= 4 ? `media-grid-${imageLines.length}` : 'media-grid-many';
    output.push(`<div class="media-grid ${countClass}">${imageLines.map((line) => inlineMarkdown(line)).join('')}</div>`);
    imageLines = [];
  };

  for (const line of lines) {
    const block = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (block) { closeList(); flushImages(); output.push(blocks[Number(block[1])]); continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushImages();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType !== nextType) { closeList(); listType = nextType; output.push(`<${listType}>`); }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();
    const trimmedLine = line.trim();
    if (/^!\[[^\]]*\]\(https?:\/\/[^)\s]+\)$/.test(trimmedLine)) {
      imageLines.push(trimmedLine);
      continue;
    }
    flushImages();
    if (!trimmedLine) continue;
    const h3 = line.match(/^###\s+(.+)$/);
    const h4 = line.match(/^####\s+(.+)$/);
    const quote = line.match(/^&gt;\s?(.+)$/);
    if (h4) output.push(`<h4>${inlineMarkdown(h4[1])}</h4>`);
    else if (h3) output.push(`<h3>${inlineMarkdown(h3[1])}</h3>`);
    else if (quote) output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
    else output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  flushImages();
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

/* Pretty confirm dialog. Resolves true on confirm, false on cancel/backdrop/Esc.
   options: { title, desc, object (optional extra line), okText, danger:boolean } */
function confirmDialog(options = {}) {
  return new Promise((resolve) => {
    const { title = '确认操作', desc = '', object = '', okText = '确认', danger = false } = options;
    elements.confirmModal.classList.remove('prompt-mode');
    elements.confirmTitle.textContent = title;
    elements.confirmDesc.textContent = desc;
    elements.confirmObject.textContent = object || '';
    elements.confirmInput.style.display = 'none';
    elements.confirmOk.textContent = okText;
    elements.confirmOk.className = `btn ${danger ? 'btn-danger' : 'btn-ok'}`;
    elements.confirmIcon.textContent = danger ? '🗑️' : '⚠️';

    const cleanup = (result) => {
      elements.confirmOk.removeEventListener('click', onOk);
      elements.confirmCancel.removeEventListener('click', onCancel);
      elements.confirmModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      if (elements.confirmModal.open) elements.confirmModal.close();
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => { if (event.target === elements.confirmModal) cleanup(false); };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); cleanup(false); }
      else if (event.key === 'Enter') { event.preventDefault(); cleanup(true); }
    };
    elements.confirmOk.addEventListener('click', onOk);
    elements.confirmCancel.addEventListener('click', onCancel);
    elements.confirmModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    elements.confirmModal.showModal();
    elements.confirmOk.focus();
  });
}

/* Pretty input dialog (replaces window.prompt). Resolves string|null; null on cancel/Esc. */
function promptDialog(options = {}) {
  return new Promise((resolve) => {
    const { title = '输入', desc = '', placeholder = '', okText = '确定', initial = '' } = options;
    elements.confirmModal.classList.add('prompt-mode');
    elements.confirmTitle.textContent = title;
    elements.confirmDesc.textContent = desc;
    elements.confirmObject.textContent = '';
    elements.confirmInput.placeholder = placeholder;
    elements.confirmInput.value = initial;
    elements.confirmOk.textContent = okText;
    elements.confirmOk.className = 'btn btn-ok';
    elements.confirmIcon.textContent = '✏️';

    const cleanup = (result) => {
      elements.confirmOk.removeEventListener('click', onOk);
      elements.confirmCancel.removeEventListener('click', onCancel);
      elements.confirmModal.removeEventListener('click', onBackdrop);
      elements.confirmInput.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onKey);
      if (elements.confirmModal.open) elements.confirmModal.close();
      resolve(result);
    };
    const onOk = () => cleanup(elements.confirmInput.value.trim() || null);
    const onCancel = () => cleanup(null);
    const onBackdrop = (event) => { if (event.target === elements.confirmModal) cleanup(null); };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); cleanup(null); }
      else if (event.key === 'Enter') { event.preventDefault(); onOk(); }
    };
    elements.confirmOk.addEventListener('click', onOk);
    elements.confirmCancel.addEventListener('click', onCancel);
    elements.confirmModal.addEventListener('click', onBackdrop);
    elements.confirmInput.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onKey);
    elements.confirmModal.showModal();
    elements.confirmInput.focus();
    elements.confirmInput.select();
  });
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
  remove.addEventListener('click', () => {
    row.remove();
    updateSecurityStatus();
  });
  row.append(input, remove);
  elements.patternList.append(row);
  updateSecurityStatus();
}

function updateWorkspaceStatus() {
  elements.workspaceStatus.textContent = elements.workspaceInput.value.trim() === '~/workspace' ? '默认 ~/workspace' : '已设置';
}

function updateSecurityStatus() {
  if (!elements.securityEnabled.checked) {
    elements.securityStatus.textContent = '未开启';
    return;
  }
  const count = elements.patternList.querySelectorAll('.pattern-row').length;
  elements.securityStatus.textContent = `已开启 · ${count} 条规则`;
}

function updateHooksStatus() {
  const count = [...elements.hookFields.querySelectorAll('[data-hook-event]')]
    .reduce((total, textarea) => total + textarea.value.split(/\r?\n/).filter((line) => line.trim()).length, 0);
  elements.hooksStatus.textContent = count ? `${count} 条命令` : '未配置';
}

function updateCustomPromptStatus() {
  const value = elements.customPromptInput.value;
  const words = value.trim() ? value.trim().split(/\s+/u).length : 0;
  elements.customPromptStatus.textContent = value.trim() ? `已设置 · ${value.length} 字` : '未配置';
  elements.customPromptCount.textContent = `${value.length} / ${MAX_CUSTOM_PROMPT_LENGTH} 字 · ${words} 词`;
}

function renderCustomPrompt({ customPrompt }) {
  elements.customPromptInput.value = customPrompt;
  elements.customPromptFeedback.textContent = '';
  updateCustomPromptStatus();
}

async function loadCustomPrompt() {
  const result = await requestJson('/api/settings/custom-prompt');
  renderCustomPrompt(result);
  return result;
}

function setSettingsCollapseOpen(section, toggle, storageKey, open, remember = false) {
  section.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (remember) localStorage.setItem(storageKey, String(open));
}

function renderSettings(settings) {
  elements.workspaceInput.value = settings.workspace.dir;
  elements.workspaceResolved.textContent = `解析为 ${settings.workspace.resolvedDir}`;
  updateWorkspaceStatus();
  elements.workspaceLabel.textContent = settings.workspace.resolvedDir;
  elements.workspaceLabel.title = `当前工作区：${settings.workspace.resolvedDir}`;
  elements.securityEnabled.checked = settings.security.enabled;
  elements.securityTimeout.value = settings.security.timeoutSeconds;
  elements.securityRemember.value = settings.security.remember;
  state.settingsRemember = settings.security.remember;
  elements.patternList.replaceChildren();
  settings.security.patterns.forEach(addPatternRow);
  updateSecurityStatus();
  elements.hookTimeout.value = settings.hookTimeoutSeconds;
  elements.hookFields.querySelectorAll('[data-hook-event]').forEach((textarea) => {
    textarea.value = (settings.hooks?.[textarea.dataset.hookEvent] || []).join('\n');
  });
  updateHooksStatus();
  elements.hookTestResult.textContent = '';
}

async function loadSettings() {
  const settings = await requestJson('/api/settings');
  renderSettings(settings);
  return settings;
}

function renderSharing(share) {
  elements.shareStatus.textContent = share.enabled ? '已开启' : '未开启';
  elements.shareDisable.hidden = !share.enabled;
  elements.shareLinkRow.hidden = !share.enabled || !share.url;
  elements.shareUrl.value = share.url || '';
}

async function loadSharing() {
  renderSharing(await requestJson('/api/share'));
}

async function loadAudit() {
  const { entries } = await requestJson('/api/audit?limit=100');
  const filter = elements.auditFilter.value.trim().toLowerCase();
  const shown = entries.filter((entry) => !filter || String(entry.type || '').toLowerCase().includes(filter));
  elements.auditStatus.textContent = `${shown.length} 条`;
  elements.auditList.textContent = shown.map((entry) => JSON.stringify(entry)).join('\n') || '暂无审计事件';
}

async function openSettings() {
  elements.settingsError.textContent = '';
  try {
    await Promise.all([loadSettings(), loadCustomPrompt(), loadSharing()]);
    setSettingsCollapseOpen(elements.customPromptSettings, elements.customPromptToggle, CUSTOM_PROMPT_OPEN_STORAGE_KEY, localStorage.getItem(CUSTOM_PROMPT_OPEN_STORAGE_KEY) === 'true');
    setSettingsCollapseOpen(elements.workspaceSettings, elements.workspaceToggle, WORKSPACE_OPEN_STORAGE_KEY, localStorage.getItem(WORKSPACE_OPEN_STORAGE_KEY) === 'true');
    setSettingsCollapseOpen(elements.securitySettings, elements.securityToggle, SECURITY_OPEN_STORAGE_KEY, localStorage.getItem(SECURITY_OPEN_STORAGE_KEY) === 'true');
    setSettingsCollapseOpen(elements.hooksSettings, elements.hooksToggle, HOOKS_OPEN_STORAGE_KEY, localStorage.getItem(HOOKS_OPEN_STORAGE_KEY) === 'true');
    setSettingsCollapseOpen(elements.shareSettings, elements.shareToggle, SHARE_OPEN_STORAGE_KEY, localStorage.getItem(SHARE_OPEN_STORAGE_KEY) === 'true');
    setSettingsCollapseOpen(elements.auditSettings, elements.auditToggle, AUDIT_OPEN_STORAGE_KEY, localStorage.getItem(AUDIT_OPEN_STORAGE_KEY) === 'true');
    if (elements.auditToggle.getAttribute('aria-expanded') === 'true') await loadAudit();
    elements.settingsModal.showModal();
    elements.workspaceToggle.focus();
  } catch (error) { showToast(error.message); }
}

function closeResourcePanels(except) {
  for (const modal of [elements.skillsModal, elements.knowledgeModal, elements.mcpModal, elements.toolsModal, elements.memoryModal, elements.cronModal, elements.deploymentsModal]) {
    if (modal !== except && modal.open) modal.close();
  }
}

function cronRunText(run) {
  return `${run.status} · ${new Date(run.startedAt).toLocaleString()}${run.output ? ` · ${run.output.slice(0, 100)}` : ''}${run.error ? ` · ${run.error}` : ''}`;
}

async function loadCron() {
  elements.cronError.textContent = '';
  const [{ jobs }, { runs }] = await Promise.all([requestJson('/api/cron'), requestJson('/api/cron/runs?limit=50')]);
  if (!jobs.length) renderResourceEmpty(elements.cronList, '暂无定时任务');
  else {
    elements.cronList.replaceChildren();
    for (const job of jobs) {
      const row = document.createElement('article'); row.className = 'cron-job';
      const info = document.createElement('div'); info.innerHTML = `<strong>${escapeHtml(job.name)}</strong><small>${escapeHtml(job.kind)} · ${escapeHtml(job.at || job.schedule || '')}<br>下次：${job.nextRun ? new Date(job.nextRun).toLocaleString() : '—'}</small>`;
      const actions = document.createElement('div'); actions.className = 'cron-actions';
      const toggle = document.createElement('button'); toggle.className = 'small-button'; toggle.textContent = job.enabled ? '暂停' : '启用';
      const run = document.createElement('button'); run.className = 'small-button'; run.textContent = '立即运行';
      toggle.addEventListener('click', async () => { toggle.disabled = true; try { await requestJson('/api/cron', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...job, enabled: !job.enabled }) }); await loadCron(); } catch (error) { elements.cronError.textContent = error.message; toggle.disabled = false; } });
      run.addEventListener('click', async () => { run.disabled = true; run.textContent = '运行中…'; try { await requestJson(`/api/cron/${encodeURIComponent(job.id)}/run`, { method: 'POST' }); await loadCron(); } catch (error) { elements.cronError.textContent = error.message; run.disabled = false; run.textContent = '立即运行'; } });
      actions.append(toggle, run); row.append(info, actions); elements.cronList.append(row);
    }
  }
  if (!runs.length) renderResourceEmpty(elements.cronHistory, '暂无运行记录');
  else { elements.cronHistory.replaceChildren(...runs.map((run) => { const row = document.createElement('div'); row.className = `cron-run ${run.status}`; row.textContent = cronRunText(run); return row; })); }
}

async function openCron() {
  closeResourcePanels(elements.cronModal); if (!elements.cronModal.open) elements.cronModal.showModal(); elements.body.classList.remove('sidebar-open');
  try { await loadCron(); } catch (error) { elements.cronError.textContent = error.message; }
}

function deploymentDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function deploymentStatusText(status) {
  return { running: '运行中', stopped: '已停止', cleaned: '已清理', failed: '失败' }[status] || status;
}

function renderCleanupResult(result) {
  const labels = { stop_port: '停止端口', delete_files: '删除文件', remove_nginx: '清理 nginx' };
  elements.deploymentsResult.textContent = result.steps.map((step) => `${step.status === 'failed' ? '✕' : '✓'} ${labels[step.step] || step.step}：${step.message}`).join('\n');
  elements.deploymentsResult.classList.toggle('failed', !result.ok);
}

async function cleanupDeploymentRecord(deployment, button) {
  const ok = await confirmDialog({
    title: '清理部署',
    desc: `将停止端口 ${deployment.port}、删除全部项目文件并移除 nginx 代理，且无法撤销。`,
    object: deployment.name,
    okText: '清理',
    danger: true,
  });
  if (!ok) return;
  elements.deploymentsError.textContent = '';
  elements.deploymentsResult.textContent = '';
  button.disabled = true;
  button.textContent = '清理中…';
  try {
    const result = await requestJson(`/api/deployments/${encodeURIComponent(deployment.name)}?ownerHash=${encodeURIComponent(deployment.ownerHash)}`, { method: 'DELETE' });
    renderCleanupResult(result);
    await loadDeployments(false);
  } catch (error) {
    elements.deploymentsError.textContent = error.message;
    button.disabled = false;
    button.textContent = '清理';
  }
}

async function loadDeployments(clearResult = true) {
  elements.deploymentsError.textContent = '';
  if (clearResult) elements.deploymentsResult.textContent = '';
  const { deployments } = await requestJson('/api/deployments');
  if (!deployments.length) {
    renderResourceEmpty(elements.deploymentsList, '暂无部署记录');
    return;
  }
  elements.deploymentsList.replaceChildren();
  for (const deployment of deployments) {
    const row = document.createElement('article');
    row.className = 'deployment-item';
    const main = document.createElement('div');
    main.className = 'deployment-main';
    const heading = document.createElement('div');
    heading.className = 'deployment-heading';
    const name = document.createElement('strong'); name.textContent = deployment.name;
    const badge = document.createElement('span'); badge.className = `deployment-status ${deployment.status}`; badge.textContent = deploymentStatusText(deployment.status);
    heading.append(name, badge);
    const meta = document.createElement('div');
    meta.className = 'deployment-meta';
    meta.textContent = `端口 ${deployment.port} · ${deployment.ownerHash} · 创建 ${deploymentDate(deployment.createdAt)} · 更新 ${deploymentDate(deployment.updatedAt)}`;
    const link = document.createElement('a');
    link.href = deployment.url || deployment.path;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = deployment.url || deployment.path;
    main.append(heading, link, meta);
    const cleanup = document.createElement('button');
    cleanup.className = 'small-button deployment-cleanup';
    cleanup.textContent = deployment.status === 'cleaned' ? '已清理' : '清理';
    cleanup.disabled = deployment.status === 'cleaned';
    cleanup.addEventListener('click', () => cleanupDeploymentRecord(deployment, cleanup));
    row.append(main, cleanup);
    elements.deploymentsList.append(row);
  }
}

async function openDeployments() {
  if (state.role !== 'admin') return;
  closeResourcePanels(elements.deploymentsModal);
  if (!elements.deploymentsModal.open) elements.deploymentsModal.showModal();
  elements.body.classList.remove('sidebar-open');
  try { await loadDeployments(); } catch (error) { elements.deploymentsError.textContent = error.message; }
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

let skillDetailRequest = 0;
let skillDetailController = null;

async function showSkillDetail(name, button) {
  const request = ++skillDetailRequest;
  skillDetailController?.abort();
  skillDetailController = new AbortController();
  elements.skillsError.textContent = '';
  elements.skillList.querySelectorAll('.skill-item').forEach((item) => item.classList.toggle('active', item === button));
  renderResourceEmpty(elements.skillDetail, '加载中…');
  try {
    const skill = await requestJson(`/api/skills/${encodeURIComponent(name)}`, { signal: skillDetailController.signal });
    if (request !== skillDetailRequest) return;
    const header = document.createElement('header');
    const title = document.createElement('h3'); title.textContent = skill.name;
    const description = document.createElement('p'); description.textContent = skill.description;
    header.append(title, description);
    const content = document.createElement('div');
    content.innerHTML = renderMarkdown(skill.content);
    elements.skillDetail.replaceChildren(header, content);
  } catch (error) {
    if (request !== skillDetailRequest || error.name === 'AbortError') return;
    elements.skillsError.textContent = error.message;
    renderResourceEmpty(elements.skillDetail, `无法加载技能详情：${error.message}`);
  } finally {
    if (request === skillDetailRequest) skillDetailController = null;
  }
}

async function loadSkills() {
  skillDetailRequest += 1;
  skillDetailController?.abort();
  skillDetailController = null;
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
      const item = document.createElement('article');
      item.className = `skill-item${skill.enabled ? '' : ' disabled'}`;
      const top = document.createElement('div'); top.className = 'skill-item-top';
      const select = document.createElement('button'); select.type = 'button'; select.className = 'skill-select';
      const name = document.createElement('strong'); name.textContent = skill.name;
      const status = document.createElement('small'); status.className = 'skill-status'; status.textContent = skill.enabled ? '已启用' : '已禁用';
      select.append(name, status);
      const toggleLabel = document.createElement('label'); toggleLabel.className = 'mcp-switch'; toggleLabel.title = skill.enabled ? '点击禁用' : '点击启用';
      const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = skill.enabled;
      toggle.setAttribute('aria-label', `${skill.enabled ? '禁用' : '启用'} ${skill.name}`);
      const track = document.createElement('span'); toggleLabel.append(toggle, track); top.append(select, toggleLabel);
      const description = document.createElement('p'); description.className = 'skill-description'; description.textContent = skill.description;
      item.append(top, description);
      item.addEventListener('click', (event) => {
        if (event.target.closest('.mcp-switch')) return;
        void showSkillDetail(skill.name, item);
      });
      toggle.addEventListener('change', async () => {
        toggle.disabled = true; elements.skillsError.textContent = '';
        try {
          await requestJson(`/api/skills/${encodeURIComponent(skill.name)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }),
          });
          showToast(`${skill.name} 已${toggle.checked ? '启用' : '禁用'}`);
          await loadSkills();
        } catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; elements.skillsError.textContent = error.message; }
      });
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
      const ok = await confirmDialog({
        title: '删除知识库文件',
        desc: '此操作会删除该文件，且无法撤销。',
        object: file.path,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
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
      const ok = await confirmDialog({
        title: '删除 MCP 服务器',
        desc: '此操作会删除该 MCP 服务器配置，且无法撤销。',
        object: server.name,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
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

function renderManagedTools(data) {
  state.tools = data.tools || [];
  elements.toolsList.replaceChildren();
  for (const tool of state.tools) {
    const card = document.createElement('article'); card.className = `tool-card${tool.enabled ? '' : ' disabled'}`;
    const top = document.createElement('div'); top.className = 'tool-card-top';
    const copy = document.createElement('div'); copy.className = 'tool-card-copy';
    const name = document.createElement('strong'); name.className = 'tool-card-name'; name.textContent = tool.name;
    const description = document.createElement('p'); description.className = 'tool-card-description'; description.textContent = tool.description; description.title = tool.description;
    copy.append(name, description);
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'mcp-switch'; toggleLabel.title = tool.enabled ? '点击禁用' : '点击启用';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = tool.enabled; toggle.setAttribute('aria-label', `${tool.enabled ? '禁用' : '启用'} ${tool.name}`);
    const track = document.createElement('span'); toggleLabel.append(toggle, track); top.append(copy, toggleLabel); card.append(top);
    toggle.addEventListener('change', async () => {
      toggle.disabled = true; elements.toolsError.textContent = '';
      try {
        const result = await requestJson(`/api/tools/${encodeURIComponent(tool.name)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }),
        });
        tool.enabled = result.enabled; renderManagedTools({ tools: state.tools });
        showToast(`${tool.name} 已${result.enabled ? '启用' : '禁用'}`);
      } catch (error) { toggle.checked = !toggle.checked; toggle.disabled = false; elements.toolsError.textContent = error.message; }
    });
    if (tool.configurable) {
      const details = document.createElement('details'); details.className = 'tool-config';
      const summary = document.createElement('summary'); summary.textContent = '配置'; details.append(summary);
      const form = document.createElement('form'); form.className = 'tool-config-form';
      for (const [field, schema] of Object.entries(tool.configSchema || {})) {
        const label = document.createElement('label'); label.textContent = schema.label || field;
        const input = document.createElement('input'); input.name = field; input.type = schema.type === 'number' ? 'number' : 'text';
        input.value = String(tool.config?.[field] ?? schema.default ?? '');
        if (schema.placeholder) input.placeholder = schema.placeholder;
        if (schema.type === 'number') {
          input.step = '1'; input.required = true;
          if (schema.min !== undefined) input.min = String(schema.min);
          if (schema.max !== undefined) input.max = String(schema.max);
        }
        label.append(input);
        if (schema.description) { const help = document.createElement('small'); help.textContent = schema.description; label.append(help); }
        form.append(label);
      }
      const save = document.createElement('button'); save.type = 'submit'; save.className = 'small-button'; save.textContent = '保存配置'; form.append(save); details.append(form); card.append(details);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const config = {};
        for (const [field, schema] of Object.entries(tool.configSchema || {})) {
          const input = form.elements.namedItem(field);
          config[field] = schema.type === 'number' ? input.valueAsNumber : input.value;
        }
        save.disabled = true; save.textContent = '保存中…'; elements.toolsError.textContent = '';
        try {
          const result = await requestJson(`/api/tools/${encodeURIComponent(tool.name)}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config }),
          });
          tool.config = result.config; showToast(`${tool.name} 配置已保存`);
        } catch (error) { elements.toolsError.textContent = error.message; }
        finally { save.disabled = false; save.textContent = '保存配置'; }
      });
    }
    elements.toolsList.append(card);
  }
}

function renderPlugins(data) {
  state.plugins = data?.plugins || [];
  elements.pluginsList.replaceChildren();
  if (!state.plugins.length) { renderResourceEmpty(elements.pluginsList, '未安装插件'); return; }
  for (const plugin of state.plugins) {
    const card = document.createElement('article'); card.className = `tool-card${plugin.enabled ? '' : ' disabled'}`;
    const top = document.createElement('div'); top.className = 'tool-card-top';
    const copy = document.createElement('div'); copy.className = 'tool-card-copy';
    const name = document.createElement('strong'); name.className = 'tool-card-name'; name.textContent = `${plugin.name}${plugin.version ? ` · ${plugin.version}` : ''}`;
    const description = document.createElement('p'); description.className = 'tool-card-description'; description.textContent = plugin.error || `${plugin.tools} tools · ${plugin.skills} skills${plugin.crashed ? ' · crashed' : ''}`;
    copy.append(name, description);
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'mcp-switch';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = plugin.enabled; const track = document.createElement('span'); toggleLabel.append(toggle, track); top.append(copy, toggleLabel); card.append(top);
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      try { const result = await requestJson(`/api/plugins/${encodeURIComponent(plugin.name)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: toggle.checked }) }); renderPlugins(result); await loadTools(); }
      catch (error) { elements.toolsError.textContent = error.message; toggle.checked = !toggle.checked; toggle.disabled = false; }
    });
    elements.pluginsList.append(card);
  }
}

async function loadTools(reload = false) {
  elements.toolsError.textContent = '';
  renderResourceEmpty(elements.toolsList, '加载中…');
  try { const [tools, plugins] = await Promise.all([requestJson(reload ? '/api/tools/reload' : '/api/tools', reload ? { method: 'POST' } : {}), requestJson('/api/plugins').catch(() => ({ plugins: [] }))]); renderManagedTools(tools); renderPlugins(plugins); }
  catch (error) { elements.toolsError.textContent = error.message; renderResourceEmpty(elements.toolsList, '工具加载失败'); }
}

async function openTools() {
  closeResourcePanels(elements.toolsModal);
  if (!elements.toolsModal.open) elements.toolsModal.showModal();
  elements.body.classList.remove('sidebar-open');
  await loadTools();
}

function setMemoryFeedback(message) {
  clearTimeout(state.memoryFeedbackTimer);
  elements.memoryFeedback.textContent = message;
  state.memoryFeedbackTimer = setTimeout(() => { elements.memoryFeedback.textContent = ''; }, 2200);
}

function updateMemoryControls() {
  elements.memorySave.disabled = elements.memoryContent.disabled || elements.memoryContent.value === state.savedMemory;
}

function renderMemory(data) {
  const core = data.core || data;
  state.savedMemory = core.content ?? data.content ?? '';
  elements.memoryContent.value = state.savedMemory;
  elements.memoryStatus.textContent = `${core.chars ?? data.chars} 字 · ${core.lines ?? data.lines} 行`;
  const index = data.indexStatus || { exists: false, chunks: 0, hasVectors: false };
  elements.memoryIndexStatus.textContent = index.exists ? `${index.chunks} chunks · ${index.hasVectors ? 'BM25 + 向量' : '仅 BM25'}` : '尚未建立索引';
  elements.extendedMemoryList.replaceChildren();
  if (!data.extended?.length) renderResourceEmpty(elements.extendedMemoryList, '暂无扩展记忆');
  for (const item of data.extended || []) {
    const row = document.createElement('div'); row.className = 'extended-memory-item';
    row.innerHTML = `<span><strong>${escapeHtml(item.name)}.md</strong> <small>${item.chars} 字</small></span><button class="knowledge-delete" type="button" aria-label="删除">×</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '删除扩展记忆',
        desc: '此操作会删除该扩展记忆文件，且无法撤销。',
        object: `${item.name}.md`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      try { await requestJson(`/api/memory/extended?name=${encodeURIComponent(item.name)}`, { method: 'DELETE' }); await loadMemory(); }
      catch (error) { elements.memoryError.textContent = error.message; }
    });
    elements.extendedMemoryList.append(row);
  }
  updateMemoryControls();
}

async function loadMemory() {
  elements.memoryError.textContent = '';
  elements.memoryFeedback.textContent = '';
  elements.memoryContent.disabled = true;
  elements.memoryRefresh.disabled = true;
  elements.memoryClear.disabled = true;
  elements.memoryStatus.textContent = '加载中…';
  elements.memoryContent.placeholder = '正在加载持久记忆…';
  try { renderMemory(await requestJson('/api/memory')); }
  catch (error) {
    elements.memoryError.textContent = error.message;
    elements.memoryStatus.textContent = '加载失败';
  } finally {
    elements.memoryContent.disabled = false;
    elements.memoryRefresh.disabled = false;
    elements.memoryClear.disabled = false;
    elements.memoryContent.placeholder = '持久记忆为空';
    updateMemoryControls();
  }
}

async function openMemory() {
  closeResourcePanels(elements.memoryModal);
  if (!elements.memoryModal.open) elements.memoryModal.showModal();
  elements.body.classList.remove('sidebar-open');
  await loadMemory();
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
  document.querySelectorAll('.folder-action, .folder-toggle, .folder-name').forEach((button) => { button.disabled = streaming; });
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
    const detail = document.createElement('div');
    detail.className = 'tool-detail';
    renderToolDetail(detail, call.args, call.result);
    if (call.result !== undefined && containsMedia(call.result)) details.open = true;
    summary.append(dot, label);
    details.append(summary, detail);
    list.append(details);
  }
  container.append(list);
  return list;
}

function renderToolDetail(detail, args, result) {
  const argsBlock = document.createElement('pre');
  argsBlock.className = 'tool-args';
  argsBlock.textContent = JSON.stringify(args || {}, null, 2);
  detail.replaceChildren(argsBlock);
  if (result === undefined) {
    const pending = document.createElement('div');
    pending.className = 'tool-pending';
    pending.textContent = '正在运行…';
    detail.append(pending);
    return;
  }
  const label = document.createElement('div');
  label.className = 'tool-result-label';
  label.textContent = '结果';
  const output = document.createElement('div');
  output.className = 'tool-result';
  output.innerHTML = renderMarkdown(String(result));
  detail.append(label, output);
}

function renderCompression(container, text = '🧹 正在压缩上下文…', done = false) {
  let list = container.querySelector('.tool-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'tool-list';
    container.insertBefore(list, container.querySelector('.bubble'));
  }
  const row = document.createElement('div');
  row.className = `tool-entry compression-entry${done ? ' done' : ''}`;
  const dot = document.createElement('i');
  dot.className = 'tool-state';
  const label = document.createElement('span');
  label.textContent = text;
  row.append(dot, label);
  list.append(row);
  autoScroll();
  return row;
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
    avatarImg.src = '/logo.png?v=13';
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
  if (!state.folders.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = '暂无工作文件夹';
    elements.sessionList.append(empty);
    return;
  }
  const defaultFolder = state.folders.find((folder) => folder.default) || state.folders[0];
  const knownIds = new Set(state.folders.map((folder) => folder.id));
  const sessionsByFolder = new Map(state.folders.map((folder) => [folder.id, []]));
  for (const session of state.sessions) {
    const folderId = knownIds.has(session.folderId) ? session.folderId : defaultFolder.id;
    sessionsByFolder.get(folderId).push(session);
  }
  const childrenByParent = new Map();
  for (const folder of state.folders) {
    const key = folder.parentId || '';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(folder);
  }
  for (const folders of childrenByParent.values()) folders.sort((left, right) => Number(right.system) - Number(left.system) || left.name.localeCompare(right.name));

  const makeSessionItem = (session) => {
    const item = document.createElement('div');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.dataset.sessionId = session.id;
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
      if (state.controller) return;
      const ok = await confirmDialog({
        title: '删除会话',
        desc: '此操作会删除该会话的全部对话记录，且无法撤销。',
        object: session.title,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await deleteSession(session.id);
    });
    item.append(copy, remove);
    item.addEventListener('click', () => { if (!state.controller) loadSession(session.id); });
    item.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !state.controller) { event.preventDefault(); loadSession(session.id); }
    });
    return item;
  };

  const appendFolder = (folder, parent, depth = 0) => {
    const group = document.createElement('section');
    group.className = 'folder-group';
    group.style.setProperty('--folder-depth', String(depth));
    const row = document.createElement('div');
    row.className = 'folder-row';
    const expanded = state.expandedFolders.has(folder.id);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'folder-toggle';
    toggle.textContent = '›';
    toggle.title = expanded ? '收起' : '展开';
    toggle.setAttribute('aria-expanded', String(expanded));
    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '📁';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'folder-name';
    name.textContent = folder.name;
    name.title = folder.path;
    const actions = document.createElement('span');
    actions.className = 'folder-actions';
    const addSession = document.createElement('button');
    addSession.type = 'button';
    addSession.className = 'folder-action folder-session-add';
    addSession.textContent = '+';
    addSession.title = '在此文件夹中新建会话';
    addSession.addEventListener('click', (event) => { event.stopPropagation(); createSession(folder.id); });
    actions.append(addSession);
    if (!folder.system) {
      const rename = document.createElement('button');
      rename.type = 'button'; rename.className = 'folder-action'; rename.textContent = '✎'; rename.title = '重命名文件夹';
      rename.addEventListener('click', (event) => { event.stopPropagation(); renameFolder(folder); });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'folder-action folder-delete'; remove.textContent = '×'; remove.title = '删除文件夹';
      remove.addEventListener('click', (event) => { event.stopPropagation(); deleteFolder(folder); });
      actions.append(rename, remove);
    }
    const toggleFolder = () => {
      if (expanded) state.expandedFolders.delete(folder.id);
      else state.expandedFolders.add(folder.id);
      renderSessionList();
    };
    toggle.addEventListener('click', toggleFolder);
    name.addEventListener('click', toggleFolder);
    row.append(toggle, icon, name, actions);
    group.append(row);
    if (expanded) {
      const contents = document.createElement('div');
      contents.className = 'folder-contents';
      const folderSessions = sessionsByFolder.get(folder.id) || [];
      for (const session of folderSessions) contents.append(makeSessionItem(session));
      const children = childrenByParent.get(folder.id) || [];
      for (const child of children) appendFolder(child, contents, depth + 1);
      if (!folderSessions.length && !children.length) {
        const empty = document.createElement('div');
        empty.className = 'folder-empty';
        empty.textContent = '暂无会话';
        contents.append(empty);
      }
      group.append(contents);
    }
    parent.append(group);
  };
  for (const folder of childrenByParent.get('') || []) appendFolder(folder, elements.sessionList);
  setStreaming(Boolean(state.controller));
}

function locateNewestSession() {
  const newest = state.sessions[0];
  if (!newest || !state.folders.length) return;
  const folder = state.folders.find((item) => item.id === newest.folderId)
    || state.folders.find((item) => item.default)
    || state.folders[0];
  const visited = new Set();
  let currentFolder = folder;
  while (currentFolder && !visited.has(currentFolder.id)) {
    visited.add(currentFolder.id);
    state.expandedFolders.add(currentFolder.id);
    currentFolder = currentFolder.parentId
      ? state.folders.find((item) => item.id === currentFolder.parentId)
      : undefined;
  }
  renderSessionList();
  requestAnimationFrame(() => {
    const item = [...elements.sessionList.querySelectorAll('.session-item')]
      .find((element) => element.dataset.sessionId === newest.id);
    item?.scrollIntoView({ block: 'nearest' });
  });
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
  const credential = state.shareToken || state.authToken;
  if (credential) headers.set('authorization', `Bearer ${credential}`);
  return { ...options, headers };
}

async function authenticatedFetch(path, options) {
  return fetch(path, authenticatedOptions(options));
}

function showLogin() {
  localStorage.removeItem('taiwei-token');
  localStorage.removeItem('taiwei-role');
  localStorage.removeItem('taiwei-username');
  localStorage.removeItem('taiwei_share_token');
  state.authToken = '';
  state.shareToken = '';
  state.role = 'admin';
  state.username = '';
  elements.body.classList.remove('guest-mode');
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

function applyRole(role, username = '') {
  state.role = role;
  state.username = username;
  localStorage.setItem('taiwei-role', role);
  if (username) localStorage.setItem('taiwei-username', username);
  else localStorage.removeItem('taiwei-username');
  const guest = role === 'guest';
  elements.body.classList.toggle('guest-mode', guest);
  elements.guestModeLabel.hidden = !guest;
  if (guest) elements.guestModeLabel.querySelector('b').textContent = username && username !== '访客' ? username : '访客';
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
  const groups = state.providers.length ? state.providers : [{ id: state.currentProvider, name: 'Default', models: state.models.map((id) => ({ id, displayName: id })) }];
  for (const provider of groups) {
    const heading = document.createElement('div');
    heading.className = 'model-provider-label'; heading.textContent = provider.name;
    elements.modelOptions.append(heading);
    for (const model of provider.models) {
    const name = model.id;
    const option = document.createElement('button');
    const active = name === state.currentModel && provider.id === state.currentProvider;
    option.type = 'button';
    option.className = `model-option${active ? ' active' : ''}`;
    option.dataset.model = name;
    option.dataset.provider = provider.id;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(active));
    option.innerHTML = `<span class="model-option-mark">${active ? '✓' : ''}</span><span>${escapeHtml(model.displayName || name)}</span>`;
    elements.modelOptions.append(option);
    }
  }
}

async function selectModel(name, provider = state.currentProvider) {
  if (state.switchingModel || (name === state.currentModel && provider === state.currentProvider)) { closeModelMenu(); return; }
  const previous = state.currentModel;
  const previousProvider = state.currentProvider;
  state.switchingModel = true;
  elements.modelSwitcher.classList.add('loading');
  elements.modelError.textContent = '';
  try {
    const result = await requestJson('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, provider, sessionId: state.current?.id }),
    });
    state.currentModel = result.current;
    state.currentProvider = result.provider || provider;
    saveLastModel(state.currentModel, state.currentProvider);
    if (state.current) { state.current.currentModel = result.current; state.current.providerId = state.currentProvider; }
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
    state.currentProvider = previousProvider;
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
  if (option) selectModel(option.dataset.model, option.dataset.provider);
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

async function refreshFolders() {
  state.folders = await requestJson('/api/folders');
  renderSessionList();
}

async function createFolder() {
  if (state.controller) return;
  const name = await promptDialog({ title: '新建文件夹', desc: '输入新文件夹名称', placeholder: '文件夹名称', okText: '创建' });
  if (name === null || !name.trim()) return;
  try {
    const folder = await requestJson('/api/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    state.expandedFolders.add(folder.id);
    await refreshFolders();
    showToast('文件夹已创建');
  } catch (error) { showToast(error.message); }
}

async function renameFolder(folder) {
  if (state.controller || folder.system) return;
  const name = await promptDialog({ title: '重命名文件夹', desc: '输入新的文件夹名称', placeholder: '文件夹名称', initial: folder.name, okText: '保存' });
  if (name === null || !name.trim() || name.trim() === folder.name) return;
  try {
    await requestJson(`/api/folders/${encodeURIComponent(folder.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    await refreshFolders();
    showToast('文件夹已重命名');
  } catch (error) { showToast(error.message); }
}

async function deleteFolder(folder) {
  if (state.controller || folder.system) return;
  const ok = await confirmDialog({
    title: '删除文件夹',
    desc: '其中的会话会移到默认文件夹，工作目录中的文件会保留。',
    object: folder.name,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await requestJson(`/api/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
    state.expandedFolders.delete(folder.id);
    await Promise.all([refreshFolders(), refreshSessions()]);
    if (state.current) await loadSession(state.current.id);
    showToast('文件夹已删除，会话已移到默认文件夹');
  } catch (error) { showToast(error.message); }
}

async function loadSession(id) {
  const version = ++state.loadVersion;
  try {
    const session = await requestJson(`/api/sessions/${encodeURIComponent(id)}`);
    if (version !== state.loadVersion) return;
    state.current = session;
    state.currentModel = session.currentModel || state.currentModel;
    state.currentProvider = session.providerId || state.currentProvider;
    state.currentAgent = session.agentId || 'build';
    elements.agentSelector.value = state.currentAgent;
    state.attachments = [];
    renderAttachments();
    renderConversation(session);
    renderModels();
    renderSessionList();
    elements.body.classList.remove('sidebar-open');
    setStatus('idle', '就绪');
  } catch (error) { showToast(error.message); }
}

async function createSession(folderId) {
  if (state.controller) return null;
  try {
    const session = await requestJson('/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        folderId,
        model: state.currentModel, provider: state.currentProvider,
      }),
    });
    state.expandedFolders.add(session.folderId);
    state.current = session;
    state.currentModel = session.currentModel || state.currentModel;
    state.currentProvider = session.providerId || state.currentProvider;
    state.currentAgent = session.agentId || 'build';
    elements.agentSelector.value = state.currentAgent;
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
  let compressionView = null;
  let compressionPreviousPromptTokens = 0;
  const clearPendingCompression = () => {
    if (compressionView && !compressionView.classList.contains('done')) {
      const list = compressionView.parentElement;
      compressionView.remove();
      if (list && !list.children.length) list.remove();
    }
    compressionView = null;
  };
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
          clearPendingCompression();
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
          clearPendingCompression();
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
            renderToolDetail(target.details.querySelector('.tool-detail'), target.call.args, item.data.result);
            if (containsMedia(item.data.result)) target.details.open = true;
          }
        } else if (item.event === 'confirm') {
          if (segmentText || answerView.stack.querySelector('.tool-list')) finalizeAssistant(answerView, segmentText);
          enqueueConfirmation(item.data, answerView);
          segmentText = '';
          answerView = addMessage({ role: 'assistant', content: '', timestamp: new Date().toISOString(), toolCalls: [] }, { streaming: true, forceScroll: true });
        } else if (item.event === 'compressing') {
          clearPendingCompression();
          compressionPreviousPromptTokens = state.usage.promptTokens || 0;
          compressionView = renderCompression(answerView.stack);
        } else if (item.event === 'usage') {
          const savedTokens = Math.max(0, compressionPreviousPromptTokens - (item.data.promptTokens || 0));
          state.usage = {
            promptTokens: item.data.promptTokens || 0,
            completionTokens: item.data.completionTokens || 0,
            totalTokens: item.data.totalTokens || 0,
            contextWindow: item.data.contextWindow || state.contextWindow,
            model: item.data.model || state.currentModel,
            compressed: item.data.compressed === true,
          };
          state.contextWindow = state.usage.contextWindow;
          state.current.usage = state.usage;
          usageCheckpoint = answer.length;
          renderUsage();
          if (item.data.compressed === true) {
            if (compressionView) compressionView.remove();
            const suffix = savedTokens > 0 ? ` · 节省约 ${savedTokens.toLocaleString()} tokens` : ` · ${formatTime(new Date().toISOString())}`;
            compressionView = renderCompression(answerView.stack, `🧹 已压缩上下文${suffix}`, true);
          } else clearPendingCompression();
        } else if (item.event === 'done') {
          clearPendingCompression();
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

elements.agentSelector.addEventListener('change', async () => {
  const previous = state.currentAgent;
  state.currentAgent = elements.agentSelector.value;
  if (!state.current) return;
  elements.agentSelector.disabled = true;
  try {
    await requestJson('/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.current.id, agentId: state.currentAgent }) });
    state.current.agentId = state.currentAgent;
  } catch (error) { state.currentAgent = previous; elements.agentSelector.value = previous; showToast(error.message); }
  finally { elements.agentSelector.disabled = false; }
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
  authenticatedFetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state.current?.id }) }).catch(() => {});
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
elements.toolsOpen.addEventListener('click', openTools);
elements.toolsClose.addEventListener('click', () => elements.toolsModal.close());
elements.memoryOpen.addEventListener('click', openMemory);
elements.memoryClose.addEventListener('click', () => elements.memoryModal.close());
elements.cronOpen.addEventListener('click', openCron);
elements.cronClose.addEventListener('click', () => elements.cronModal.close());
elements.deploymentsOpen.addEventListener('click', openDeployments);
elements.deploymentsClose.addEventListener('click', () => elements.deploymentsModal.close());
for (const modal of [elements.skillsModal, elements.knowledgeModal, elements.mcpModal, elements.toolsModal, elements.memoryModal, elements.cronModal, elements.deploymentsModal]) {
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.close(); });
}
elements.memoryContent.addEventListener('input', updateMemoryControls);
elements.memoryRefresh.addEventListener('click', loadMemory);
elements.memorySave.addEventListener('click', async () => {
  elements.memoryError.textContent = '';
  elements.memorySave.disabled = true;
  elements.memorySave.textContent = '保存中…';
  try {
    const content = elements.memoryContent.value;
    const result = await requestJson('/api/memory', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    state.savedMemory = content;
    elements.memoryStatus.textContent = `${result.chars} 字 · ${result.lines} 行`;
    setMemoryFeedback('已保存');
  } catch (error) { elements.memoryError.textContent = error.message; }
  finally { elements.memorySave.textContent = '保存'; updateMemoryControls(); }
});
elements.memoryClear.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空持久记忆',
    desc: '将删除全部核心记忆内容，此操作无法撤销。',
    object: `共 ${elements.memoryContent.value.length || 0} 字符`,
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  elements.memoryError.textContent = '';
  elements.memoryClear.disabled = true;
  try {
    await requestJson('/api/memory', { method: 'DELETE' });
    renderMemory({ content: '', chars: 0, lines: 0 });
    setMemoryFeedback('已清空');
  } catch (error) { elements.memoryError.textContent = error.message; }
  finally { elements.memoryClear.disabled = false; }
});
elements.memoryRebuild.addEventListener('click', async () => {
  elements.memoryRebuild.disabled = true; elements.memoryRebuild.textContent = '重建中…';
  try { await requestJson('/api/knowledge/rebuild', { method: 'POST' }); await loadMemory(); setMemoryFeedback('索引已重建'); }
  catch (error) { elements.memoryError.textContent = error.message; }
  finally { elements.memoryRebuild.disabled = false; elements.memoryRebuild.textContent = '重建索引'; }
});
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
elements.toolsReload.addEventListener('click', async () => {
  elements.toolsReload.disabled = true; elements.toolsReload.textContent = '应用中…';
  await loadTools(true);
  if (!elements.toolsError.textContent) showToast('工具配置已重新应用');
  elements.toolsReload.disabled = false; elements.toolsReload.textContent = '重新应用配置';
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
elements.customPromptToggle.addEventListener('click', () => {
  setSettingsCollapseOpen(elements.customPromptSettings, elements.customPromptToggle, CUSTOM_PROMPT_OPEN_STORAGE_KEY, elements.customPromptToggle.getAttribute('aria-expanded') !== 'true', true);
});
elements.workspaceToggle.addEventListener('click', () => {
  setSettingsCollapseOpen(elements.workspaceSettings, elements.workspaceToggle, WORKSPACE_OPEN_STORAGE_KEY, elements.workspaceToggle.getAttribute('aria-expanded') !== 'true', true);
});
elements.securityToggle.addEventListener('click', () => {
  setSettingsCollapseOpen(elements.securitySettings, elements.securityToggle, SECURITY_OPEN_STORAGE_KEY, elements.securityToggle.getAttribute('aria-expanded') !== 'true', true);
});
elements.hooksToggle.addEventListener('click', () => {
  setSettingsCollapseOpen(elements.hooksSettings, elements.hooksToggle, HOOKS_OPEN_STORAGE_KEY, elements.hooksToggle.getAttribute('aria-expanded') !== 'true', true);
});
elements.shareToggle.addEventListener('click', () => {
  setSettingsCollapseOpen(elements.shareSettings, elements.shareToggle, SHARE_OPEN_STORAGE_KEY, elements.shareToggle.getAttribute('aria-expanded') !== 'true', true);
});
elements.auditToggle.addEventListener('click', async () => {
  const open = elements.auditToggle.getAttribute('aria-expanded') !== 'true';
  setSettingsCollapseOpen(elements.auditSettings, elements.auditToggle, AUDIT_OPEN_STORAGE_KEY, open, true);
  if (open) await loadAudit().catch((error) => { elements.auditList.textContent = error.message; });
});
elements.auditFilter.addEventListener('input', () => { void loadAudit(); });
elements.shareCreate.addEventListener('click', async () => {
  try { await requestJson('/api/share', { method: 'POST' }); await loadSharing(); showToast('已生成新的分享链接'); }
  catch (error) { elements.settingsError.textContent = error.message; }
});
elements.shareDisable.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '关闭分享',
    desc: '关闭后，现有分享链接将立即失效。',
    okText: '关闭',
    danger: true,
  });
  if (!ok) return;
  try { await requestJson('/api/share', { method: 'DELETE' }); await loadSharing(); }
  catch (error) { elements.settingsError.textContent = error.message; }
});
elements.shareCopy.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(elements.shareUrl.value); showToast('分享链接已复制'); }
  catch { elements.shareUrl.select(); document.execCommand('copy'); }
});
elements.workspaceInput.addEventListener('input', updateWorkspaceStatus);
elements.customPromptInput.addEventListener('input', () => {
  elements.customPromptFeedback.textContent = '';
  updateCustomPromptStatus();
});
elements.customPromptSave.addEventListener('click', async () => {
  elements.settingsError.textContent = '';
  elements.customPromptFeedback.textContent = '';
  elements.customPromptSave.disabled = true;
  try {
    const result = await requestJson('/api/settings/custom-prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customPrompt: elements.customPromptInput.value }),
    });
    renderCustomPrompt(result);
    elements.customPromptFeedback.textContent = '已保存';
    showToast('自定义提示词已保存');
  } catch (error) { elements.settingsError.textContent = error.message; }
  finally { elements.customPromptSave.disabled = false; }
});
elements.customPromptClear.addEventListener('click', async () => {
  const previousValue = elements.customPromptInput.value;
  elements.customPromptInput.value = '';
  updateCustomPromptStatus();
  elements.customPromptFeedback.textContent = '';
  elements.customPromptClear.disabled = true;
  try {
    const result = await requestJson('/api/settings/custom-prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ customPrompt: '' }),
    });
    renderCustomPrompt(result);
    elements.customPromptFeedback.textContent = '已清除';
    showToast('自定义提示词已清除');
  } catch (error) {
    elements.customPromptInput.value = previousValue;
    updateCustomPromptStatus();
    elements.settingsError.textContent = error.message;
  }
  finally { elements.customPromptClear.disabled = false; }
});
elements.securityEnabled.addEventListener('change', updateSecurityStatus);
elements.patternList.addEventListener('input', updateSecurityStatus);
elements.hookFields.addEventListener('input', updateHooksStatus);
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

elements.folderAdd.addEventListener('click', createFolder);
elements.loginTabs.forEach((tab) => tab.addEventListener('click', () => {
  state.loginRole = tab.dataset.loginRole;
  elements.loginTabs.forEach((item) => item.classList.toggle('active', item === tab));
  const oauth = state.loginRole === 'guest';
  elements.loginDescription.textContent = oauth ? '使用 ai-connect 账号安全登录。' : '请输入管理员账号以继续。';
  elements.adminLoginFields.hidden = oauth;
  elements.oauthLoginPanel.hidden = !oauth;
  elements.loginSubmit.hidden = oauth;
  elements.loginError.textContent = '';
  if (oauth) elements.oauthLogin.focus();
  else elements.loginUsername.focus();
}));
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
  if (state.loginRole !== 'admin') return;
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
    state.shareToken = '';
    localStorage.removeItem('taiwei_share_token');
    localStorage.setItem('taiwei-token', body.token);
    applyRole(body.role || 'admin', body.username || elements.loginUsername.value);
    await loadChat();
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.loginPassword.select();
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = '登录';
  }
});

elements.oauthLogin.addEventListener('click', async () => {
  elements.loginError.textContent = '';
  elements.oauthLogin.disabled = true;
  elements.oauthLogin.textContent = '正在前往 ai-connect…';
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const oauthState = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    sessionStorage.setItem('taiwei-oauth-state', oauthState);
    sessionStorage.setItem('taiwei-oauth-state-expires', String(expiresAt));
    const response = await fetch('/api/oauth/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: oauthState }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.authorizeUrl) throw new Error(body.error || `无法启动 OAuth 登录 (${response.status})`);
    window.location.href = body.authorizeUrl;
  } catch (error) {
    elements.loginError.textContent = error.message;
    elements.oauthLogin.disabled = false;
    elements.oauthLogin.textContent = '通过 ai-connect 登录';
  }
});

async function logout() {
  if (state.controller) {
    await rejectPendingConfirmations();
    state.controller.abort();
    state.controller = null;
  }
  try { await authenticatedFetch('/api/logout', { method: 'POST' }); } catch {}
  state.sessions = [];
  state.current = null;
  showLogin();
}

elements.logout.addEventListener('click', logout);
elements.guestLogout.addEventListener('click', logout);

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
    if (state.role === 'guest' || state.shareToken) {
      applyRole('guest', state.username);
      const [sessions, folders, models] = await Promise.all([requestJson('/api/sessions'), requestJson('/api/folders'), modelsRequest]);
      showChat();
      state.sessions = sessions;
      state.folders = folders;
      if (!state.shareToken) {
        state.providers = models?.providers || [];
        state.models = models?.models?.length ? models.models : [state.currentModel];
        state.currentModel = models?.current || state.currentModel;
        state.currentProvider = models?.currentProvider || state.currentProvider;
        renderModels();
      } else {
        elements.modelSwitcher.hidden = true;
        elements.agentSelector.closest('.agent-switcher').hidden = true;
      }
      renderSessionList();
      if (sessions.length) {
        await loadSession(sessions[0].id);
        locateNewestSession();
      }
      else renderConversation(null);
      elements.input.focus();
      return;
    }
    const [sessions, folders, info, models] = await Promise.all([requestJson('/api/sessions'), requestJson('/api/folders'), requestJson('/api/info'), modelsRequest]);
    showChat();
    state.sessions = sessions;
    state.folders = folders;
    const username = info.username || '';
    applyRole(info.role || 'admin', username);
    const lastModel = loadLastModel();
    const savedProvider = models?.providers?.find((provider) => provider.id === lastModel?.provider);
    const savedModelIsKnown = savedProvider
      ? savedProvider.models.some((model) => model.id === lastModel?.model)
      : Boolean(lastModel && models?.models?.includes(lastModel.model));
    state.currentModel = savedModelIsKnown ? lastModel.model : models?.current || info.model || state.currentModel;
    state.currentProvider = savedModelIsKnown ? lastModel.provider || models?.currentProvider || state.currentProvider : models?.currentProvider || state.currentProvider;
    state.providers = models?.providers || [];
    state.contextWindow = info.contextWindow || state.contextWindow;
    state.workspace = info.workspace || '';
    elements.workspaceLabel.textContent = state.workspace;
    elements.workspaceLabel.title = `当前工作区：${state.workspace}`;
    state.models = models?.models?.length ? models.models : [state.currentModel];
    if (!state.models.includes(state.currentModel)) state.models.unshift(state.currentModel);
    renderModels();
    elements.usernameLabels.forEach((element) => { element.textContent = username; });
    elements.userAvatar.textContent = Array.from(username)[0]?.toUpperCase() || 'U';
    elements.userTrigger.hidden = !info.authEnabled;
    renderSessionList();
    await loadSettings();
    if (sessions.length) {
      await loadSession(sessions[0].id);
      locateNewestSession();
    }
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
  const shared = new URL(location.href).searchParams.get('share');
  if (shared) {
    state.shareToken = shared;
    state.authToken = '';
    localStorage.setItem('taiwei_share_token', shared);
    localStorage.removeItem('taiwei-token');
    localStorage.removeItem('taiwei-username');
    state.username = '';
    applyRole('guest');
    const clean = new URL(location.href); clean.searchParams.delete('share'); history.replaceState({}, '', clean);
  }
  await loadChat();
}

initialize();
