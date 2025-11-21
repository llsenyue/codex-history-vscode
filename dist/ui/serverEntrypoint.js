import { startServer } from '../server.js';
export function registerWebCommand(program) {
    program
        .command('web')
        .description('启动 Web 界面（浏览器窗口）')
        .option('-p, --port <number>', '端口，默认 4175', (v) => Number(v))
        .option('--no-open', '不自动打开浏览器')
        .action(async (options, command) => {
        const globals = command.optsWithGlobals();
        await startServer({
            port: options.port ?? 4175,
            openBrowser: options.open !== false,
            codexHome: globals.codexHome,
            managerHome: globals.managerHome,
        });
    });
}
