const state = {
  sessions: [],
  selectedId: null,
  preview: null,
};

const sessionListEl = document.getElementById('sessionsContainer');
const previewContainerEl = document.getElementById('previewContainer');
const previewMetaEl = document.getElementById('previewMeta');
const searchInput = document.getElementById('searchInput');
const pinnedOnlyCheckbox = document.getElementById('pinnedOnly');
const refreshBtn = document.getElementById('refreshBtn');
const hideAgentsCheckbox = document.getElementById('hideAgents');
const copyBtn = document.getElementById('copyBtn');
const pinBtn = document.getElementById('pinBtn');
const deleteBtn = document.getElementById('deleteBtn');
const remarkInput = document.getElementById('remarkInput');
const remarkSaveBtn = document.getElementById('remarkSaveBtn');
const remarkDisplay = document.getElementById('remarkDisplay');
const statusBar = document.getElementById('statusBar');
const confirmModal = document.getElementById('confirmModal');
const confirmMessageEl = document.getElementById('confirmMessage');
const confirmOkBtn = document.getElementById('confirmOkBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');

let searchTimer = null;

init();

function init() {
  refreshBtn.addEventListener('click', () => loadSessions());
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadSessions(), 300);
  });
  pinnedOnlyCheckbox.addEventListener('change', () => loadSessions());
  hideAgentsCheckbox.addEventListener('change', () => loadSessions());
  copyBtn.addEventListener('click', handleCopyResume);
  pinBtn.addEventListener('click', handleTogglePin);
  deleteBtn.addEventListener('click', handleDeleteSession);
  remarkSaveBtn.addEventListener('click', handleSaveRemark);
  loadSessions();
}

async function loadSessions() {
  try {
    setStatus('加载会话列表...');
    const params = new URLSearchParams();
    params.set('limit', '200');
    const keyword = searchInput.value.trim();
    if (keyword) params.set('search', keyword);
    if (pinnedOnlyCheckbox.checked) params.set('onlyPinned', 'true');
    params.set('hideAgents', hideAgentsCheckbox.checked ? 'true' : 'false');
    const sessions = await fetchJson(`/api/sessions?${params.toString()}`);
    state.sessions = sessions;
    if (!sessions.length) {
      state.selectedId = null;
      state.preview = null;
    } else if (!state.selectedId || !sessions.find((s) => s.sessionId === state.selectedId)) {
      state.selectedId = sessions[0].sessionId;
      await loadPreview(state.selectedId, { silence: true });
    }
    renderSessions();
    renderPreview();
    updateButtons();
    setStatus(`共 ${sessions.length} 条会话。`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || '加载列表失败', true);
  }
}

function renderSessions() {
  sessionListEl.innerHTML = '';
  if (!state.sessions.length) {
    sessionListEl.innerHTML = '<div class="empty">暂无会话</div>';
    return;
  }
  state.sessions.forEach((session) => {
    const row = document.createElement('button');
    row.className = `session-row${state.selectedId === session.sessionId ? ' selected' : ''}`;
    row.innerHTML = `
      <div class="session-title">
        <span class="star">${session.pinned ? '★' : ''}</span>
        <span>${session.sessionId}</span>
      </div>
      <div class="session-meta">${formatUnix(session.lastTs)} · ${escapeHtml(truncate(session.lastText || '', 80))} · 共 ${session.count} 条</div>
      <div class="session-remark">${session.remark ? escapeHtml(truncate(session.remark, 60)) : ''}</div>
    `;
    row.addEventListener('click', () => selectSession(session.sessionId));
    sessionListEl.appendChild(row);
  });
}

async function selectSession(sessionId) {
  state.selectedId = sessionId;
  renderSessions();
  updateButtons();
  await loadPreview(sessionId);
}

async function loadPreview(sessionId, { silence = false } = {}) {
  try {
    if (!silence) setStatus('加载会话消息...');
    const params = new URLSearchParams();
    params.set('limit', '200');
    params.set('hideAgents', hideAgentsCheckbox.checked ? 'true' : 'false');
    const data = await fetchJson(`/api/sessions/${sessionId}?${params.toString()}`);
    state.preview = data;
    renderPreview();
    updateButtons();
    if (!silence) setStatus(`共加载 ${data.messages.length} 条消息。`);
  } catch (error) {
    console.error(error);
    state.preview = null;
    renderPreview();
    updateButtons();
    setStatus(error.message || '加载消息失败', true);
  }
}

function renderPreview() {
  previewContainerEl.innerHTML = '';
  previewMetaEl.textContent = '';
  remarkDisplay.textContent = '';
  if (!state.selectedId) {
    previewContainerEl.innerHTML = '<div class="empty">先在左侧选择一个会话。</div>';
    remarkInput.disabled = true;
    remarkSaveBtn.disabled = true;
    return;
  }
  if (!state.preview) {
    previewContainerEl.innerHTML = '<div class="empty">正在加载或无可展示数据。</div>';
    remarkInput.disabled = true;
    remarkSaveBtn.disabled = true;
    return;
  }
  remarkInput.disabled = false;
  remarkSaveBtn.disabled = false;
  remarkInput.value = state.preview.remark || '';
  remarkDisplay.textContent = state.preview.remark ? `备注：${state.preview.remark}` : '备注：无';
  previewMetaEl.textContent = `文件：${state.preview.filePath}`;
  if (!state.preview.messages.length) {
    previewContainerEl.innerHTML = '<div class="empty">该会话暂无消息。</div>';
    return;
  }
  state.preview.messages.forEach((msg, idx) => {
    const card = document.createElement('div');
    card.className = 'message-card';
    const roleClass = msg.role === 'assistant' ? 'assistant' : 'user';
    card.innerHTML = `
      <div class="message-header ${roleClass}">[${idx + 1}] ${msg.role} · ${msg.timestamp || ''}</div>
      <div>${escapeHtml(msg.text || '(无文本)')}</div>
    `;
    previewContainerEl.appendChild(card);
  });
}

function updateButtons() {
  const selected = getSelectedSession();
  const disabled = !selected;
  copyBtn.disabled = disabled;
  pinBtn.disabled = disabled;
  deleteBtn.disabled = disabled;
  if (selected) {
    pinBtn.textContent = selected.pinned ? '取消置顶' : '置顶';
  } else {
    pinBtn.textContent = '置顶';
  }
}

async function handleCopyResume() {
  const session = getSelectedSession();
  if (!session) return;
  try {
    setStatus('生成 resume 命令...');
    const data = await fetchJson(`/api/sessions/${session.sessionId}/resume`);
    await writeClipboard(data.command);
    setStatus(`已复制：${data.command}`);
  } catch (error) {
    console.error(error);
    setStatus(error.message || '复制失败', true);
  }
}

async function handleTogglePin() {
  const session = getSelectedSession();
  if (!session) return;
  try {
    setStatus(`${session.pinned ? '取消置顶' : '置顶'}中...`);
    const endpoint = session.pinned ? 'unpin' : 'pin';
    await fetchJson(`/api/sessions/${session.sessionId}/${endpoint}`, { method: 'POST' });
    await loadSessions();
    setStatus(session.pinned ? '已取消置顶' : '已置顶');
  } catch (error) {
    console.error(error);
    setStatus(error.message || '操作失败', true);
  }
}

async function handleDeleteSession() {
  const session = getSelectedSession();
  if (!session) return;
  const confirmed = await showConfirm(`确定删除会话 ${session.sessionId} 吗？此操作会重写 history.jsonl。`);
  if (!confirmed) return;
  try {
    setStatus('删除中...');
    await fetchJson(`/api/sessions/${session.sessionId}/delete`, { method: 'POST' });
    state.preview = null;
    await loadSessions();
    setStatus('删除完成');
  } catch (error) {
    console.error(error);
    setStatus(error.message || '删除失败', true);
  }
}

async function handleSaveRemark() {
  const session = getSelectedSession();
  if (!session) return;
  try {
    setStatus('保存备注中...');
    const remark = remarkInput.value || '';
    await fetchJson(`/api/sessions/${session.sessionId}/remark`, {
      method: 'POST',
      body: JSON.stringify({ remark }),
    });
    await loadSessions();
    await loadPreview(session.sessionId, { silence: true });
    setStatus('备注已保存');
  } catch (error) {
    console.error(error);
    setStatus(error.message || '备注保存失败', true);
  }
}

function getSelectedSession() {
  if (!state.selectedId) return null;
  return state.sessions.find((s) => s.sessionId === state.selectedId) || null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    let message = '请求失败';
    try {
      const data = await response.json();
      message = data.error || message;
    } catch (e) {
      // ignore
    }
    throw new Error(message);
  }
  return response.json();
}

function setStatus(message, isError = false) {
  statusBar.textContent = message;
  statusBar.style.color = isError ? '#ff6b6b' : '#8fffb5';
}

function formatUnix(ts) {
  if (!ts) return '';
  const date = new Date(ts * 1000);
  return date.toLocaleString();
}

function truncate(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function showConfirm(message) {
  return new Promise((resolve) => {
    confirmMessageEl.textContent = message;
    confirmModal.classList.remove('hidden');

    const cleanup = (result) => {
      confirmModal.classList.add('hidden');
      confirmOkBtn.removeEventListener('click', onOk);
      confirmCancelBtn.removeEventListener('click', onCancel);
      confirmModal.removeEventListener('click', onBackdrop);
      resolve(result);
    };

    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (event) => {
      if (event.target === confirmModal) {
        cleanup(false);
      }
    };

    confirmOkBtn.addEventListener('click', onOk);
    confirmCancelBtn.addEventListener('click', onCancel);
    confirmModal.addEventListener('click', onBackdrop);
  });
}
