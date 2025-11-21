import * as vscode from 'vscode';
import path from 'path';
import fs from 'fs-extra';
import readline from 'readline';
import fg from 'fast-glob';
import dayjs from 'dayjs';
import { ManagerPaths } from './paths';
import { StateStore } from './state';

interface HistoryLine {
  session_id: string;
  ts: number;
  text?: string; // Deprecated, kept for compatibility
  first_text?: string; // First user message
  last_text?: string; // Last message
  turn_count?: number; // Number of conversation turns
  is_archived?: boolean;
}

export interface SessionSummary {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  firstText: string;
  lastText: string;
  count: number;
  pinned: boolean;
  remark?: string;
  isArchived?: boolean;
}

export interface SessionMessage {
  timestamp: string;
  role: string;
  text: string;
  rawType: string;
}

export interface DeleteResult {
  removedHistory: number;
  removedFiles: string[];
  notFoundFiles: string[];
}

export class HistoryManager {
  constructor(private readonly paths: ManagerPaths, private readonly state: StateStore) {}

  async listSummaries(options: { search?: string; limit?: number; onlyPinned?: boolean; hideAgents: boolean } = { hideAgents: true }): Promise<SessionSummary[]> {
    console.log('[Manager] listSummaries called with options:', options);
    const lines = await this.readHistoryLines(options.hideAgents !== false);
    console.log(`[Manager] Read ${lines.length} lines from history file`);
    const pinnedSet = await this.state.getPinnedSet();
    const remarks = await this.state.getRemarks();
    const searchTerms = options.search?.toLowerCase().split(/\s+/).filter(t => t.length > 0) || [];

    const summaries = new Map<string, SessionSummary>();

    for (const line of lines) {
      const text = line.text || line.last_text || '';
      
      if (searchTerms.length > 0) {
          const content = (text + ' ' + (line.first_text || '')).toLowerCase();
          if (!searchTerms.every(term => content.includes(term))) {
              continue;
          }
      }
      const existing = summaries.get(line.session_id);
      const truncatedText = text.length > 200 ? text.substring(0, 200) + '...' : text;
      
      // Clean and normalize first_text: remove line breaks, trim, and limit length
      const cleanFirstText = (rawText: string): string => {
        if (!rawText) return '';
        // Remove all line breaks (\r\n, \n, \r) and replace with space
        const cleaned = rawText.replace(/[\r\n]+/g, ' ');
        // Remove excessive whitespace
        const trimmed = cleaned.replace(/\s+/g, ' ').trim();
        // Limit to a reasonable display length
        return trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
      };
      
      if (!existing) {
        summaries.set(line.session_id, {
          sessionId: line.session_id,
          firstTs: line.ts,
          lastTs: line.ts,
          firstText: cleanFirstText(line.first_text || truncatedText),
          lastText: line.last_text || truncatedText,
          count: line.turn_count || 1,
          pinned: pinnedSet.has(line.session_id),
          remark: remarks[line.session_id] || undefined,
          isArchived: line.is_archived
        });
      } else {
        existing.lastTs = Math.max(existing.lastTs, line.ts);
        existing.firstTs = Math.min(existing.firstTs, line.ts);
        // Update lastText if this line is newer
        if (line.ts >= existing.lastTs) {
            existing.lastText = line.last_text || truncatedText;
        }
        // Update firstText if provided and not already set
        if (line.first_text && (!existing.firstText || existing.firstText === '(空会话)')) {
            existing.firstText = cleanFirstText(line.first_text);
        }
        
        existing.count += 1;
        if (!existing.remark && remarks[line.session_id]) {
          existing.remark = remarks[line.session_id];
        }
        if (line.is_archived) {
            existing.isArchived = true;
        }
      }
    }

    let result = Array.from(summaries.values());
    if (options.onlyPinned) {
      result = result.filter((item) => item.pinned);
    }

    result.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastTs - a.lastTs;
    });

    if (options.limit && options.limit > 0) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  async findSessionFile(sessionId: string): Promise<string | null> {
    // Helper function for directory search
    const searchInDirectory = async (baseDir: string): Promise<string | null> => {
      // 1. Try using fast-glob
      const matches = await fg(`**/*${sessionId}.jsonl`, {
        cwd: baseDir,
        absolute: true,
        suppressErrors: true,
      });
      if (matches.length > 0) {
        return matches[0];
      }

      // 2. Fallback: Manual recursive search
      const findFileRecursive = async (dir: string, depth: number = 0): Promise<string | null> => {
        if (depth > 5) return null;
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    const result = await findFileRecursive(fullPath, depth + 1);
                    if (result) return result;
                } else if (entry.isFile()) {
                    if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
                        return fullPath;
                    }
                }
            }
        } catch (err) {
            // Silently handle errors
        }
        return null;
      };

      return await findFileRecursive(baseDir);
    };

    // Search in sessions directory first
    try {
      const sessionPath = await searchInDirectory(this.paths.sessionsDir);
      if (sessionPath) {
        console.log(`[Manager] Found session file in sessions: ${sessionPath}`);
        return sessionPath;
      }
    } catch (error) {
      console.error('[Manager] Error searching sessions dir:', error);
    }

    // Search in archived_sessions directory
    const archivedSessionsDir = path.join(path.dirname(this.paths.sessionsDir), 'archived_sessions');
    try {
      if (await fs.pathExists(archivedSessionsDir)) {
        const archivedPath = await searchInDirectory(archivedSessionsDir);
        if (archivedPath) {
          console.log(`[Manager] Found session file in archived_sessions: ${archivedPath}`);
          return archivedPath;
        }
      }
    } catch (error) {
      console.error('[Manager] Error searching archived_sessions dir:', error);
    }

    // Check Trash as last resort
    try {
      console.log(`[Manager] Checking trash for ${sessionId}...`);
      const trashSessionsDir = path.join(this.paths.trashDir, 'sessions');
      if (await fs.pathExists(trashSessionsDir)) {
          const findFileRecursive = async (dir: string, depth: number = 0): Promise<string | null> => {
            if (depth > 5) return null;
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        const result = await findFileRecursive(fullPath, depth + 1);
                        if (result) return result;
                    } else if (entry.isFile()) {
                        if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
                            return fullPath;
                        }
                    }
                }
            } catch (err) {}
            return null;
          };
          
          const foundInTrash = await findFileRecursive(trashSessionsDir);
          if (foundInTrash) {
              console.log(`[Manager] FOUND IN TRASH: ${foundInTrash}`);
              vscode.window.showWarningMessage(`Session file found in Trash: ${path.basename(foundInTrash)}. You may need to manually restore it.`);
              return null;
          }
      }
    } catch (err) {
      console.error('[Manager] Error searching trash:', err);
    }

    return null;
  }

  async rebuildIndex(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    const historyFile = this.paths.historyFile;
    const sessionsDir = this.paths.sessionsDir;

    // 1. Backup existing history file
    if (await fs.pathExists(historyFile)) {
      const backupFile = `${historyFile}.bak`;
      await fs.copy(historyFile, backupFile, { overwrite: true });
      console.log(`[Manager] Backed up history file to ${backupFile}`);
    }

    // 2. Scan for all session files
    progress?.report({ message: '正在扫描会话文件...' });
    
    const dirsToScan = [sessionsDir];
    const archivedDir = path.join(this.paths.codexHome, 'archived_sessions');
    console.log(`[Manager] Checking archivedDir: ${archivedDir}`);
    if (await fs.pathExists(archivedDir)) {
        console.log(`[Manager] archivedDir exists, adding to scan list.`);
        dirsToScan.push(archivedDir);
    } else {
        console.log(`[Manager] archivedDir does NOT exist.`);
    }

    let files: string[] = [];
    for (const dir of dirsToScan) {
        console.log(`[Manager] Scanning dir: ${dir}`);
        const dirFiles = await fg('**/*.jsonl', { cwd: dir, absolute: true });
        console.log(`[Manager] Found ${dirFiles.length} files in ${dir}`);
        files = files.concat(dirFiles);
    }
    
    console.log(`[Manager] Total found ${files.length} session files in ${dirsToScan.join(', ')}`);

    const newHistoryLines: HistoryLine[] = [];
    let processedCount = 0;

    // 3. Process each file
    for (const file of files) {
      processedCount++;
      if (processedCount % 10 === 0) {
        progress?.report({ message: `正在扫描 (${processedCount}/${files.length})...`, increment: (10 / files.length) * 100 });
      }

      try {
        const sessionData = await this.parseSessionFile(file);
        if (sessionData) {
          newHistoryLines.push(sessionData);
        }
      } catch (error) {
        console.error(`[Manager] Error processing file ${file}:`, error);
      }
    }

    // 4. Sort by timestamp descending
    newHistoryLines.sort((a, b) => b.ts - a.ts);

    // 5. Write to history file
    progress?.report({ message: '正在写入索引文件...' });
    
    // Use Promise to ensure file is fully written before proceeding
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(historyFile, { flags: 'w' });
      
      stream.on('error', reject);
      stream.on('finish', resolve);
      
      for (const line of newHistoryLines) {
        stream.write(JSON.stringify(line) + '\n');
      }
      stream.end();
    });
    
    console.log(`[Manager] Rebuilt index with ${newHistoryLines.length} sessions`);
  }

  /**
   * Auto-index if history.jsonl doesn't exist or is empty
   * This is called on extension activation to ensure first-time users see their sessions
   */
  async autoIndexIfNeeded(): Promise<boolean> {
    const historyFile = this.paths.historyFile;
    const exists = await fs.pathExists(historyFile);
    
    if (!exists) {
      console.log('[Manager] history.jsonl does not exist, performing auto-index');
      await this.rebuildIndex();
      return true;
    }
    
    // Check if file is empty
    const content = await fs.readFile(historyFile, 'utf-8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    
    if (lines.length === 0) {
      console.log('[Manager] history.jsonl is empty, performing auto-index');
      await this.rebuildIndex();
      return true;
    }
    
    console.log('[Manager] history.jsonl exists with data, skipping auto-index');
    return false;
  }

  /**
   * Check for new session files not in the current index and add them incrementally
   * Returns the number of new sessions added
   */
  async checkForNewSessions(): Promise<number> {
    console.log('[Manager] Checking for new session files...');
    
    // Get all session IDs currently in the index
    const indexedSessions = new Set<string>();
    const historyFile = this.paths.historyFile;
    
    if (await fs.pathExists(historyFile)) {
      const lines = await this.readHistoryLines(false); // Don't filter by agents for this check
      lines.forEach(line => indexedSessions.add(line.session_id));
      
      // Safety check: if file exists but we found 0 sessions, something might be wrong with reading.
      // To avoid duplicating everything, we should verify if the file is actually empty.
      if (lines.length === 0) {
          const stats = await fs.stat(historyFile);
          if (stats.size > 100) {
              console.warn('[Manager] History file exists and is not empty, but no sessions read. Aborting incremental update to prevent duplicates.');
              return 0;
          }
      }
    }
    
    // Scan for all session files
    const dirsToScan = [this.paths.sessionsDir];
    const archivedDir = path.join(this.paths.codexHome, 'archived_sessions');
    if (await fs.pathExists(archivedDir)) {
      dirsToScan.push(archivedDir);
    }
    
    const allSessionFiles: string[] = [];
    for (const dir of dirsToScan) {
      const files = await fg('**/*.jsonl', {
        cwd: dir,
        absolute: true,
        ignore: ['**/trash/**', '**/sessions_Recycle/**'],
      });
      allSessionFiles.push(...files);
    }
    
    // Find new session files
    const newSessions: Array<{ file: string; isArchived: boolean }> = [];
    for (const file of allSessionFiles) {
      const filename = path.basename(file);
      // Extract sessionId from filename (e.g., rollout-YYYY-MM-DDTHH-MM-SS-UUID.jsonl)
      const match = filename.match(/rollout-[\d-T]+-([a-f0-9-]+)\.jsonl/i);
      if (match) {
        const sessionId = match[1]; // Use the UUID part as session_id
        if (!indexedSessions.has(sessionId)) {
          const isArchived = file.includes('archived_sessions');
          newSessions.push({ file, isArchived });
        }
      }
    }
    
    if (newSessions.length === 0) {
      console.log('[Manager] No new session files found');
      return 0;
    }
    
    console.log(`[Manager] Found ${newSessions.length} new session files, adding to index...`);
    
    // Process new sessions and append to history.jsonl
    const newHistoryLines: HistoryLine[] = [];
    
    for (const { file } of newSessions) {
      try {
        const sessionData = await this.parseSessionFile(file);
        if (sessionData) {
          newHistoryLines.push(sessionData);
        }
      } catch (error) {
        console.error(`[Manager] Error processing new file ${file}:`, error);
      }
    }
    
    if (newHistoryLines.length === 0) {
      return 0;
    }
    
    // Append new lines to history.jsonl
    const stream = fs.createWriteStream(historyFile, { flags: 'a' }); // append mode
    for (const line of newHistoryLines) {
      stream.write(JSON.stringify(line) + '\n');
    }
    
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      stream.on('finish', resolve);
      stream.end();
    });
    
    console.log(`[Manager] Added ${newHistoryLines.length} new sessions to index`);
    return newHistoryLines.length;
  }

  /**
   * Shared logic to parse a session file and extract summary info
   */
  private async parseSessionFile(file: string): Promise<HistoryLine | null> {
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    
    if (lines.length === 0) return null;

    let firstLine: any = null;
    let lastLine: any = null;

    // Try to parse first valid line
    for (const lineStr of lines) {
        try {
            firstLine = JSON.parse(lineStr);
            break;
        } catch (e) {}
    }

    // Try to parse last valid line (backwards)
    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            lastLine = JSON.parse(lines[i]);
            break;
        } catch (e) {}
    }

    if (!firstLine || !lastLine) return null;

    // Extract session info
    let timestamp: number | string | undefined = firstLine.timestamp || firstLine.id;
    // Convert string timestamp to number if needed
    if (typeof timestamp === 'string') {
        timestamp = new Date(timestamp).getTime();
    }
    
    if (!timestamp || isNaN(timestamp as number)) return null;

    const sessionId = firstLine.id || path.basename(file).replace(/^rollout-[\d-T]+-/, '').replace(/\.jsonl$/, '');
    const isArchived = file.includes('archived_sessions');

    // Extract text and turn count
    let turnCount = 0;
    let firstText = '';
    let lastText = '';

    // Helper to check system prompts
    const isSystemPrompt = (text: string) => {
        const lower = text.toLowerCase();
        return lower.includes('you are in a project') || 
               lower.includes('agents.md') || 
               lower.includes('system:');
    };
    
    // Helper to clean text
    const cleanFirstText = (rawText: string) => {
      if (!rawText) return '';
      // Remove all line breaks (\r\n, \n, \r) and replace with space
      const cleaned = rawText.replace(/[\r\n]+/g, ' ');
      // Remove excessive whitespace
      const trimmed = cleaned.replace(/\s+/g, ' ').trim();
      // Limit to a reasonable display length
      return trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
    };

    for (const lineStr of lines) {
        try {
            const parsed = JSON.parse(lineStr);
            
            // New format: type: "event_msg" with payload.type: "user_message"
            if (parsed.type === 'event_msg' && parsed.payload?.type === 'user_message') {
                const message = parsed.payload.message || '';
                let extractedText = '';
                
                // Extract just the user's actual request, skipping IDE context
                const match = message.match(/##\s*My request for Codex:\s*(.+)$/s);
                if (match && match[1]) {
                    extractedText = match[1].trim();
                } else {
                    extractedText = message.trim();
                }
                
                // Skip if it's a system prompt
                if (!isSystemPrompt(extractedText)) {
                    if (!firstText) firstText = extractedText;
                    turnCount++;
                }
            }
            // Legacy format: role: "user"
             if (parsed.type === 'user_item') {
                const text = parsed.payload.content;
                if (text && !isSystemPrompt(text)) {
                    if (!firstText) firstText = text;
                    lastText = text; // Update lastText for user_item
                    turnCount++;
                }
            }
            // Another format: type: "response_item" with payload.role: "user"
            else if (parsed.type === 'response_item' && parsed.payload?.role === 'user') {
                const content = parsed.payload.content;
                if (Array.isArray(content) && content[0]?.text) {
                    const text = content[0].text;
                    
                    // Skip if it's environment context
                    if (isSystemPrompt(text)) {
                        continue;
                    }
                    
                    // Try to extract actual user request
                    const match = text.match(/##\s*My request for Codex:\s*(.+)$/s);
                    if (match && match[1]) {
                        if (!firstText) firstText = match[1].trim();
                    }
                    turnCount++;
                }
            }
        } catch (e) {}
    }

    const cleanedFirstText = cleanFirstText(firstText || '(空会话)');

    return {
      session_id: sessionId,
      ts: timestamp as number,
      first_text: cleanedFirstText,
      last_text: lastText || cleanedFirstText, // Fallback to first text if last text not found
      turn_count: turnCount, // Return actual turn count (0 if empty)
      is_archived: isArchived
    };
  }


  async readSessionMessages(
    sessionId: string,
    options: { limit?: number; hideAgents?: boolean } = {}
  ): Promise<{ filePath: string; messages: SessionMessage[]; remark?: string }> {
    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) {
      throw new Error(`在 sessions 目录中未找到会话文件，ID=${sessionId}`);
    }

    const messages: SessionMessage[] = [];
    let lastText = '';
    let turnCount = 0;
        
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, 'utf-8'),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
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

  async pin(sessionId: string): Promise<void> {
    await this.state.pin(sessionId);
  }

  async unpin(sessionId: string): Promise<void> {
    await this.state.unpin(sessionId);
  }

  async archiveSession(sessionId: string): Promise<void> {
    const file = await this.findSessionFile(sessionId);
    if (!file) {
      throw new Error(`会话文件未找到: ${sessionId}`);
    }

    // Check if already archived
    if (file.includes('archived_sessions')) {
      throw new Error('会话已经归档');
    }

    // Create archived_sessions directory if it doesn't exist
    const archivesDir = path.join(path.dirname(this.paths.sessionsDir), 'archived_sessions');
    await fs.ensureDir(archivesDir);

    // Move file to archived_sessions
    const fileName = path.basename(file);
    const destPath = path.join(archivesDir, fileName);
    await fs.move(file, destPath, { overwrite: true });

    // Rebuild index to update history.jsonl
    await this.rebuildIndex();
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const file = await this.findSessionFile(sessionId);
    if (!file) {
      throw new Error(`会话文件未找到: ${sessionId}`);
    }

    // Check if in archived_sessions
    if (!file.includes('archived_sessions')) {
      throw new Error('会话未归档');
    }

    const fileName = path.basename(file);
    
    // Parse date from filename: rollout-YYYY-MM-DDTHH-MM-SS-UUID.jsonl
    // Extract YYYY-MM-DD part
    const dateMatch = fileName.match(/(\d{4})-(\d{2})-(\d{2})T/);
    
    let destPath: string;
    if (dateMatch) {
      const [, year, month, day] = dateMatch;
      // Create date-structured path: sessions/YYYY/MM/DD/
      const dateDir = path.join(this.paths.sessionsDir, year, month, day);
      await fs.ensureDir(dateDir);
      destPath = path.join(dateDir, fileName);
    } else {
      // Fallback: if date parsing fails, put in root sessions directory
      destPath = path.join(this.paths.sessionsDir, fileName);
    }
    
    // Move file back to sessions directory
    await fs.move(file, destPath, { overwrite: true });

    // Rebuild index to update history.jsonl
    await this.rebuildIndex();
  }

  async deleteSessions(sessionIds: string[], options: { backupHistory?: boolean } = {}): Promise<DeleteResult> {
    const idSet = new Set(sessionIds);
    const removedFiles: string[] = [];
    const notFoundFiles: string[] = [];

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

    // NOTE: We do NOT clear state (pinned/remarks) here so they can be preserved when restored from recycle bin

    return { removedHistory, removedFiles, notFoundFiles };
  }

  async getResumeCommand(sessionId: string): Promise<string> {
    // Extract UUID from session ID (e.g., "rollout-2025-11-10T21-20-20-019a6dec-b4b4-75e2-a33f-9e077e7ad797" -> "019a6dec-b4b4-75e2-a33f-9e077e7ad797")
    // The UUID is the last part after the last "-" that follows the timestamp
    const parts = sessionId.split('-');
    // UUID format: 8-4-4-4-12 characters, so we need the last 5 parts
    if (parts.length >= 5) {
      const uuid = parts.slice(-5).join('-');
      return `codex resume ${uuid}`;
    }
    // Fallback to full session ID if parsing fails
    return `codex resume ${sessionId}`;
  }

  async setRemark(sessionId: string, remark: string): Promise<void> {
    await this.state.setRemark(sessionId, remark);
  }

  async listRecycleBin(): Promise<SessionSummary[]> {
    const trashDir = this.paths.trashDir;
    if (!(await fs.pathExists(trashDir))) {
      return [];
    }

    const files = await fg('**/*.jsonl', {
      cwd: trashDir,
      absolute: true,
    });

    const summaries: SessionSummary[] = [];

    // Get active session IDs to filter them out
    const activeSessions = await this.readHistoryLines(false);
    const activeSessionIds = new Set(activeSessions.map(s => s.session_id));

    for (const file of files) {
      try {
        const sessionData = await this.parseSessionFile(file);
        if (sessionData) {
          // Filter out active sessions
          if (activeSessionIds.has(sessionData.session_id)) {
            continue;
          }

          // Filter out empty sessions (count=0)
          // We trust turn_count=0 means it's empty (system prompts don't count)
          if (sessionData.turn_count === 0) {
            continue;
          }

          // Strict filter: if text is explicitly "(空会话)", do not show in recycle bin
          if (sessionData.first_text === '(空会话)') {
              continue;
          }

          // Get file modification time as deletion time approximation if needed
          // For now just use session data
          const stats = await fs.stat(file);
          
          // Get metadata from state
          const state = await this.state.getSessionState(sessionData.session_id);
          const isArchived = file.includes('archived_sessions');
          
          summaries.push({
            sessionId: sessionData.session_id,
            firstTs: sessionData.ts,
            lastTs: stats.mtimeMs, // Use modification time (likely deletion time) for sorting
            firstText: sessionData.first_text || '(空会话)',
            lastText: sessionData.last_text || '',
            count: sessionData.turn_count || 0,
            pinned: state.pinned,
            isArchived: isArchived,
            remark: state.remark
          });
        }
      } catch (error) {
        console.error(`[Manager] Error parsing recycle bin file ${file}:`, error);
      }
    }

    // Sort by deletion time (mtime) descending
    return summaries.sort((a, b) => b.lastTs - a.lastTs);
  }

  async getRecycleBinSessionContent(sessionId: string): Promise<string[]> {
    const trashDir = this.paths.trashDir;
    const files = await fg(`**/*${sessionId}*.jsonl`, {
      cwd: trashDir,
      absolute: true,
    });

    if (files.length === 0) {
      throw new Error(`在回收站中未找到会话 ${sessionId}`);
    }

    const file = files[0];
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    const historyLines: string[] = [];

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        // Format similar to getSessionHistory
        if (data.role === 'user') {
          historyLines.push(`\n👤 **User**\n${data.content}\n`);
        } else if (data.role === 'model' || data.role === 'assistant') {
          historyLines.push(`\n🤖 **Model**\n${data.content}\n`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    return historyLines;
  }

  async restoreFromRecycleBin(sessionId: string): Promise<void> {
    const trashDir = this.paths.trashDir;
    
    // Find file in trash
    const files = await fg(`**/*${sessionId}*.jsonl`, {
      cwd: trashDir,
      absolute: true,
    });

    if (files.length === 0) {
      throw new Error(`在回收站中未找到会话 ${sessionId}`);
    }

    const sourceFile = files[0];
    const filename = path.basename(sourceFile);
    
    // Determine restore path
    // Try to extract date from filename or use current date
    // Filename format: rollout-YYYY-MM-DDTHH-MM-SS-UUID.jsonl
    let targetDir = this.paths.sessionsDir;
    
    const match = filename.match(/rollout-(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [_, year, month, day] = match;
      targetDir = path.join(this.paths.sessionsDir, year, month, day);
    }
    
    const targetFile = path.join(targetDir, filename);
    
    await fs.ensureDir(targetDir);
    await fs.move(sourceFile, targetFile, { overwrite: false });
    
    // Add to index
    const sessionData = await this.parseSessionFile(targetFile);
    if (sessionData) {
      const historyFile = this.paths.historyFile;
      await fs.appendFile(historyFile, JSON.stringify(sessionData) + '\n');
    }
  }

  private async readHistoryLines(hideAgents: boolean): Promise<HistoryLine[]> {
    const file = this.paths.historyFile;
    const exists = await fs.pathExists(file);
    if (!exists) return [];

    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const parsed: HistoryLine[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as HistoryLine;
        // Allow text to be missing if first_text or last_text is present
        if (obj.session_id && obj.ts && (obj.text !== undefined || obj.first_text !== undefined || obj.last_text !== undefined)) {
          // 确保 text 是字符串，避免 null 或其他类型导致 crash
          if (obj.text !== undefined && typeof obj.text !== 'string') {
            obj.text = String(obj.text || '');
          }
          
          // Check against text or last_text/first_text for agents filtering
          const checkText = obj.text || obj.last_text || obj.first_text || '';
          if (hideAgents && isAgentsText(checkText)) {
            continue;
          }
          parsed.push(obj);
        }
      } catch (error) {
        // ignore bad line
      }
    }

    return parsed;
  }

  private async rewriteHistoryExcluding(sessionIds: Set<string>, backupHistory: boolean): Promise<number> {
    const file = this.paths.historyFile;
    if (!(await fs.pathExists(file))) return 0;

    const tempFile = file + '.tmp';
    const backupFile = file + '.bak';
    let removed = 0;

    const input = fs.createReadStream(file, 'utf-8');
    const output = fs.createWriteStream(tempFile, { encoding: 'utf-8' });

    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch (error) {
        output.write(line + '\n');
        continue;
      }

      if (sessionIds.has(obj.session_id)) {
        removed += 1;
        continue;
      }
      output.write(line + '\n');
    }

    await new Promise<void>((resolve, reject) => {
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

function toMessage(entry: any): SessionMessage | null {
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

function extractContentText(content: any): string {
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text ?? item?.value ?? '')
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    return content.text ?? content.value ?? '';
  }
  return '';
}

export function formatTs(ts: number): string {
  return dayjs.unix(ts).format('YYYY-MM-DD HH:mm:ss');
}

function isAgentsText(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return (
    normalized.includes('agents.md') ||
    normalized.includes('系统提示词') ||
    normalized.includes('你是一个资深全栈技术专家') ||
    normalized.startsWith('<instructions>') ||
    normalized.includes('mcp 调用规则')
  );
}
