import * as vscode from 'vscode';
import { HistoryManager, SessionSummary } from './core/historyManager';
import { formatTs } from './core/historyManager';

export class SidebarProvider implements vscode.TreeDataProvider<SessionItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SessionItem | undefined | null | void> = new vscode.EventEmitter<
    SessionItem | undefined | null | void
  >();
  readonly onDidChangeTreeData: vscode.Event<SessionItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private readonly manager: HistoryManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  private _cachedItems: SessionItem[] = [];

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (element) {
      return [];
    }

    try {
      // 获取最近的会话（无限制）
      const sessions = await this.manager.listSummaries({ limit: 1000, hideAgents: true });
      this._cachedItems = sessions.map((s) => new SessionItem(s));
      return this._cachedItems;
    } catch (error) {
      vscode.window.showErrorMessage('无法加载会话列表: ' + error);
      return [];
    }
  }

  getItem(sessionId: string): SessionItem | undefined {
    return this._cachedItems.find(item => item.session.sessionId === sessionId);
  }
}

class SessionItem extends vscode.TreeItem {
  constructor(public readonly session: SessionSummary) {
    super(session.sessionId, vscode.TreeItemCollapsibleState.None);
    
    this.contextValue = 'session';

    // Use firstText as label if available, otherwise fallback to sessionId
    if (session.firstText) {
        // Truncate if too long
        const label = session.firstText.replace(/\n/g, ' ');
        this.label = label.length > 30 ? label.substring(0, 30) + '...' : label;
        this.description = `${session.sessionId} · ${formatTs(session.lastTs)}`;
    } else {
        this.label = session.sessionId;
        this.description = formatTs(session.lastTs);
    }

    this.tooltip = `${session.firstText || session.sessionId}\nID: ${session.sessionId}\n${formatTs(session.lastTs)}\n${session.count} 条消息`;

    if (session.pinned) {
      this.iconPath = new vscode.ThemeIcon('star-full');
    } else if (session.isArchived) {
      this.iconPath = new vscode.ThemeIcon('archive');
    } else {
      this.iconPath = new vscode.ThemeIcon('comment-discussion');
    }

    if (session.remark) {
      this.label = session.remark;
      this.description = `${session.sessionId} · ${formatTs(session.lastTs)}`;
    }

    this.command = {
      command: 'codexHistory.openManager',
      title: '打开会话',
      arguments: [session.sessionId],
    };
  }
}
