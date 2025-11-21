import * as vscode from 'vscode';
import { HistoryManager, SessionSummary, SessionMessage } from './core/historyManager';
import { StateStore } from './core/state';
import { buildPaths, ensureManagerDirs } from './core/paths';
import fs from 'fs-extra';

import { SidebarProvider } from './sidebarProvider';

export async function activate(context: vscode.ExtensionContext) {
  const manager = await createHistoryManager();
  
  const sidebarProvider = new SidebarProvider(manager);
  const treeView = vscode.window.createTreeView('codexHistory.sidebar', { 
    treeDataProvider: sidebarProvider,
    manageCheckboxStateManually: true,
    canSelectMany: false
  });
  
  context.subscriptions.push(
    vscode.commands.registerCommand('codexHistory.refreshSidebar', async () => {
      // Check for new session files and add them to index
      await manager.checkForNewSessions();
      
      // Refresh UI
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
      
      // Check if session is archived
      const summaries = await manager.listSummaries({ hideAgents: true, limit: 1000 });
      const session = summaries.find(s => s.sessionId === sessionId);
      if (session?.isArchived) {
        vscode.window.showWarningMessage(
          '⚠️ 归档会话无法 resume！\n\nCodex 的 resume 命令只能加载 sessions 目录中的会话。如需 resume 此会话，请先取消归档。',
          { modal: true }
        );
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

  const command = vscode.commands.registerCommand('codexHistory.openManager', async (sessionId?: string) => {
    await HistoryWebviewPanel.createOrShow(context, manager, sidebarProvider, treeView, sessionId);
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
  const manager = new HistoryManager(paths, state);
  
  // Auto-index on first launch if history.jsonl doesn't exist or is empty
  await manager.autoIndexIfNeeded();
  
  return manager;
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
  | { type: 'fetchRecycleBin' }
  | { type: 'fetchRecycleBinSession'; payload: { sessionId: string } }
  | { type: 'restoreSession'; payload: { sessionId: string } }
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

  static async createOrShow(context: vscode.ExtensionContext, manager: HistoryManager, sidebarProvider: SidebarProvider, treeView: vscode.TreeView<any>, initialSessionId?: string) {
    // Check for new sessions whenever Webview is opened
    await manager.checkForNewSessions();
    
    if (HistoryWebviewPanel.currentPanel) {
      HistoryWebviewPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      
      // Refresh to show any new sessions
      HistoryWebviewPanel.currentPanel.refresh();
      
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
        // Sync to sidebar - DISABLED to prevent scroll issues
        // const item = this.sidebarProvider.getItem(message.payload.sessionId);
        // if (item) {
        //     try {
        //         this.treeView.reveal(item, { select: true, focus: false, expand: false });
        //     } catch (e) {
        //         console.error('[Extension] Failed to reveal in sidebar:', e);
        //     }
        // }
        break;
      case 'copyResume':
        // Check if session is archived
        const resumeSession = this.sessionsCache.find(s => s.sessionId === message.payload.sessionId);
        if (resumeSession?.isArchived) {
          vscode.window.showWarningMessage(
            '⚠️ 归档会话无法 resume！\n\nCodex 的 resume 命令只能加载 sessions 目录中的会话。如需 resume 此会话，请先取消归档。',
            { modal: true }
          );
          break;
        }
        const resumeCmd = await this.manager.getResumeCommand(message.payload.sessionId);
        await vscode.env.clipboard.writeText(resumeCmd);
        // No notification - user gets feedback from clipboard
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
      case 'fetchRecycleBin':
        await this.sendRecycleBin();
        break;
      case 'fetchRecycleBinSession':
        await this.sendRecycleBinSession(message.payload.sessionId);
        break;
      case 'restoreSession':
        await this.handleRestore(message.payload.sessionId);
        break;
      default:
        break;
    }
  }

  private async sendRecycleBin() {
    try {
      const sessions = await this.manager.listRecycleBin();
      this.panel.webview.postMessage({ type: 'recycleBin', payload: sessions });
    } catch (error: any) {
      this.handleError(error);
    }
  }

  private async sendRecycleBinSession(sessionId: string) {
    try {
      const lines = await this.manager.getRecycleBinSessionContent(sessionId);
      const content = lines.map(line => {
        // Simple markdown to HTML conversion for preview
        let html = line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        
        // Highlight headers
        if (html.includes('**User**')) {
          return `<div class="msg-user">${html.replace('**User**', 'User')}</div>`;
        } else if (html.includes('**Model**')) {
          return `<div class="msg-model">${html.replace('**Model**', 'Model')}</div>`;
        }
        return `<div>${html}</div>`;
      }).join('');
      
      this.panel.webview.postMessage({ type: 'recycleBinPreview', payload: content });
    } catch (error: any) {
      this.panel.webview.postMessage({ type: 'error', payload: error.message });
    }
  }

  private async handleRestore(sessionId: string) {
    try {
      await this.manager.restoreFromRecycleBin(sessionId);
      vscode.window.showInformationMessage(`会话 ${sessionId} 已还原`);
      
      // Refresh recycle bin
      await this.sendRecycleBin();
      
      // Refresh main list
      await this.sendSessions(this.currentFilter);
      this.sidebarProvider.refresh();
      
    } catch (error: any) {
      vscode.window.showErrorMessage(`还原失败: ${error.message}`);
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
      // No notification - visual feedback from UI refresh is sufficient
    } else {
      await this.manager.pin(sessionId);
      // No notification - visual feedback from UI refresh is sufficient
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
    // No notification - visual feedback from list update is sufficient
    
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
    // Check if session is archived
    const summaries = await this.manager.listSummaries({ hideAgents: true, limit: 1000 });
    const session = summaries.find(s => s.sessionId === sessionId);
    if (session?.isArchived) {
      vscode.window.showWarningMessage(
        '⚠️ 归档会话无法 resume！\n\nCodex 的 resume 命令只能加载 sessions 目录中的会话。如需 resume 此会话，请先取消归档。',
        { modal: true }
      );
      return;
    }

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
      // Safety check: verify file sizes before deleting
      // If a file is > 200 bytes, it's likely not empty and was mislabeled
      const safeSessionIds: string[] = [];
      let skippedCount = 0;

      for (const session of emptySessions) {
        const file = await this.manager.findSessionFile(session.sessionId);
        if (file) {
          try {
            const stats = await fs.stat(file);
            
            // Trust turn_count=0 as empty (ignore file size, as it may contain system prompt/AGENTS.md)
            if ((session.count || 0) === 0) {
               safeSessionIds.push(session.sessionId);
               continue;
            }
            
            // For sessions with turns > 0, use a larger threshold (2KB) as a safety guard
            // This prevents deleting sessions that might have valid content but were parsed incorrectly
            if (stats.size > 2048) {
              console.warn(`[BatchDelete] Skipping session ${session.sessionId} because turn_count=${session.count} and file size is ${stats.size} bytes`);
              skippedCount++;
              continue;
            }
            safeSessionIds.push(session.sessionId);
          } catch (e) {
            // If we can't stat the file, skip it to be safe
            skippedCount++;
          }
        }
      }

      if (safeSessionIds.length === 0) {
        vscode.window.showWarningMessage(`操作已取消：所有选中的会话文件大小都超过阈值，可能包含有效数据。请尝试重建索引。`);
        return;
      }

      await this.manager.deleteSessions(safeSessionIds, { backupHistory: true });
      
      if (skippedCount > 0) {
        vscode.window.showInformationMessage(`已删除 ${safeSessionIds.length} 个空会话，跳过 ${skippedCount} 个疑似非空会话`);
      } else {
        vscode.window.showInformationMessage(`已删除 ${safeSessionIds.length} 个空会话`);
      }
      
      // Refresh sidebar
      this.sidebarProvider.refresh();
      
      await this.sendSessions(this.currentFilter);
    }
  }



  private async handleRemark(sessionId: string, remark: string) {
    await this.manager.setRemark(sessionId, remark);
    // No notification - user gets feedback from button/input interaction
    
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
        // No notification - visual feedback from UI refresh is sufficient
      } else {
        await this.manager.archiveSession(sessionId);
        // No notification - visual feedback from UI refresh is sufficient
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
      width: 100%;
      overflow: hidden;
      position: relative; /* Ensure children respect boundaries */
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
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0; /* Critical: allow flex item to shrink below content size */
    }

    .tabs {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border);
      background-color: var(--vscode-sideBar-background);
    }

    .tab {
      padding: 8px 16px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      opacity: 0.7;
      transition: all 0.2s;
    }

    .tab:hover {
      opacity: 1;
      background-color: var(--vscode-list-hoverBackground);
    }

    .tab.active {
      border-bottom-color: var(--vscode-activityBar-foreground);
      font-weight: bold;
      opacity: 1;
    }

    .view-container {
      flex: 1;
      display: none;
      overflow: hidden;
      min-height: 0; /* Critical: allow flex item to shrink */
    }

    .view-container.active {
      display: grid;
      grid-template-columns: 300px 1fr;
      height: 100%;
      min-height: 0; /* Allow grid to shrink */
    }

    /* Recycle bin view is single column */
    #recycle-bin-view.active {
      display: flex;
      flex-direction: column;
    }

    .recycle-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      cursor: pointer;
    }
    .recycle-item:hover {
      background-color: var(--vscode-list-hoverBackground);
    }
    .recycle-item.selected {
      background-color: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .panel {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border-right: 1px solid var(--vscode-panel-border);
      min-height: 0; /* Critical: allow panel to shrink */
      height: 100%; /* Ensure panel fills grid cell */
    }

    .panel:last-child {
      border-right: none;
      padding: 10px;
      background-color: var(--vscode-editor-background);
      overflow: hidden; /* Critical: prevent panel from expanding beyond grid */
      display: flex; /* Make it a flex container */
      flex-direction: column; /* Stack children vertically */
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
      flex: 1; /* Take remaining space in the flex container */
      display: flex;
      flex-direction: column;
      min-height: 0; /* Critical: allow container to shrink */
      overflow: hidden; /* Prevent overflow */
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
    <div class="loading-overlay" id="loading-overlay">
      <div class="spinner"></div>
    </div>

    <div class="tabs">
      <div class="tab active" id="tab-sessions" onclick="switchTab('sessions')">会话列表</div>
      <div class="tab" id="tab-recycle" onclick="switchTab('recycleBin')">回收站</div>
    </div>

    <div class="content">
      <!-- Sessions View -->
      <div id="sessions-view" class="view-container active">
        <div class="panel">
          <div class="search-box">
            <input type="text" id="search-input" placeholder="搜索会话..." />
          </div>
          <div class="filter-bar">
             <button id="refresh-btn" title="刷新列表">🔄</button>
             <label><input type="checkbox" id="pinned-only" /> 仅看置顶</label>
             <label><input type="checkbox" id="hide-agents" checked /> 屏蔽 AGENTS.md</label>
             <button onclick="batchDeleteEmpty()" style="margin-left:auto;padding:2px 6px;font-size:0.9em" title="批量删除空会话">🗑️ 清理空会话</button>
          </div>
          <div class="list" id="session-list"></div>
          <!-- Batch delete button moved to filter-bar -->
        </div>
        <div class="preview-container">
          <div class="buttons">
             <button id="pin-btn" disabled onclick="togglePin()">📌 置顶</button>
             <button id="archive-btn" disabled onclick="toggleArchive()">📦 归档</button>
             <button id="copy-resume-btn" disabled onclick="copyResumeCommand()">📋 复制 Resume 命令</button>
             <button id="resume-terminal-btn" disabled onclick="resumeInTerminal()">🚀 在终端 Resume</button>
             <button id="delete-btn" disabled onclick="deleteSession()" style="color:var(--vscode-errorForeground);">🗑️ 删除</button>
          </div>
          <div class="remark-group">
             <input type="text" id="remark-input" placeholder="添加备注..." disabled />
             <button id="save-remark-btn" disabled onclick="saveRemark()">保存备注</button>
          </div>
          <div class="preview" id="preview">
            <div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--vscode-descriptionForeground);">
              请选择左侧会话查看详情
            </div>
          </div>
        </div>
      </div>

      <!-- Recycle Bin View -->
      <div id="recycle-bin-view" class="view-container">
        <div class="recycle-layout" style="display:flex;height:100%">
          <div class="recycle-sidebar" style="width:300px;display:flex;flex-direction:column;border-right:1px solid var(--vscode-panel-border)">
            <div class="toolbar" style="padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; gap: 8px;">
              <span style="font-weight:bold">已删除会话</span>
              <div style="display: flex; gap: 4px;">
                <button id="restore-btn" disabled onclick="restoreSelectedSession()">♫️ 还原</button>
                <button onclick="refreshRecycleBin()">🔄 刷新</button>
              </div>
            </div>
            <div class="list" id="recycle-bin-list" style="flex: 1; overflow-y: auto;"></div>
          </div>
          <div class="recycle-preview" style="flex:1;display:flex;flex-direction:column;height:100%">
             <div id="recycle-preview-content" class="preview" style="flex:1;overflow-y:auto;padding:20px;">
               <div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--vscode-descriptionForeground);">
                 请选择左侧已删除会话查看详情
               </div>
             </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { sessions: [], selectedId: null, hideAgents: true };
    const sessionList = document.getElementById('session-list');
    const previewEl = document.getElementById('preview');
    const searchInput = document.getElementById('search-input');
    const pinnedOnly = document.getElementById('pinned-only');
    const hideAgents = document.getElementById('hide-agents');
    const refreshBtn = document.getElementById('refresh-btn');
    // const batchDeleteEmptyBtn = document.getElementById('batchDeleteEmptyBtn'); // Removed in new layout
    const pinBtn = document.getElementById('pin-btn');
    const archiveBtn = document.getElementById('archive-btn');
    const copyResumeBtn = document.getElementById('copy-resume-btn');
    const resumeTerminalBtn = document.getElementById('resume-terminal-btn');
    const deleteBtn = document.getElementById('delete-btn');
    const remarkInput = document.getElementById('remark-input');
    const saveRemarkBtn = document.getElementById('save-remark-btn');
    const loadingOverlay = document.getElementById('loading-overlay');

    function setLoading(isLoading) {
      if (isLoading) loadingOverlay.classList.add('visible');
      else loadingOverlay.classList.remove('visible');
    }

    vscode.postMessage({ type: 'ready' });

    refreshBtn.addEventListener('click', () => { setLoading(true); fetchSessions(); });
    function batchDeleteEmpty() {
      vscode.postMessage({ type: 'batchDeleteEmpty' });
    }
    
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

    function togglePin() {
      if (state.selectedId) {
        setLoading(true);
        vscode.postMessage({ type: 'pinToggle', payload: { sessionId: state.selectedId } });
      }
    }
    
    function toggleArchive() {
      if (state.selectedId) {
        setLoading(true);
        vscode.postMessage({ type: 'archiveToggle', payload: { sessionId: state.selectedId } });
      }
    }

    function saveRemark() {
      if (!state.selectedId) return;
      setLoading(true);
      vscode.postMessage({ type: 'saveRemark', payload: { sessionId: state.selectedId, remark: remarkInput.value || '' } });
    }

    // Add keyboard shortcut for remark input (Enter or Ctrl+Enter)
    remarkInput.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' && e.ctrlKey) || e.key === 'Enter') {
        e.preventDefault();
        saveRemark();
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
      } else if (message.type === 'recycleBinPreview') {
        const previewContent = document.getElementById('recycle-preview-content');
        if (previewContent) {
           previewContent.innerHTML = message.payload;
        }
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
        // Note: scrollIntoView removed to prevent scroll container issues
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
      const disabled = !id;
      pinBtn.disabled = disabled;
      archiveBtn.disabled = disabled;
      copyResumeBtn.disabled = disabled;
      resumeTerminalBtn.disabled = disabled;
      deleteBtn.disabled = disabled;
      saveRemarkBtn.disabled = disabled;
      remarkInput.disabled = disabled;
      
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
        let anyHidden = false;
        foldedContents.forEach(el => {
            if (el.style.display === 'none' || el.style.display === '') {
                anyHidden = true;
            }
        });
        
        foldedContents.forEach(el => {
            el.style.display = anyHidden ? 'block' : 'none';
        });
        
        // Update buttons
        document.querySelectorAll('.expand-btn').forEach(btn => {
             const count = btn.textContent.match(/\d+/);
             const num = count ? count[0] : '';
             btn.textContent = anyHidden ? 'Collapse' : 'Show ' + num + ' hidden lines';
        });
    }

    // --- Recycle Bin Logic ---
    let currentTab = 'sessions';

    function switchTab(tab) {
      currentTab = tab;
      document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.view-container').forEach(el => el.classList.remove('active'));
      
      document.getElementById('tab-' + (tab === 'sessions' ? 'sessions' : 'recycle')).classList.add('active');
      document.getElementById(tab === 'sessions' ? 'sessions-view' : 'recycle-bin-view').classList.add('active');
      
      if (tab === 'recycleBin') {
        refreshRecycleBin();
      }
    }

    function refreshRecycleBin() {
      setLoading(true);
      vscode.postMessage({ type: 'fetchRecycleBin' });
    }

    function restoreSession(id) {
      setLoading(true);
      vscode.postMessage({ type: 'restoreSession', payload: { sessionId: id } });
    }
    
    function restoreSelectedSession() {
      if (state.selectedRecycleId) {
        restoreSession(state.selectedRecycleId);
      }
    }

    function selectRecycleSession(id) {
      state.selectedRecycleId = id;
      // Highlight selected
      document.querySelectorAll('.recycle-item').forEach(el => el.classList.remove('selected'));
      const selectedEl = document.getElementById('recycle-item-' + id);
      if (selectedEl) selectedEl.classList.add('selected');
      
      // Enable restore button
      document.getElementById('restore-btn').disabled = false;
      
      // Fetch preview
      document.getElementById('recycle-preview-content').innerHTML = '<div class="spinner"></div>';
      vscode.postMessage({ type: 'fetchRecycleBinSession', payload: { sessionId: id } });
    }

    function renderRecycleBin(sessions) {
      const list = document.getElementById('recycle-bin-list');
      if (!sessions || sessions.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;opacity:0.6">回收站为空</div>';
        return;
      }
      
      list.innerHTML = sessions.map(s => {
        const dateStr = new Date(s.lastTs).toLocaleString();
        // Escape single quotes in sessionId for onclick
        const safeId = s.sessionId.replace(/'/g, "\\'");
        const title = s.firstText ? (s.firstText.length > 50 ? s.firstText.substring(0, 50) + '...' : s.firstText) : s.sessionId;
        
        const remarkHtml = s.remark ? '<br><span class="remark-badge">' + s.remark + '</span>' : '';
        const archiveBadge = s.isArchived ? '<span class="archive-badge">📦 已归档</span>' : '';
        const pinIcon = s.pinned ? '<span style="color: var(--vscode-charts-yellow);">⭐ </span>' : '';
        const isSelected = state.selectedRecycleId === s.sessionId ? ' selected' : '';
        
        return '<div class="recycle-item' + isSelected + '" id="recycle-item-' + s.sessionId + '" onclick="selectRecycleSession(\\'' + safeId + '\\')">' +
          '<div class="recycle-info">' +
            '<div style="font-weight:bold" title="' + (s.firstText || s.sessionId) + '">' + pinIcon + title + archiveBadge + '</div>' +
            '<div style="font-size:0.85em;opacity:0.7">' +
              'ID: ' + s.sessionId + '<br>' +
              '删除时间: ' + dateStr +
              remarkHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'update':
          state.sessions = message.payload;
          renderSessions();
          setLoading(false);
          break;
        case 'recycleBin':
          renderRecycleBin(message.payload);
          setLoading(false);
          break;
        case 'selectSession':
          state.selectedId = message.payload.sessionId;
          state.hideAgents = message.payload.hideAgents;
          renderSessions();
          // Find session data
          const session = state.sessions.find(s => s.sessionId === state.selectedId);
          if (session) {
             // Request full details
             vscode.postMessage({ type: 'selectSession', payload: { sessionId: state.selectedId, hideAgents: state.hideAgents } });
          }
          break;
        case 'sessionDetails':
          renderPreview(message.payload);
          setLoading(false);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
