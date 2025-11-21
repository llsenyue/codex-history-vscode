import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import clipboardy from 'clipboardy';
import { HistoryManager, SessionMessage, SessionSummary, formatTs } from '../historyManager.js';

interface InputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  escape?: boolean;
  return?: boolean;
  ctrl?: boolean;
}

interface AppProps {
  manager: HistoryManager;
  limit?: number;
}

const PREVIEW_LIMIT = 8;

const App: React.FC<AppProps> = ({ manager, limit = 50 }) => {
  const { exit } = useApp();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [preview, setPreview] = useState<{ messages: SessionMessage[]; remark?: string } | null>(null);
  const [status, setStatus] = useState('加载中...');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<null | string>(null);

  const currentSession = sessions[selectedIndex];

  const loadSessions = useCallback(async () => {
    try {
      setBusy(true);
      setStatus('读取会话列表...');
      const data = await manager.listSummaries({ limit });
      setSessions(data);
      if (data.length === 0) {
        setSelectedIndex(0);
        setPreview(null);
        setStatus('没有会话记录。');
      } else {
        setSelectedIndex((idx) => {
          if (idx < 0) return 0;
          if (idx >= data.length) return data.length - 1;
          return idx;
        });
        setStatus(`共 ${data.length} 个会话，使用上下键浏览。`);
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [manager, limit]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const loadPreview = useCallback(async (sessionId: string) => {
    try {
      setBusy(true);
      setStatus(`加载 ${sessionId} 的消息...`);
      const { messages, remark } = await manager.readSessionMessages(sessionId, { limit: PREVIEW_LIMIT });
      setPreview({ messages, remark });
      setStatus(`显示 ${sessionId} 的最近 ${messages.length} 条消息。`);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [manager]);

  const togglePin = useCallback(async (session: SessionSummary) => {
    try {
      setBusy(true);
      setStatus(`${session.pinned ? '取消置顶' : '置顶'} ${session.sessionId} ...`);
      if (session.pinned) {
        await manager.unpin(session.sessionId);
      } else {
        await manager.pin(session.sessionId);
      }
      await loadSessions();
      setStatus(`${session.pinned ? '已取消置顶' : '已置顶'} ${session.sessionId}`);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [manager, loadSessions]);

  const copyResume = useCallback(async (session: SessionSummary) => {
    try {
      setBusy(true);
      const cmd = await manager.copyResumeCommand(session.sessionId);
      await clipboardy.write(cmd);
      setStatus(`已复制: ${cmd}`);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [manager]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      setBusy(true);
      setStatus(`删除 ${sessionId} ...`);
      await manager.deleteSessions([sessionId], { backupHistory: true });
      await loadSessions();
      setPreview(null);
      setStatus(`已删除 ${sessionId}`);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  }, [manager, loadSessions]);

  useInput(async (input: string, key: InputKey) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (confirmDelete) {
      if (input.toLowerCase() === 'y') {
        setConfirmDelete(null);
        await deleteSession(confirmDelete);
      } else if (input.toLowerCase() === 'n' || key.escape) {
        setConfirmDelete(null);
        setStatus('已取消删除');
      }
      return;
    }

    if (input === 'q' || key.escape) {
      exit();
      return;
    }

    if (busy) {
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((prev) => (sessions.length ? (prev - 1 + sessions.length) % sessions.length : 0));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => (sessions.length ? (prev + 1) % sessions.length : 0));
      return;
    }

    if (!currentSession) return;

    if (key.return || input === 'c') {
      await copyResume(currentSession);
      return;
    }

    if (input === ' ') {
      await loadPreview(currentSession.sessionId);
      return;
    }

    if (input.toLowerCase() === 'p') {
      await togglePin(currentSession);
      return;
    }

    if (input.toLowerCase() === 'r') {
      await loadSessions();
      return;
    }

    if (input.toLowerCase() === 'd') {
      setConfirmDelete(currentSession.sessionId);
      setStatus(`确认删除 ${currentSession.sessionId}? 按 y 确认 / n 取消`);
      return;
    }
  });

  const listContent = useMemo(() => {
    if (!sessions.length) {
      return <Text>暂无会话。</Text>;
    }
    return sessions.map((item, idx) => {
      const isSelected = idx === selectedIndex;
      const remark = item.remark ? ` 备注:${truncate(item.remark, 20)}` : '';
      const line = `${item.pinned ? '★' : ' '} ${item.sessionId}  ${formatTs(item.lastTs)}  ${truncate(
        item.lastText,
        40
      )} (${item.count})${remark}`;
      return (
        <Text key={item.sessionId} color={isSelected ? 'black' : item.pinned ? 'yellow' : undefined} backgroundColor={isSelected ? 'cyan' : undefined}>
          {isSelected ? '› ' : '  '}{line}
        </Text>
      );
    });
  }, [sessions, selectedIndex]);

  const previewContent = useMemo(() => {
    if (!currentSession) {
      return <Text>选中会话后按空格加载预览。</Text>;
    }
    if (!preview) {
      return <Text>按空格加载 {currentSession.sessionId} 的消息。</Text>;
    }
    if (!preview.messages.length) {
      return <Text>该会话暂无可展示消息。</Text>;
    }
    return (
      <>
        <Text color="yellow">{preview.remark ? `备注：${preview.remark}` : '备注：无'}</Text>
        {preview.messages.map((msg, idx) => (
        <Box key={`${msg.timestamp}-${idx}`} flexDirection="column" marginBottom={1}>
          <Text color={msg.role === 'assistant' ? 'cyan' : 'green'}>
            [{idx + 1}] {msg.role} {msg.timestamp ? dayjsFormat(msg.timestamp) : ''}
          </Text>
          <Text>{msg.text || '(无文本)'}</Text>
        </Box>
        ))}
      </>
    );
  }, [preview, currentSession]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="magenta">Codex 历史管理界面</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          ↑/↓ 移动  Space 预览  p 置顶  c/Enter 复制 resume  d 删除  r 刷新  q 退出
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={busy ? 'yellow' : 'green'}>{busy ? '执行中...' : status}</Text>
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      ) : null}
      {confirmDelete ? (
        <Box marginTop={1}>
          <Text color="yellow">确认删除 {confirmDelete}? 按 y 确认 / n 取消</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Box flexBasis="60%" flexDirection="column" marginRight={2}>
          <Text color="cyan">会话列表</Text>
          <Box flexDirection="column" marginTop={1}>
            {listContent}
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          <Text color="cyan">会话预览</Text>
          <Box flexDirection="column" marginTop={1}>
            {previewContent}
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function dayjsFormat(tsString: string): string {
  const date = new Date(tsString);
  if (Number.isNaN(date.getTime())) return tsString;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export default App;
