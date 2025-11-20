import * as vscode from 'vscode';
import { HistoryManager, SessionSummary, SessionMessage } from './core/historyManager';
import { StateStore } from './core/state';
import { buildPaths, ensureManagerDirs } from './core/paths';

import { SidebarProvider } from './sidebarProvider';

export async function activate(context: vscode.ExtensionContext) {
  const manager = await createHistoryManager();
  
  const sidebarProvider = new SidebarProvider(manager);
  const treeView = vscode.window.createTreeView('codexHistory.sidebar', { treeDataProvider: sidebarProvider });
  
  context.subscriptions.push(
    vscode.commands.registerCommand('codexHistory.refreshSidebar', () => {
      sidebarProvider.refresh();
      if (HistoryWebviewPanel.currentPanel) {
        HistoryWebviewPanel.currentPanel.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codexHistory.resumeInTerminal', async (item: any) => {
      // item 可以是 Sidebar 的 SessionItem，也可以是 Webview 传来的 sessionId 字符串
      let sessionId: string | undefined;
      if (typeof item === 'string') {
        sessionId = item;
      } else if (item && item.session && item.session.sessionId) {
        sessionId = item.session.sessionId;
      }

      if (!sessionId) {
        vscode.window.showErrorMessage('无法获取会话 ID');
        return;
      }

      const terminalName = 'Codex CLI';
      let terminal = vscode.window.terminals.find(t => t.name === terminalName);
      if (!terminal) {
        terminal = vscode.window.createTerminal(terminalName);
      }

      terminal.show();
      // 获取 resume 命令
      const cmd = await manager.getResumeCommand(sessionId);
      terminal.sendText(cmd);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codexHistory.rebuildIndex', async () => {
        const answer = await vscode.window.showWarningMessage(
            '确定要重建索引吗？这将扫描所有会话文件并重写历史记录列表。',
            '确定', '取消'
        );
        if (answer === '确定') {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "正在重建索引...",
                cancellable: false
            }, async (progress) => {
                await manager.rebuildIndex(progress);
                sidebarProvider.refresh();
                if (HistoryWebviewPanel.currentPanel) {
                    HistoryWebviewPanel.currentPanel.refresh();
                }
                vscode.window.showInformationMessage('索引重建完成');
            });
        }
    })
  );

  const command = vscode.commands.registerCommand('codexHistory.openManager', (sessionId?: string) => {
    HistoryWebviewPanel.createOrShow(context, manager, sidebarProvider, treeView, sessionId);
  });

  context.subscriptions.push(command);
}

export function deactivate() {}

async function createHistoryManager(): Promise<HistoryManager> {
  const config = vscode.workspace.getConfiguration('codexHistory');
  const customHome = config.get<string>('codexHome');
  
  // 如果配置了路径，且不为空字符串，则使用配置的路径
  const paths = buildPaths(customHome || undefined);
  await ensureManagerDirs(paths);
  const state = new StateStore(paths);
  await state.load();
  return new HistoryManager(paths, state);
}

type PanelMessage =
  | { type: 'ready' }
  | { type: 'fetchSessions'; payload: { limit: number; search?: string; pinnedOnly?: boolean; hideAgents: boolean } }
  | { type: 'selectSession'; payload: { sessionId: string; hideAgents: boolean } }
  | { type: 'copyResume'; payload: { sessionId: string } }
  | { type: 'pinToggle'; payload: { sessionId: string } }
  | { type: 'deleteSession'; payload: { sessionId: string } }
  | { type: 'saveRemark'; payload: { sessionId: string; remark: string } }
  | { type: 'resumeInTerminal'; payload: { sessionId: string } }
  | { type: 'batchDeleteEmpty' };

class HistoryWebviewPanel {
  public static currentPanel: HistoryWebviewPanel | undefined;
  private sessionsCache: SessionSummary[] = [];
  private currentFilter: { limit: number; search?: string; pinnedOnly?: boolean; hideAgents: boolean } = {
    limit: 50,
    hideAgents: true,
  };

  private constructor(
    private readonly panel: vscode.WebviewPanel, 
    private readonly manager: HistoryManager,
    private readonly sidebarProvider: SidebarProvider,
    private readonly treeView: vscode.TreeView<any>
  ) {
    this.panel.webview.onDidReceiveMessage((msg: PanelMessage) => {
      this.onMessage(msg).catch((err) => this.handleError(err));
    });
  }

  static createOrShow(context: vscode.ExtensionContext, manager: HistoryManager, sidebarProvider: SidebarProvider, treeView: vscode.TreeView<any>, initialSessionId?: string) {
    if (HistoryWebviewPanel.currentPanel) {
      HistoryWebviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      if (initialSessionId) {
        HistoryWebviewPanel.currentPanel.sendPreview(initialSessionId, true);
        // Sync selection in list
        HistoryWebviewPanel.currentPanel.panel.webview.postMessage({ type: 'selectSession', payload: { sessionId: initialSessionId } });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel('codexHistoryPanel', 'Codex 历史管理', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });

    const instance = new HistoryWebviewPanel(panel, manager, sidebarProvider, treeView);
    HistoryWebviewPanel.currentPanel = instance;
    
    if (initialSessionId) {
      // 等待前端准备好后再发送
      // 这里通过 ready 消息来触发，或者简单延迟一下
      setTimeout(() => {
        instance.sendPreview(initialSessionId, true);
        instance.panel.webview.postMessage({ type: 'selectSession', payload: { sessionId: initialSessionId } });
      }, 500);
    }

    panel.onDidDispose(() => {
      HistoryWebviewPanel.currentPanel = undefined;
    });

    panel.webview.html = instance.getHtml();
  }

  public refresh() {
    this.panel.webview.postMessage({ type: 'refresh' });
  }

  private async onMessage(message: PanelMessage) {
    switch (message.type) {
      case 'ready':
        await this.sendSessions({ limit: 50, hideAgents: true });
        break;
      case 'fetchSessions':
        await this.sendSessions(message.payload);
        break;
      case 'selectSession':
        await this.sendPreview(message.payload.sessionId, message.payload.hideAgents);
        // Sync to sidebar
        const item = this.sidebarProvider.getItem(message.payload.sessionId);
        if (item) {
            try {
                this.treeView.reveal(item, { select: true, focus: false, expand: false });
            } catch (e) {
                console.error('[Extension] Failed to reveal in sidebar:', e);
            }
        }
        break;
      case 'copyResume':
        const cmd = await this.manager.getResumeCommand(message.payload.sessionId);
        await vscode.env.clipboard.writeText(cmd);
        vscode.window.showInformationMessage('Resume 命令已复制到剪贴板');
        break;
      case 'pinToggle':
        await this.handlePin(message.payload.sessionId);
        break;
      case 'deleteSession':
        await this.handleDelete(message.payload.sessionId);
        break;
      case 'resumeInTerminal':
        await this.handleResumeInTerminal(message.payload.sessionId);
        break;
      case 'batchDeleteEmpty':
        await this.handleBatchDeleteEmpty();
        break;
      case 'saveRemark':
        await this.handleRemark(message.payload.sessionId, message.payload.remark);
        break;
      default:
        break;
    }
  }

  private async sendSessions(options: { limit: number; search?: string; pinnedOnly?: boolean; hideAgents: boolean }) {
    try {
      this.currentFilter = { ...options };
      const sessions = await this.manager.listSummaries({
        limit: options.limit,
        search: options.search,
        onlyPinned: options.pinnedOnly,
        hideAgents: options.hideAgents,
      });
      this.sessionsCache = sessions;
      console.log(`[Extension] Sending ${sessions.length} sessions to Webview`);
      const success = await this.panel.webview.postMessage({ type: 'sessions', payload: sessions });
      console.log(`[Extension] postMessage result: ${success}`);
    } catch (error: any) {
      console.error('[Extension] sendSessions error:', error);
      this.handleError(error);
      // 列表加载失败，才在 Webview 显示错误
      this.panel.webview.postMessage({ type: 'error', payload: error?.message || '加载失败' });
    }
  }

  private async sendPreview(sessionId: string, hideAgents: boolean) {
    try {
      const data = await this.manager.readSessionMessages(sessionId, { limit: 200, hideAgents });
      this.panel.webview.postMessage({ type: 'preview', payload: data });
    } catch (error: any) {
      this.handleError(error);
      // 预览加载失败，显示错误消息在预览区，而不是清空列表
      this.panel.webview.postMessage({
        type: 'preview',
        payload: {
          messages: [{ role: 'system', text: `无法加载会话内容: ${error?.message || '未知错误'}`, timestamp: '' }],
          remark: ''
        }
      });
    }
  }

  // ... (handlers)

  private async handlePin(sessionId: string) {
    const pinned = this.sessionsCache.find((s) => s.sessionId === sessionId)?.pinned ?? false;
    if (pinned) {
      await this.manager.unpin(sessionId);
      vscode.window.showInformationMessage(`已取消置顶 ${sessionId}`);
    } else {
      await this.manager.pin(sessionId);
      vscode.window.showInformationMessage(`已置顶 ${sessionId}`);
    }
    await this.sendSessions(this.currentFilter);
  }

  private async handleDelete(sessionId: string) {
    const confirm = await vscode.window.showWarningMessage(
      `确定删除会话 ${sessionId} 吗？此操作会重写 history.jsonl。`,
      { modal: true },
      '删除'
    );
    if (confirm !== '删除') {
      return;
    }
    
    // Find current index for auto-selection after delete
    const currentIndex = this.sessionsCache.findIndex(s => s.sessionId === sessionId);
    
    await this.manager.deleteSessions([sessionId], { backupHistory: true });
    vscode.window.showInformationMessage(`已删除 ${sessionId}`);
    
    // Refresh sidebar
    this.sidebarProvider.refresh();
    
    // Refresh sessions
    await this.sendSessions(this.currentFilter);
    
    // Auto-select next session
    if (this.sessionsCache.length > 0) {
      let nextSessionId: string;
      if (currentIndex < this.sessionsCache.length) {
        nextSessionId = this.sessionsCache[currentIndex].sessionId;
      } else {
        nextSessionId = this.sessionsCache[this.sessionsCache.length - 1].sessionId;
      }
      this.panel.webview.postMessage({
        type: 'autoSelectSession',
        payload: { sessionId: nextSessionId }
      });
    }
  }

  private async handleResumeInTerminal(sessionId: string) {
    const cmd = await this.manager.getResumeCommand(sessionId);
    const terminal = vscode.window.createTerminal('Codex Resume');
    terminal.show();
    terminal.sendText(cmd);
  }

  private async handleBatchDeleteEmpty() {
    // Get ALL sessions, not just the current filtered view
    const summaries = await this.manager.listSummaries({ limit: 1000, hideAgents: true });
    const emptySessions = summaries.filter(s => 
      s.firstText === '(空会话)' || !s.firstText || s.firstText.trim() === ''
    );
    
    if (emptySessions.length === 0) {
      vscode.window.showInformationMessage('没有找到空会话');
      return;
    }
    
    // Use VS Code confirmation dialog instead of webview confirm
    const confirm = await vscode.window.showWarningMessage(
      `确定要删除 ${emptySessions.length} 个空会话吗？此操作不可恢复。`,
      { modal: true },
      '删除'
    );
    
    if (confirm === '删除') {
      const sessionIds = emptySessions.map(s => s.sessionId);
      await this.manager.deleteSessions(sessionIds, { backupHistory: true });
      
      vscode.window.showInformationMessage(`已删除 ${emptySessions.length} 个空会话`);
      
      // Refresh sidebar
      this.sidebarProvider.refresh();
      
      await this.sendSessions(this.currentFilter);
    }
  }



  private async handleRemark(sessionId: string, remark: string) {
    await this.manager.setRemark(sessionId, remark);
    vscode.window.showInformationMessage('备注已保存');
    
    // Refresh sidebar to show updated remark
    this.sidebarProvider.refresh();
    
    await this.sendSessions(this.currentFilter);
  }

  private handleError(error: any) {
    const msg = typeof error === 'string' ? error : error?.message ?? '未知错误';
    vscode.window.showErrorMessage(`Codex 历史管理：${msg}`);
  }

  private getHtml(): string {
    const nonce = Date.now().toString();
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    :root {
      --container-padding: 20px;
      --input-padding-vertical: 6px;
      --input-padding-horizontal: 11px;
      --input-margin-vertical: 4px;
      --input-margin-horizontal: 4px;
    }

    body {
      font-family: var(--vscode-font-family);
      font-weight: var(--vscode-font-weight);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 0;
      margin: 0;
    }

    .layout {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    .controls {
      padding: 10px;
      display: flex;
      gap: 10px;
      align-items: center;
      background-color: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    .controls input[type="text"] {
      flex: 1;
      padding: var(--input-padding-vertical) var(--input-padding-horizontal);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
      outline: none;
    }

    .controls input[type="text"]:focus {
      border-color: var(--vscode-focusBorder);
    }

    .controls button, .buttons button {
      padding: var(--input-padding-vertical) var(--input-padding-horizontal);
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      outline: none;
    }

    .controls button:hover, .buttons button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .controls button:disabled, .buttons button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .controls label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-size: 0.9em;
    }

    .content {
      flex: 1;
      display: grid;
      grid-template-columns: 300px 1fr;
      overflow: hidden;
    }

    .panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-right: 1px solid var(--vscode-panel-border);
    }

    .panel:last-child {
      border-right: none;
      padding: 10px;
      background-color: var(--vscode-editor-background);
    }

    .session-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    .session-id-subtitle {
      font-family: monospace;
      opacity: 0.8;
      font-size: 10px;
    }
    .remark-badge {
      display: inline-block;
      background-color: var(--vscode-textLink-foreground);
      color: var(--vscode-editor-background);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 0.85em;
      font-weight: bold;
      margin-left: 8px;
      vertical-align: middle;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    }

    .list {
      flex: 1;
      overflow-y: auto;
      padding: 0;
    }

    .session {
      padding: 8px 10px;
      cursor: pointer;
      border-bottom: 1px solid var(--vscode-panel-border);
      transition: background-color 0.1s;
    }

    .session:hover {
      background-color: var(--vscode-list-hoverBackground);
    }

    .session.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .session .title {
      font-weight: bold;
      margin-bottom: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .session .meta {
      font-size: 0.85em;
      opacity: 0.8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .archive-badge {
      display: inline-block;
      background-color: var(--vscode-charts-orange);
      color: var(--vscode-editor-background);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.7em;
      font-weight: bold;
      margin-left: 6px;
      opacity: 0.9;
    }

    .session.archived-session {
      border-left: 3px solid var(--vscode-charts-orange);
      background-color: rgba(255, 165, 0, 0.05);
    }

    .session.archived-session:hover {
      background-color: rgba(255, 165, 0, 0.1);
    }

    .session.archived-session.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .preview-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 10px;
    }

    .buttons {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .remark-group {
      display: flex;
      gap: 8px;
    }

    .remark-group input {
      flex: 1;
      padding: var(--input-padding-vertical) var(--input-padding-horizontal);
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 2px;
    }

    .preview {
      flex: 1;
      overflow-y: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px;
      background-color: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }

    .message {
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .message:last-child {
      border-bottom: none;
    }

    .message-header {
      font-weight: bold;
      margin-bottom: 6px;
      color: var(--vscode-textPreformat-foreground);
      display: flex;
      justify-content: space-between;
      font-size: 0.9em;
    }

    .message-body {
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.5;
    }

    .loading-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.2);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 999;
      display: none;
    }

    .loading-overlay.visible {
      display: flex;
    }

    .spinner {
      border: 4px solid var(--vscode-progressBar-background);
      border-top: 4px solid var(--vscode-editor-background);
      border-radius: 50%;
      width: 30px;
      height: 30px;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="layout">
    <div class="loading-overlay" id="loadingOverlay">
      <div class="spinner"></div>
    </div>
    <div class="controls">
      <input id="searchInput" type="text" placeholder="搜索会话..." />
      <label><input id="pinnedOnly" type="checkbox" /> 仅置顶</label>
      <label><input id="hideAgents" type="checkbox" checked /> 屏蔽 Agents</label>
      <button id="refreshBtn">刷新</button>
      <button id="batchDeleteEmptyBtn" style="background-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background);">批量删除空会话</button>
    </div>
    <div class="content">
      <div class="panel">
        <div class="list" id="sessionList"></div>
      </div>
      <div class="panel">
        <div class="preview-container">
          <div class="buttons">
            <button onclick="copyResumeCommand()">复制 Resume 命令</button>
            <button onclick="resumeInTerminal()">在终端恢复 ▶️</button>
            <button onclick="deleteSession()" style="background-color: var(--vscode-errorForeground); color: var(--vscode-editor-background);">删除会话</button>
          </div>
          <div class="remark-group">
            <input id="remarkInput" type="text" placeholder="添加备注..." disabled />
            <button id="saveRemarkBtn" disabled>保存</button>
          </div>
          <div class="preview" id="preview">
            <div style="padding: 20px; text-align: center; opacity: 0.6;">请选择左侧会话查看详情</div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { sessions: [], selectedId: null, hideAgents: true };
    const sessionList = document.getElementById('sessionList');
    const previewEl = document.getElementById('preview');
    const searchInput = document.getElementById('searchInput');
    const pinnedOnly = document.getElementById('pinnedOnly');
    const hideAgents = document.getElementById('hideAgents');
    const refreshBtn = document.getElementById('refreshBtn');
    const batchDeleteEmptyBtn = document.getElementById('batchDeleteEmptyBtn');
    // const copyBtn = document.getElementById('copyBtn'); // Removed
    // const pinBtn = document = document.getElementById('pinBtn');   // Removed
    // const deleteBtn = document.getElementById('deleteBtn'); // Removed
    const remarkInput = document.getElementById('remarkInput');
    const saveRemarkBtn = document.getElementById('saveRemarkBtn');
    const loadingOverlay = document.getElementById('loadingOverlay');

    function setLoading(isLoading) {
      if (isLoading) loadingOverlay.classList.add('visible');
      else loadingOverlay.classList.remove('visible');
    }

    vscode.postMessage({ type: 'ready' });

    refreshBtn.addEventListener('click', () => { setLoading(true); fetchSessions(); });
    batchDeleteEmptyBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'batchDeleteEmpty' });
    });
    searchInput.addEventListener('input', () => setTimeout(() => { setLoading(true); fetchSessions(); }, 500));
    pinnedOnly.addEventListener('change', () => { setLoading(true); fetchSessions(); });
    hideAgents.addEventListener('change', () => { 
      state.hideAgents = hideAgents.checked; 
      setLoading(true); 
      if (state.selectedId) {
        vscode.postMessage({ type: 'selectSession', payload: { sessionId: state.selectedId, hideAgents: state.hideAgents } });
      }
      fetchSessions(); 
    });

    // Add keyboard event listener for Delete key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && state.selectedId) {
        deleteSession();
      }
    });

    function copyResumeCommand() {
      if (!state.selectedId) return;
      vscode.postMessage({ type: 'copyResume', payload: { sessionId: state.selectedId } });
    }

    function resumeInTerminal() {
      if (!state.selectedId) return;
      vscode.postMessage({ type: 'resumeInTerminal', payload: { sessionId: state.selectedId } });
    }

    function deleteSession() {
      if (state.selectedId) {
        vscode.postMessage({ type: 'deleteSession', payload: { sessionId: state.selectedId } });
      }
    }

    /* pinBtn removed
    pinBtn.addEventListener('click', () => {
      if (state.selectedId) {
        setLoading(true);
        vscode.postMessage({ type: 'pinToggle', payload: { sessionId: state.selectedId } });
      }
    });
    */
    saveRemarkBtn.addEventListener('click', () => {
      if (!state.selectedId) return;
      setLoading(true);
      vscode.postMessage({ type: 'saveRemark', payload: { sessionId: state.selectedId, remark: remarkInput.value || '' } });
    });

    // Add keyboard shortcut for remark input (Enter or Ctrl+Enter)
    remarkInput.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' && e.ctrlKey) || e.key === 'Enter') {
        e.preventDefault();
        if (!state.selectedId) return;
        setLoading(true);
        vscode.postMessage({ type: 'saveRemark', payload: { sessionId: state.selectedId, remark: remarkInput.value || '' } });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      console.log('[Webview] Received message:', message.type);
      setLoading(false);
      if (message.type === 'sessions') {
        console.log('[Webview] Sessions payload length:', message.payload.length);
        state.sessions = message.payload;
        renderSessions();
      } else if (message.type === 'preview') {
        renderPreview(message.payload);
      } else if (message.type === 'error') {
        sessionList.innerHTML = '<div style="padding:10px;color:var(--vscode-errorForeground)">加载失败: ' + message.payload + '</div>';
      } else if (message.type === 'autoSelectSession') {
        // Auto-select session after deletion
        state.selectedId = message.payload.sessionId;
        renderSessions();
        vscode.postMessage({ type: 'selectSession', payload: { sessionId: state.selectedId, hideAgents: state.hideAgents } });
      } else if (message.type === 'selectSession') {
        // Handle selection from sidebar
        state.selectedId = message.payload.sessionId;
        renderSessions();
        // Scroll to selected item
        setTimeout(() => {
          const selectedEl = document.querySelector('.session.selected');
          if (selectedEl) {
            selectedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      } else if (message.type === 'refresh') {
        fetchSessions();
      }
    });

    function fetchSessions() {
      vscode.postMessage({
        type: 'fetchSessions',
        payload: { limit: 1000, search: searchInput.value.trim(), pinnedOnly: pinnedOnly.checked, hideAgents: hideAgents.checked }
      });
    }

    function renderSessions() {
      sessionList.innerHTML = '';
      if (state.sessions.length === 0) {
        sessionList.innerHTML = '<div style="padding:10px;opacity:0.6;text-align:center">暂无会话</div>';
        return;
      }
      const listHtml = state.sessions.map(session => {
        const dateStr = new Date(session.lastTs * 1000).toLocaleString();
        const activeClass = session.sessionId === state.selectedId ? ' selected' : '';
        // Use firstText as title if available, otherwise sessionId
        const title = session.firstText ? (session.firstText.length > 50 ? session.firstText.substring(0, 50) + '...' : session.firstText) : session.sessionId;
        const subtitle = session.firstText ? session.sessionId : '';
        const pinIcon = session.pinned ? '<span class="codicon codicon-pin"></span>' : '';
        const archiveBadge = session.isArchived ? '<span class="archive-badge" title="已归档">📦 归档</span>' : '';
        const subtitleHtml = subtitle ? '<span class="session-id-subtitle">' + subtitle + '</span><br>' : '';
        const remarkHtml = session.remark ? '<br><span class="remark-badge">' + session.remark + '</span>' : '';
        
        return '<div class="session' + activeClass + (session.isArchived ? ' archived-session' : '') + '" onclick="selectSession(\\'' + session.sessionId + '\\')">' +
            '<div class="title">' +
              '<span class="session-title" title="' + (session.firstText || session.sessionId) + '">' + title + '</span>' +
              pinIcon + archiveBadge +
            '</div>' +
            '<div class="meta">' +
              subtitleHtml +
              dateStr + ' · <span class="turn-count"><strong>' + session.count + '</strong> 轮对话</span>' +
              remarkHtml +
            '</div>' +
          '</div>';
      }).join('');
      sessionList.innerHTML = listHtml;
    }

    function selectSession(id) {
      state.selectedId = id;
      // copyBtn.disabled = pinBtn.disabled = deleteBtn.disabled = saveRemarkBtn.disabled = remarkInput.disabled = !id;
      saveRemarkBtn.disabled = remarkInput.disabled = !id;
      renderSessions();
      setLoading(true);
      vscode.postMessage({ type: 'selectSession', payload: { sessionId: id, hideAgents: state.hideAgents } });
    }

    function renderPreview(data) {
      remarkInput.value = data.remark || '';
      previewEl.innerHTML = '';
      if (!data.messages || data.messages.length === 0) {
        previewEl.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.6">无消息记录</div>';
        return;
      }
      data.messages.forEach((msg, idx) => {
        const node = document.createElement('div');
        node.className = 'message';
        
        const header = document.createElement('div');
        header.className = 'message-header';
        header.innerHTML = \`<span>#\${idx + 1} \${msg.role}</span><span>\${msg.timestamp || ''}</span>\`;
        
        const body = document.createElement('div');
        body.className = 'message-body';
        body.textContent = msg.text || '';
        
        node.appendChild(header);
        node.appendChild(body);
        previewEl.appendChild(node);
      });
    }
  <\/script>
</body>
</html>`;
  }
}
