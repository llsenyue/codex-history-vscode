#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import clipboardy from 'clipboardy';
import dayjs from 'dayjs';
import { buildPaths, ensureManagerDirs } from './paths.js';
import { StateStore } from './state.js';
import { HistoryManager, formatTs } from './historyManager.js';
import { launchUI } from './ui/index.js';
import { registerWebCommand } from './ui/serverEntrypoint.js';
import readline from 'readline';
const program = new Command();
program
    .name('codex-history')
    .description('Codex 历史对话管理器：列出、预览、置顶、删除、复制 resume 命令')
    .option('-c, --codex-home <path>', 'Codex 主目录，默认 ~/.codex')
    .option('-m, --manager-home <path>', '管理器状态目录，默认 ~/.codex-history')
    .version('0.1.0');
program
    .command('list')
    .description('列出历史会话')
    .option('-l, --limit <number>', '最多显示数量，默认 20', parseNumber)
    .option('-s, --search <keyword>', '按文本包含搜索')
    .option('-p, --pinned', '仅显示置顶会话')
    .option('--show-agents', '显示 AGENTS.md 的提示内容（默认隐藏）')
    .action(async (options, command) => {
    const manager = await createManager(command.optsWithGlobals());
    const limit = options.limit ?? 20;
    const summaries = await manager.listSummaries({
        search: options.search,
        limit,
        onlyPinned: options.pinned,
        hideAgents: !options.showAgents,
    });
    if (!summaries.length) {
        console.log(chalk.yellow('没有匹配的会话。'));
        return;
    }
    printSummaryTable(summaries);
});
program
    .command('preview <sessionId>')
    .description('预览指定会话的消息内容')
    .option('-n, --limit <number>', '最多加载的消息条数（从头算起）', parseNumber)
    .option('--show-agents', '显示 AGENTS.md 的提示内容（默认隐藏）')
    .action(async (sessionId, options, command) => {
    const manager = await createManager(command.optsWithGlobals());
    try {
        const { filePath, messages, remark } = await manager.readSessionMessages(sessionId, {
            limit: options.limit,
            hideAgents: !options.showAgents,
        });
        console.log(chalk.gray(`会话文件: ${filePath}`));
        console.log(chalk.yellow(`备注: ${remark || '（无）'}`));
        console.log(chalk.gray('---'));
        messages.forEach((msg, idx) => {
            const time = msg.timestamp ? dayjs(msg.timestamp).format('YYYY-MM-DD HH:mm:ss') : '-';
            const role = msg.role === 'assistant' ? chalk.cyan('assistant') : chalk.green(msg.role);
            console.log(chalk.white(`[${idx + 1}] ${time} ${role}`));
            console.log(msg.text || chalk.gray('(无文本内容)'));
            if (idx !== messages.length - 1) {
                console.log(chalk.gray('---'));
            }
        });
    }
    catch (error) {
        console.error(chalk.red(error.message ?? error));
        process.exitCode = 1;
    }
});
program
    .command('pin <sessionId>')
    .description('置顶会话')
    .action(async (sessionId, _, command) => {
    const manager = await createManager(command.optsWithGlobals());
    await manager.pin(sessionId);
    console.log(chalk.green(`已置顶 ${sessionId}`));
});
program
    .command('unpin <sessionId>')
    .description('取消置顶会话')
    .action(async (sessionId, _, command) => {
    const manager = await createManager(command.optsWithGlobals());
    await manager.unpin(sessionId);
    console.log(chalk.green(`已取消置顶 ${sessionId}`));
});
program
    .command('delete <sessionIds...>')
    .description('删除会话（会重写 history.jsonl 并将会话文件移到回收站）')
    .option('-y, --yes', '跳过确认')
    .option('--no-backup', '删除时不保留 history.jsonl.bak')
    .action(async (sessionIds, options, command) => {
    const manager = await createManager(command.optsWithGlobals());
    if (!options.yes) {
        const confirmed = await confirm(`确认删除 ${sessionIds.length} 个会话？此操作会重写 history.jsonl 并移动会话文件。`);
        if (!confirmed) {
            console.log(chalk.yellow('已取消。'));
            return;
        }
    }
    try {
        const result = await manager.deleteSessions(sessionIds, { backupHistory: options.backup !== false });
        console.log(chalk.green(`已从 history.jsonl 中移除 ${result.removedHistory} 行。`));
        if (result.removedFiles.length) {
            console.log(chalk.green(`会话文件已移动到回收站: ${result.removedFiles.length} 个`));
        }
        if (result.notFoundFiles.length) {
            console.log(chalk.yellow(`未找到会话文件: ${result.notFoundFiles.join(', ')}`));
        }
    }
    catch (error) {
        console.error(chalk.red(error.message ?? error));
        process.exitCode = 1;
    }
});
program
    .command('copy <sessionId>')
    .description('输出并复制 codex resume 命令')
    .option('--no-clipboard', '不写入剪贴板，只打印')
    .action(async (sessionId, options, command) => {
    const manager = await createManager(command.optsWithGlobals());
    const cmd = await manager.copyResumeCommand(sessionId);
    let copied = false;
    if (options.clipboard !== false) {
        try {
            await clipboardy.write(cmd);
            copied = true;
        }
        catch (error) {
            copied = false;
            console.error(chalk.yellow('写入剪贴板失败，仅输出命令。'));
        }
    }
    console.log(cmd);
    if (copied) {
        console.log(chalk.green('已复制到剪贴板。'));
    }
});
program
    .command('ui')
    .description('启动交互式界面（可视化列表/预览/置顶/删除/复制）')
    .option('-l, --limit <number>', '最多加载的会话数量，默认 50', parseNumber)
    .action(async (options, command) => {
    const manager = await createManager(command.optsWithGlobals());
    const ink = launchUI(manager, { limit: options.limit ?? 50 });
    if (ink.waitUntilExit) {
        await ink.waitUntilExit();
    }
});
registerWebCommand(program);
program
    .command('remark <sessionId> [text...]')
    .description('设置会话备注（不填文本则清空）')
    .action(async (sessionId, textParts = []) => {
    const manager = await createManager(program.optsWithGlobals ? program.optsWithGlobals() : program.opts());
    const remark = textParts.join(' ').trim();
    await manager.setRemark(sessionId, remark);
    console.log(remark ? chalk.green(`已设置备注: ${remark}`) : chalk.yellow('已清空备注'));
});
program.parseAsync().catch((error) => {
    console.error(chalk.red(error?.message ?? error));
    process.exit(1);
});
async function createManager(options) {
    const paths = buildPaths(options.codexHome, options.managerHome);
    await ensureManagerDirs(paths);
    const state = new StateStore(paths);
    await state.load();
    return new HistoryManager(paths, state);
}
function parseNumber(input) {
    const n = Number(input);
    if (Number.isNaN(n)) {
        throw new Error(`需要数字参数，收到: ${input}`);
    }
    return n;
}
function printSummaryTable(summaries) {
    const table = new Table({
        head: ['置顶', '会话ID', '备注', '最近时间', '最后消息', '条数'],
        style: { head: ['cyan'] },
        wordWrap: true,
    });
    summaries.forEach((item) => {
        table.push([
            item.pinned ? chalk.yellow('★') : '',
            item.sessionId,
            item.remark ? chalk.yellow(truncate(item.remark, 20)) : '',
            formatTs(item.lastTs),
            truncate(item.lastText, 80),
            item.count,
        ]);
    });
    console.log(table.toString());
}
function truncate(text, maxLen) {
    if (!text)
        return '';
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen - 1) + '…';
}
async function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${question} [y/N] `, (answer) => {
            rl.close();
            const normalized = answer.trim().toLowerCase();
            resolve(normalized === 'y' || normalized === 'yes');
        });
    });
}
