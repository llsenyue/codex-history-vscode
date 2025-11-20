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
  | { type: 'batchDeleteEmpty' }
  | { type: 'archiveToggle'; payload: { sessionId: string } };

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
      case 'archiveToggle':
        await this.handleArchive(message.payload.sessionId);
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
      
      // Get pin and archive status from cache
      const session = this.sessionsCache.find(s => s.sessionId === sessionId);
      const pinned = session?.pinned ?? false;
      const isArchived = session?.isArchived ?? false;
      
      this.panel.webview.postMessage({ 
        type: 'preview', 
        payload: { ...data, pinned, isArchived } 
      });
    } catch (error: any) {
      this.handleError(error);
      // 预览加载失败，显示错误消息在预览区，而不是清空列表
      this.panel.webview.postMessage({
        type: 'preview',
        payload: {
          messages: [{ role: 'system', text: `无法加载会话内容: ${error?.message || '未知错误'}`, timestamp: '' }],
          remark: '',
          pinned: false
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
    
    // Refresh sidebar
    this.sidebarProvider.refresh();
    
    // Refresh Webview sessions list
    await this.sendSessions(this.currentFilter);
    
    // Update preview to reflect new pin status
    await this.sendPreview(sessionId, this.currentFilter.hideAgents);
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

  private async handleArchive(sessionId: string) {
    const session = this.sessionsCache.find((s) => s.sessionId === sessionId);
    const isArchived = session?.isArchived ?? false;
    
    try {
      if (isArchived) {
        await this.manager.unarchiveSession(sessionId);
        vscode.window.showInformationMessage(`已取消归档 ${sessionId}`);
      } else {
        await this.manager.archiveSession(sessionId);
        vscode.window.showInformationMessage(`已归档 ${sessionId}`);
      }
      
      // Refresh sidebar
      this.sidebarProvider.refresh();
      
      // Refresh Webview sessions list
      await this.sendSessions(this.currentFilter);
      
      // Update preview to reflect new archive status
      await this.sendPreview(sessionId, this.currentFilter.hideAgents);
    } catch (error: any) {
      vscode.window.showErrorMessage(`归档操作失败: ${error.message}`);
    }
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

    .folded-content {
      display: none;
    }
    
    .expand-btn {
      display: block;
      width: 100%;
      padding: 4px;
      margin: 8px 0;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      cursor: pointer;
      font-size: 0.9em;
      text-align: center;
      border-radius: 2px;
    }
    
    .expand-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .preview-header-controls {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 10px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
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
      <label><input id="hideAgents" type="checkbox" checked /> 屏蔽 AGENTS.md</label>
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
            <button id="pinBtn" disabled>📌 置顶</button>
            <button id="archiveBtn" disabled>📦 归档</button>
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
    const pinBtn = document.getElementById('pinBtn');
    const archiveBtn = document.getElementById('archiveBtn');
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
      // Check if session is archived
      const session = state.sessions.find(s => s.sessionId === state.selectedId);
      if (session && session.isArchived) {
        alert('\u26a0\ufe0f \u5f52\u6863\u4f1a\u8bdd\u65e0\u6cd5 resume\uff01\n\nCodex \u7684 resume \u547d\u4ee4\u53ea\u80fd\u52a0\u8f7d sessions \u76ee\u5f55\u4e2d\u7684\u4f1a\u8bdd\u3002\u5982\u9700 resume \u6b64\u4f1a\u8bdd\uff0c\u8bf7\u5148\u70b9\u51fb\u201c\u53d6\u6d88\u5f52\u6863\u201d\u6309\u94ae\u3002');
        return;
      }
      vscode.postMessage({ type: 'copyResume', payload: { sessionId: state.selectedId } });
    }

    function resumeInTerminal() {
      if (!state.selectedId) return;
      // Check if session is archived
      const session = state.sessions.find(s => s.sessionId === state.selectedId);
      if (session && session.isArchived) {
        alert('\u26a0\ufe0f \u5f52\u6863\u4f1a\u8bdd\u65e0\u6cd5 resume\uff01\n\nCodex \u7684 resume \u547d\u4ee4\u53ea\u80fd\u52a0\u8f7d sessions \u76ee\u5f55\u4e2d\u7684\u4f1a\u8bdd\u3002\u5982\u9700 resume \u6b64\u4f1a\u8bdd\uff0c\u8bf7\u5148\u70b9\u51fb\u201c\u53d6\u6d88\u5f52\u6863\u201d\u6309\u94ae\u3002');
        return;
      }
      vscode.postMessage({ type: 'resumeInTerminal', payload: { sessionId: state.selectedId } });
    }

    function deleteSession() {
      if (state.selectedId) {
        vscode.postMessage({ type: 'deleteSession', payload: { sessionId: state.selectedId } });
      }
    }

    pinBtn.addEventListener('click', () => {
      if (state.selectedId) {
        setLoading(true);
        vscode.postMessage({ type: 'pinToggle', payload: { sessionId: state.selectedId } });
      }
    });
    
    archiveBtn.addEventListener('click', () => {
      if (state.selectedId) {
        setLoading(true);
        vscode.postMessage({ type: 'archiveToggle', payload: { sessionId: state.selectedId } });
      }
    });
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
        const pinIcon = session.pinned ? '<span style="color: var(--vscode-charts-yellow); margin-right: 4px;">⭐</span>' : '';
        const archiveBadge = session.isArchived ? '<span class="archive-badge" title="已归档">📦 归档</span>' : '';
        const subtitleHtml = subtitle ? '<span class="session-id-subtitle">' + subtitle + '</span><br>' : '';
        const remarkHtml = session.remark ? '<br><span class="remark-badge">' + session.remark + '</span>' : '';
        
        return '<div class="session' + activeClass + (session.isArchived ? ' archived-session' : '') + '" onclick="selectSession(\\'' + session.sessionId + '\\')">' +
            '<div class="title">' +
              pinIcon +
              '<span class="session-title" title="' + (session.firstText || session.sessionId) + '">' + title + '</span>' +
              archiveBadge +
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
      pinBtn.disabled = archiveBtn.disabled = saveRemarkBtn.disabled = remarkInput.disabled = !id;
      saveRemarkBtn.disabled = remarkInput.disabled = !id;
      renderSessions();
      setLoading(true);
      vscode.postMessage({ type: 'selectSession', payload: { sessionId: id, hideAgents: state.hideAgents } });
    }

    function renderPreview(data) {
      remarkInput.value = data.remark || '';
      previewEl.innerHTML = '';
      
      // Update pin button text based on pin status
      if (data.pinned) {
        pinBtn.textContent = '📌 取消置顶';
      } else {
        pinBtn.textContent = '📌 置顶';
      }
      
      // Update archive button text based on archive status
      if (data.isArchived) {
        archiveBtn.textContent = '📦 取消归档';
      } else {
        archiveBtn.textContent = '📦 归档';
      }
      
      // Add global toggle button if there are messages
      if (data.messages && data.messages.length > 0) {
        const headerControls = document.createElement('div');
        headerControls.className = 'preview-header-controls';
        
        const toggleAllBtn = document.createElement('button');
        toggleAllBtn.textContent = '全部展开/折叠';
        toggleAllBtn.className = 'expand-btn';
        toggleAllBtn.style.width = 'auto';
        toggleAllBtn.style.margin = '0';
        toggleAllBtn.onclick = () => toggleAllFolded();
        
        headerControls.appendChild(toggleAllBtn);
        previewEl.appendChild(headerControls);
      }

      if (!data.messages || data.messages.length === 0) {
        previewEl.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.6">无消息记录</div>';
        return;
      }
      data.messages.forEach(msg => {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message';
        
        const header = document.createElement('div');
        header.className = 'message-header';
        header.innerHTML = '<span>' + (msg.role === 'user' ? '👤 User' : '🤖 Assistant') + '</span>' +
                           '<span style="opacity:0.6;font-size:0.8em">' + new Date(msg.timestamp).toLocaleString() + '</span>';
        
        const body = document.createElement('div');
        body.className = 'message-body';
        
        // Handle folding for long messages
        const lines = (msg.text || '').split('\\n');
        if (lines.length > 30) {
            const first15 = lines.slice(0, 15).join('\\n');
            const last15 = lines.slice(lines.length - 15).join('\\n');
            const hiddenCount = lines.length - 30;
            const hiddenContent = lines.slice(15, lines.length - 15).join('\\n');
            
            const topPart = document.createElement('div');
            topPart.textContent = first15;
            
            const foldedPart = document.createElement('div');
            foldedPart.className = 'folded-content';
            foldedPart.textContent = '\\n' + hiddenContent + '\\n';
            
            const bottomPart = document.createElement('div');
            bottomPart.textContent = last15;
            
            const expandBtn = document.createElement('button');
            expandBtn.className = 'expand-btn';
            expandBtn.textContent = 'Show ' + hiddenCount + ' hidden lines';
            expandBtn.onclick = function() {
                const isHidden = foldedPart.style.display === 'none' || foldedPart.style.display === '';
                foldedPart.style.display = isHidden ? 'block' : 'none';
                expandBtn.textContent = isHidden ? 'Collapse' : 'Show ' + hiddenCount + ' hidden lines';
            };
            
            body.appendChild(topPart);
            body.appendChild(expandBtn);
            body.appendChild(foldedPart);
            body.appendChild(bottomPart);
        } else {
            body.textContent = msg.text || '';
        }
        
        msgDiv.appendChild(header);
        msgDiv.appendChild(body);
        previewEl.appendChild(msgDiv);
      });
    }
    
    function toggleAllFolded() {
        const foldedContents = document.querySelectorAll('.folded-content');
        const expandBtns = document.querySelectorAll('.expand-btn:not(.preview-header-controls button)');
        
        // Check state of first item to decide whether to expand or collapse all
        if (foldedContents.length === 0) return;
        
        const firstHidden = foldedContents[0].style.display === 'none' || foldedContents[0].style.display === '';
        const newState = firstHidden ? 'block' : 'none';
        
        foldedContents.forEach(el => el.style.display = newState);
        expandBtns.forEach(btn => {
            // Extract count from text
            const match = btn.textContent.match(/Show (\d+) hidden lines/);
            const count = match ? match[1] : (btn.getAttribute('data-count') || '...');
            if (match) btn.setAttribute('data-count', count);
            
            btn.textContent = newState === 'block' ? 'Collapse' : 'Show ' + (btn.getAttribute('data-count') || '...') + ' hidden lines';
        });
    }
  </script>
</body>
</html>`;
  }
}
