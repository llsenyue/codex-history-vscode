import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import clipboardy from 'clipboardy';
import { formatTs } from '../historyManager.js';
const PREVIEW_LIMIT = 8;
const App = ({ manager, limit = 50 }) => {
    const { exit } = useApp();
    const [sessions, setSessions] = useState([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [preview, setPreview] = useState(null);
    const [status, setStatus] = useState('加载中...');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [confirmDelete, setConfirmDelete] = useState(null);
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
            }
            else {
                setSelectedIndex((idx) => {
                    if (idx < 0)
                        return 0;
                    if (idx >= data.length)
                        return data.length - 1;
                    return idx;
                });
                setStatus(`共 ${data.length} 个会话，使用上下键浏览。`);
            }
            setError(null);
        }
        catch (err) {
            setError(err?.message ?? String(err));
        }
        finally {
            setBusy(false);
        }
    }, [manager, limit]);
    useEffect(() => {
        loadSessions();
    }, [loadSessions]);
    const loadPreview = useCallback(async (sessionId) => {
        try {
            setBusy(true);
            setStatus(`加载 ${sessionId} 的消息...`);
            const { messages, remark } = await manager.readSessionMessages(sessionId, { limit: PREVIEW_LIMIT });
            setPreview({ messages, remark });
            setStatus(`显示 ${sessionId} 的最近 ${messages.length} 条消息。`);
            setError(null);
        }
        catch (err) {
            setError(err?.message ?? String(err));
        }
        finally {
            setBusy(false);
        }
    }, [manager]);
    const togglePin = useCallback(async (session) => {
        try {
            setBusy(true);
            setStatus(`${session.pinned ? '取消置顶' : '置顶'} ${session.sessionId} ...`);
            if (session.pinned) {
                await manager.unpin(session.sessionId);
            }
            else {
                await manager.pin(session.sessionId);
            }
            await loadSessions();
            setStatus(`${session.pinned ? '已取消置顶' : '已置顶'} ${session.sessionId}`);
        }
        catch (err) {
            setError(err?.message ?? String(err));
        }
        finally {
            setBusy(false);
        }
    }, [manager, loadSessions]);
    const copyResume = useCallback(async (session) => {
        try {
            setBusy(true);
            const cmd = await manager.copyResumeCommand(session.sessionId);
            await clipboardy.write(cmd);
            setStatus(`已复制: ${cmd}`);
            setError(null);
        }
        catch (err) {
            setError(err?.message ?? String(err));
        }
        finally {
            setBusy(false);
        }
    }, [manager]);
    const deleteSession = useCallback(async (sessionId) => {
        try {
            setBusy(true);
            setStatus(`删除 ${sessionId} ...`);
            await manager.deleteSessions([sessionId], { backupHistory: true });
            await loadSessions();
            setPreview(null);
            setStatus(`已删除 ${sessionId}`);
            setError(null);
        }
        catch (err) {
            setError(err?.message ?? String(err));
        }
        finally {
            setBusy(false);
        }
    }, [manager, loadSessions]);
    useInput(async (input, key) => {
        if (key.ctrl && input === 'c') {
            exit();
            return;
        }
        if (confirmDelete) {
            if (input.toLowerCase() === 'y') {
                setConfirmDelete(null);
                await deleteSession(confirmDelete);
            }
            else if (input.toLowerCase() === 'n' || key.escape) {
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
        if (!currentSession)
            return;
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
            return _jsx(Text, { children: "\u6682\u65E0\u4F1A\u8BDD\u3002" });
        }
        return sessions.map((item, idx) => {
            const isSelected = idx === selectedIndex;
            const remark = item.remark ? ` 备注:${truncate(item.remark, 20)}` : '';
            const line = `${item.pinned ? '★' : ' '} ${item.sessionId}  ${formatTs(item.lastTs)}  ${truncate(item.lastText, 40)} (${item.count})${remark}`;
            return (_jsxs(Text, { color: isSelected ? 'black' : item.pinned ? 'yellow' : undefined, backgroundColor: isSelected ? 'cyan' : undefined, children: [isSelected ? '› ' : '  ', line] }, item.sessionId));
        });
    }, [sessions, selectedIndex]);
    const previewContent = useMemo(() => {
        if (!currentSession) {
            return _jsx(Text, { children: "\u9009\u4E2D\u4F1A\u8BDD\u540E\u6309\u7A7A\u683C\u52A0\u8F7D\u9884\u89C8\u3002" });
        }
        if (!preview) {
            return _jsxs(Text, { children: ["\u6309\u7A7A\u683C\u52A0\u8F7D ", currentSession.sessionId, " \u7684\u6D88\u606F\u3002"] });
        }
        if (!preview.messages.length) {
            return _jsx(Text, { children: "\u8BE5\u4F1A\u8BDD\u6682\u65E0\u53EF\u5C55\u793A\u6D88\u606F\u3002" });
        }
        return (_jsxs(_Fragment, { children: [_jsx(Text, { color: "yellow", children: preview.remark ? `备注：${preview.remark}` : '备注：无' }), preview.messages.map((msg, idx) => (_jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [_jsxs(Text, { color: msg.role === 'assistant' ? 'cyan' : 'green', children: ["[", idx + 1, "] ", msg.role, " ", msg.timestamp ? dayjsFormat(msg.timestamp) : ''] }), _jsx(Text, { children: msg.text || '(无文本)' })] }, `${msg.timestamp}-${idx}`)))] }));
    }, [preview, currentSession]);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { children: _jsx(Text, { color: "magenta", children: "Codex \u5386\u53F2\u7BA1\u7406\u754C\u9762" }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "gray", children: "\u2191/\u2193 \u79FB\u52A8  Space \u9884\u89C8  p \u7F6E\u9876  c/Enter \u590D\u5236 resume  d \u5220\u9664  r \u5237\u65B0  q \u9000\u51FA" }) }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: busy ? 'yellow' : 'green', children: busy ? '执行中...' : status }) }), error ? (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "red", children: error }) })) : null, confirmDelete ? (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "yellow", children: ["\u786E\u8BA4\u5220\u9664 ", confirmDelete, "? \u6309 y \u786E\u8BA4 / n \u53D6\u6D88"] }) })) : null, _jsxs(Box, { marginTop: 1, children: [_jsxs(Box, { flexBasis: "60%", flexDirection: "column", marginRight: 2, children: [_jsx(Text, { color: "cyan", children: "\u4F1A\u8BDD\u5217\u8868" }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: listContent })] }), _jsxs(Box, { flexDirection: "column", flexGrow: 1, children: [_jsx(Text, { color: "cyan", children: "\u4F1A\u8BDD\u9884\u89C8" }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: previewContent })] })] })] }));
};
function truncate(text, max) {
    if (!text)
        return '';
    if (text.length <= max)
        return text;
    return text.slice(0, max - 1) + '…';
}
function dayjsFormat(tsString) {
    const date = new Date(tsString);
    if (Number.isNaN(date.getTime()))
        return tsString;
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
export default App;
