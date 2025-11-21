# Codex 历史对话管理器

一个面向 Codex CLI 的本地历史记录管理工具，支持加载 `~/.codex` 下的历史对话，快速执行删除/预览/置顶，并一键复制 `codex resume <sessionId>` 命令。提供命令行、TUI、Web 三种界面。

## 功能概览
- 列表：按时间倒序展示会话，支持关键字筛选、仅查看置顶。
- 预览：读取对应的 `sessions/*.jsonl` 文件，查看最近消息内容。
- 置顶/取消置顶：将常用会话置顶显示，状态存储在 `~/.codex-history/state.json`。
- 删除：重写 `history.jsonl` 以移除指定会话，并将会话文件移动到回收站（`~/.codex-history/trash/sessions`）。
- 复制 resume 命令：输出并可写入剪贴板，方便在 Codex CLI 里直接粘贴启动。
- Web 界面：浏览器内可视化管理，点击即预览/置顶/删除/复制。

## 快速开始
```bash
npm install
npm run build
# 如需全局使用，可执行（可选）
npm link
```

执行完后，可用 `node dist/index.js` 或全局命令 `codex-history`：

# 查看最近 20 个会话（默认过滤 AGENTS.md 内容，可用 --show-agents 显示）
codex-history list

# 按关键字搜索并只显示置顶
codex-history list --search "飞书" --pinned

# 预览指定会话前 5 条消息（支持 --show-agents）
codex-history preview <sessionId> -n 5

# 置顶 / 取消置顶
codex-history pin <sessionId>
codex-history unpin <sessionId>

# 删除（重写 history.jsonl，并把会话文件移到回收站），--yes 跳过确认
codex-history delete <sessionId1> [sessionId2 ...] --yes

# 输出并复制 resume 命令；若不想写剪贴板，追加 --no-clipboard
codex-history copy <sessionId>

# 设置或清空备注（备注会在列表和预览首行展示）
codex-history remark <sessionId> 这是个重要调试
codex-history remark <sessionId>    # 留空即清除

# 启动交互式界面（TUI）
codex-history ui

# 启动 Web 界面（默认自动打开浏览器，端口 4175）
codex-history web --port 4175 --no-open
```

## Web 界面操作
- URL：默认 `http://localhost:4175`（端口可在命令行指定）。
- 左侧为会话列表，支持搜索、“仅置顶”、“屏蔽 AGENTS.md”筛选；右侧展示消息预览。
- 列表标题下方会显示备注摘要；预览区域第一行也会显示备注，可在输入框中修改并保存。
- 按钮：
  - 复制 resume 命令：直接写入浏览器剪贴板。
  - 置顶/取消置顶：更新状态并刷新列表。
  - 删除：需要确认，删除后会话文件移动到回收站且 `history.jsonl` 重写。
- 注意：删除操作与 CLI 行为一致，默认保留 `history.jsonl.bak` 备份（由服务端逻辑负责）。
- 注意：删除操作与 CLI 行为一致，默认保留 `history.jsonl.bak` 备份（由服务端逻辑负责）。

## 默认路径与可配置项
- Codex 数据目录：`~/.codex`（可用 `--codex-home <path>` 覆盖）。
  - 历史文件：`history.jsonl`
  - 会话存放：`sessions/**/rollout-*.jsonl`
- 管理器状态目录：`~/.codex-history`（可用 `--manager-home <path>` 覆盖）。
  - 置顶状态：`state.json`
  - 回收站：`trash/sessions`

示例：
```bash
codex-history --codex-home /custom/.codex --manager-home /tmp/codex-history list
codex-history web --codex-home /custom/.codex --manager-home /tmp/codex-history --port 8080
```

## 注意事项
- 删除操作会重写 `history.jsonl`。默认会在同目录生成备份 `history.jsonl.bak`；若不需要，可加 `--no-backup`（CLI 删除）。
- 预览阶段会遍历 `sessions` 目录查找包含指定 ID 的文件；如有多个匹配，将读取第一个匹配的文件。
- 默认会过滤掉 Codex 自动注入的 `AGENTS.md` 指令内容，若需查看可在 CLI/TUI 加 `--show-agents` 或在 Web 关闭“屏蔽 AGENTS.md”。
- 备注信息持久存储在 `~/.codex-history/state.json`，删除会话时会自动清空相应备注。
- 剪贴板功能依赖系统剪贴板，在无桌面环境时可能失败；工具会提示并仍然打印命令（CLI）或给出错误消息（Web）。
- TUI 键位：↑/↓ 移动，Space 预览，p 置顶/取消，c/Enter 复制 resume，d 删除（需确认），r 刷新，q 退出；在非交互式终端（raw mode 不可用）请改用 CLI/Web。

## 开发/构建
- 构建：`npm run build`
- 开发调试：`npm run dev -- <subcommand>`（使用 ts-node）

## 打包成独立应用（方案 A）
- 依赖 [pkg](https://github.com/vercel/pkg) 生成跨平台单文件可执行。
- 步骤：
  1. `npm run package:bin`
  2. 在 `build/` 目录获得 `codex-history-linux`、`codex-history-macos`、`codex-history-win.exe`
- 分发：将对应文件拷贝到目标机器（仍需访问 `~/.codex` 数据），直接运行：
  - `./codex-history-linux web` 或 `codex-history-win.exe web` —— 运行 Web 界面
  - 其他 subcommand 同 CLI 用法，例如 `./codex-history-linux list`
- 这些可执行文件已经包含 `dist/` JS 与 `public/` 静态资源，无需 Node/TS 编译环境。

## VS Code 插件
- 目录：`vscode-extension`
- 功能：在 VS Code 内通过 Webview 管理 Codex 历史（会话列表、搜索、置顶、备注、复制 resume、删除、屏蔽 AGENTS 文本）。
- 开发/调试：
  1. `cd vscode-extension`
  2. `npm install`
  3. `npm run compile`
  4. 在 VS Code 中使用 “运行与调试” -> “扩展” 启动，即可在新窗口中通过命令面板执行 “Codex History: 打开 Codex 历史管理”。
- 插件依赖与历史数据使用规则与 CLI 相同：默认读取当前系统用户目录下的 `~/.codex`，如需跨环境，可通过设置 `--codex-home`（后续可扩展配置项）。

## 已知不足与后续增强想法
- 尚未提供批量导出/归档能力，可后续添加 JSON/CSV 导出。
- Web 界面未做分页，默认最多加载 200 条，可在服务器或前端增加分页/排序切换。
- 预览目前只提取用户/助手的文本消息，其他事件内容未完全展示；如需完整事件流，可扩展解析逻辑。
