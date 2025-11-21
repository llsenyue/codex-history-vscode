import fs from 'fs-extra';
import path from 'path';
const DEFAULT_STATE = {
    pinned: [],
    remarks: {},
};
export class StateStore {
    constructor(paths) {
        this.paths = paths;
        this.state = { ...DEFAULT_STATE };
        this.loaded = false;
    }
    async load() {
        if (this.loaded) {
            return this.state;
        }
        try {
            const exists = await fs.pathExists(this.paths.stateFile);
            if (!exists) {
                await this.persist();
            }
            else {
                const raw = await fs.readFile(this.paths.stateFile, 'utf-8');
                const parsed = JSON.parse(raw);
                this.state = {
                    pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
                    remarks: parsed.remarks && typeof parsed.remarks === 'object' ? { ...parsed.remarks } : {},
                };
            }
        }
        catch (error) {
            console.warn(`读取状态文件失败，使用默认值。位置: ${this.paths.stateFile}`, error);
            this.state = { ...DEFAULT_STATE };
        }
        this.loaded = true;
        return this.state;
    }
    async persist() {
        await fs.ensureDir(path.dirname(this.paths.stateFile));
        await fs.writeFile(this.paths.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
    }
    async pin(sessionId) {
        await this.load();
        if (!this.state.pinned.includes(sessionId)) {
            this.state.pinned.unshift(sessionId);
            await this.persist();
        }
    }
    async unpin(sessionId) {
        await this.load();
        const next = this.state.pinned.filter((id) => id !== sessionId);
        if (next.length !== this.state.pinned.length) {
            this.state.pinned = next;
            await this.persist();
        }
    }
    async isPinned(sessionId) {
        await this.load();
        return this.state.pinned.includes(sessionId);
    }
    async getPinnedSet() {
        await this.load();
        return new Set(this.state.pinned);
    }
    async setRemark(sessionId, remark) {
        await this.load();
        const next = remark.trim();
        if (this.state.remarks[sessionId] === next)
            return;
        if (next) {
            this.state.remarks[sessionId] = next;
        }
        else {
            delete this.state.remarks[sessionId];
        }
        await this.persist();
    }
    async getRemark(sessionId) {
        await this.load();
        return this.state.remarks[sessionId] ?? '';
    }
    async getRemarks() {
        await this.load();
        return { ...this.state.remarks };
    }
}
