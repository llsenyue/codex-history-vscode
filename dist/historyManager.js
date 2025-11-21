import path from 'path';
import fs from 'fs-extra';
import readline from 'readline';
import fg from 'fast-glob';
import dayjs from 'dayjs';
export class HistoryManager {
    constructor(paths, state) {
        this.paths = paths;
        this.state = state;
    }
    async listSummaries(options = {}) {
        const lines = await this.readHistoryLines(options.hideAgents !== false);
        const pinnedSet = await this.state.getPinnedSet();
        const remarks = await this.state.getRemarks();
        const searchText = options.search?.toLowerCase();
        const summaries = new Map();
        for (const line of lines) {
            if (searchText && !line.text.toLowerCase().includes(searchText)) {
                continue;
            }
            const existing = summaries.get(line.session_id);
            if (!existing) {
                summaries.set(line.session_id, {
                    sessionId: line.session_id,
                    firstTs: line.ts,
                    lastTs: line.ts,
                    firstText: line.text,
                    lastText: line.text,
                    count: 1,
                    pinned: pinnedSet.has(line.session_id),
                    remark: remarks[line.session_id] || undefined,
                });
            }
            else {
                existing.lastTs = Math.max(existing.lastTs, line.ts);
                existing.firstTs = Math.min(existing.firstTs, line.ts);
                existing.lastText = line.text;
                existing.count += 1;
                if (!existing.remark && remarks[line.session_id]) {
                    existing.remark = remarks[line.session_id];
                }
            }
        }
        let result = Array.from(summaries.values());
        if (options.onlyPinned) {
            result = result.filter((item) => item.pinned);
        }
        result.sort((a, b) => {
            if (a.pinned !== b.pinned)
                return a.pinned ? -1 : 1;
            return b.lastTs - a.lastTs;
        });
        if (options.limit && options.limit > 0) {
            result = result.slice(0, options.limit);
        }
        return result;
    }
    async findSessionFile(sessionId) {
        const matches = await fg(`**/*${sessionId}.jsonl`, {
            cwd: this.paths.sessionsDir,
            absolute: true,
            suppressErrors: true,
        });
        return matches[0] ?? null;
    }
    async readSessionMessages(sessionId, options = {}) {
        const filePath = await this.findSessionFile(sessionId);
        if (!filePath) {
            throw new Error(`在 sessions 目录中未找到会话文件，ID=${sessionId}`);
        }
        const messages = [];
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath, 'utf-8'),
            crlfDelay: Infinity,
        });
        for await (const line of rl) {
            if (!line.trim())
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch (error) {
                continue;
            }
            const msg = toMessage(parsed);
            if (msg && !(options.hideAgents !== false && isAgentsText(msg.text))) {
                messages.push(msg);
            }
            if (options.limit && messages.length >= options.limit) {
                break;
            }
        }
        const remark = await this.state.getRemark(sessionId);
        return { filePath, messages, remark: remark || undefined };
    }
    async pin(sessionId) {
        await this.state.pin(sessionId);
    }
    async unpin(sessionId) {
        await this.state.unpin(sessionId);
    }
    async deleteSessions(sessionIds, options = {}) {
        const idSet = new Set(sessionIds);
        const removedFiles = [];
        const notFoundFiles = [];
        // 1) 移动会话文件到回收站
        for (const sessionId of idSet) {
            const file = await this.findSessionFile(sessionId);
            if (!file) {
                notFoundFiles.push(sessionId);
                continue;
            }
            const relative = path.relative(this.paths.sessionsDir, file);
            const dest = path.join(this.paths.trashDir, 'sessions', relative);
            await fs.ensureDir(path.dirname(dest));
            await fs.move(file, dest, { overwrite: true });
            removedFiles.push(file);
        }
        // 2) 重写 history.jsonl，过滤掉对应会话
        const removedHistory = await this.rewriteHistoryExcluding(idSet, options.backupHistory !== false);
        // 3) 取消置顶
        for (const sessionId of idSet) {
            await this.unpin(sessionId);
            await this.state.setRemark(sessionId, '');
        }
        return { removedHistory, removedFiles, notFoundFiles };
    }
    async copyResumeCommand(sessionId) {
        return `codex resume ${sessionId}`;
    }
    async setRemark(sessionId, remark) {
        await this.state.setRemark(sessionId, remark);
    }
    async readHistoryLines(hideAgents) {
        const file = this.paths.historyFile;
        const exists = await fs.pathExists(file);
        if (!exists)
            return [];
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        const parsed = [];
        for (const line of lines) {
            try {
                const obj = JSON.parse(line);
                if (obj.session_id && obj.ts && obj.text !== undefined) {
                    if (hideAgents && isAgentsText(obj.text)) {
                        continue;
                    }
                    parsed.push(obj);
                }
            }
            catch (error) {
                // ignore bad line
            }
        }
        return parsed;
    }
    async rewriteHistoryExcluding(sessionIds, backupHistory) {
        const file = this.paths.historyFile;
        if (!(await fs.pathExists(file)))
            return 0;
        const tempFile = file + '.tmp';
        const backupFile = file + '.bak';
        let removed = 0;
        const input = fs.createReadStream(file, 'utf-8');
        const output = fs.createWriteStream(tempFile, { encoding: 'utf-8' });
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            let obj;
            try {
                obj = JSON.parse(trimmed);
            }
            catch (error) {
                output.write(line + '\n');
                continue;
            }
            if (sessionIds.has(obj.session_id)) {
                removed += 1;
                continue;
            }
            output.write(line + '\n');
        }
        await new Promise((resolve, reject) => {
            output.on('finish', resolve);
            output.on('error', reject);
            output.end();
        });
        if (backupHistory) {
            await fs.copyFile(file, backupFile);
        }
        await fs.move(tempFile, file, { overwrite: true });
        return removed;
    }
}
function toMessage(entry) {
    const timestamp = entry.timestamp ?? entry.time ?? '';
    const type = entry.type;
    const payload = entry.payload ?? {};
    if (type === 'response_item' && payload.type === 'message') {
        const role = payload.role ?? 'unknown';
        const text = extractContentText(payload.content);
        return {
            timestamp,
            role,
            text,
            rawType: `${type}:${payload.type}`,
        };
    }
    if (type === 'event_msg') {
        if (payload.type === 'agent_message') {
            return { timestamp, role: 'assistant', text: payload.message ?? '', rawType: 'event:agent_message' };
        }
        // user_message 与 response_item 的 user 消息内容重复，预览时跳过以减少噪音
        if (payload.type === 'user_message') {
            return null;
        }
    }
    return null;
}
function extractContentText(content) {
    if (!content)
        return '';
    if (Array.isArray(content)) {
        return content
            .map((item) => item?.text ?? item?.value ?? '')
            .filter(Boolean)
            .join('\n');
    }
    if (typeof content === 'string')
        return content;
    if (typeof content === 'object') {
        return content.text ?? content.value ?? '';
    }
    return '';
}
export function formatTs(ts) {
    return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss');
}
function isAgentsText(text) {
    if (!text)
        return false;
    const normalized = text.toLowerCase();
    return (normalized.includes('agents.md') ||
        normalized.includes('系统提示词') ||
        normalized.includes('你是一个资深全栈技术专家') ||
        normalized.startsWith('<instructions>') ||
        normalized.includes('mcp 调用规则'));
}
