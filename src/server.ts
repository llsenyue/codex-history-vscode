import express from 'express';
import path from 'path';
import open from 'open';
import { fileURLToPath } from 'url';
import { HistoryManager } from './historyManager.js';
import { buildPaths, ensureManagerDirs } from './paths.js';
import { StateStore } from './state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ServerOptions {
  codexHome?: string;
  managerHome?: string;
  port?: number;
  openBrowser?: boolean;
}

export async function startServer(options: ServerOptions = {}) {
  const app = express();
  app.use(express.json());

  const paths = buildPaths(options.codexHome, options.managerHome);
  await ensureManagerDirs(paths);
  const state = new StateStore(paths);
  await state.load();
  const manager = new HistoryManager(paths, state);

  app.get('/api/sessions', async (req, res) => {
    const limit = parseIntOrDefault(req.query.limit, 200);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const onlyPinned = parseBoolean(req.query.onlyPinned);
    const hideAgents = parseBoolean(req.query.hideAgents);
    const summaries = await manager.listSummaries({ limit, search, onlyPinned, hideAgents: hideAgents !== false });
    res.json(summaries);
  });

  app.get('/api/sessions/:id', async (req, res) => {
    try {
      const limit = parseIntOrDefault(req.query.limit, 100);
      const hideAgents = parseBoolean(req.query.hideAgents);
      const data = await manager.readSessionMessages(req.params.id, { limit, hideAgents: hideAgents !== false });
      res.json(data);
    } catch (error: any) {
      res.status(404).json({ error: error.message ?? String(error) });
    }
  });

  app.post('/api/sessions/:id/pin', async (req, res) => {
    await manager.pin(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/sessions/:id/unpin', async (req, res) => {
    await manager.unpin(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/sessions/:id/delete', async (req, res) => {
    try {
      const result = await manager.deleteSessions([req.params.id], { backupHistory: true });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message ?? String(error) });
    }
  });

  app.get('/api/sessions/:id/resume', async (req, res) => {
    const cmd = await manager.copyResumeCommand(req.params.id);
    res.json({ command: cmd });
  });

  app.post('/api/sessions/:id/remark', async (req, res) => {
    try {
      const remark = typeof req.body?.remark === 'string' ? req.body.remark : '';
      await manager.setRemark(req.params.id, remark);
      res.json({ ok: true, remark });
    } catch (error: any) {
      res.status(400).json({ error: error.message ?? String(error) });
    }
  });

  const publicDir = path.resolve(__dirname, '../public');
  app.use(express.static(publicDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  const port = options.port ?? 4175;
  app.listen(port, () => {
    console.log(`Codex 历史管理 Web 服务已启动: http://localhost:${port}`);
    if (options.openBrowser) {
      open(`http://localhost:${port}`);
    }
  });
}

function parseIntOrDefault(value: unknown, defaultValue: number): number {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return defaultValue;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true';
  }
  return undefined;
}
