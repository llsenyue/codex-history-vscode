import os from 'os';
import path from 'path';
import fs from 'fs-extra';
const DEFAULT_MANAGER_DIR = path.join(os.homedir(), '.codex-history');
export function buildPaths(customCodexHome, customManagerHome) {
    const codexHome = customCodexHome ?? path.join(os.homedir(), '.codex');
    const managerHome = customManagerHome ?? DEFAULT_MANAGER_DIR;
    return {
        codexHome,
        historyFile: path.join(codexHome, 'history.jsonl'),
        sessionsDir: path.join(codexHome, 'sessions'),
        managerHome,
        stateFile: path.join(managerHome, 'state.json'),
        trashDir: path.join(managerHome, 'trash'),
    };
}
export async function ensureManagerDirs(paths) {
    await fs.ensureDir(paths.managerHome);
    await fs.ensureDir(paths.trashDir);
    await fs.ensureDir(path.join(paths.trashDir, 'sessions'));
}
