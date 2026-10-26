# DeepSeek Harness ↔ Codex 双向协作桥

简体中文 | [English](README.en.md) | [Windows 说明](WINDOWS.md)

本分支文档撰稿与整理：**TheoWang123666、Codex（OpenAI AI 助手）**。

版本：`0.2.9-windows.2`。本代码基于 [Aloneswork/deepseek-harness-codex-bridge](https://github.com/Aloneswork/deepseek-harness-codex-bridge)，增加原生 Windows 支持、项目固定会话、增量共享上下文与排队回复恢复。来源与基础版本见 [UPSTREAM.md](UPSTREAM.md)，原 MIT 许可证完整保留于 [LICENSE](LICENSE)。

这是非官方的本地 MCP 桥，与 DeepSeek、OpenAI 均无隶属或官方认可关系。运行配置由使用者自行提供；源码不包含账号凭据、项目绑定或聊天记录。

## 通用功能

- Codex 向 DSH 委派有明确范围的任务；DSH 可通过 `ask_codex` 或终端命令联系 Codex。
- `DSH_BRIDGE_LEAD=dsh` 选择 DSH 主导模式；未设置时保持 Codex 主导的兼容模式。
- 配对项目复用一个 Codex 对话和一个兼容的 DSH headless 会话；忙碌、无效或超时不自动另开。
- 共享记录按项目、方向、原生会话增量投递。预算放不下的条目继续等待；长记录提供完整快照和索引。
- 排队受理不等于完成。只有取得相应回合的真实最终回复才确认上下文已送达；重试保留原快照。
- 支持 Windows、macOS、Linux。Windows 可发现官方桌面版内置 CLI，不需要 WSL。

## 安装与配置

需要 Node.js `>=22.19.0`、已配置的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，以及用于 DSH → Codex 通信的 Codex CLI。当前 DSH 的运行要求更高时，应遵守其要求；建议 Node.js 24 LTS。

下载本仓库的源码后，在源码目录执行：

```powershell
npm ci --ignore-scripts
npm test
npm run check
node .\diagnose.mjs --mcp-config
```

诊断命令只打印此份源码对应的配置。将输出合并到自己的 `~/.codex/config.toml`，保留已有设置，随后重载对应 MCP 服务。上游链接用于注明来源；上游发布包不一定包含本版的增强功能。

`diagnose.mjs --mcp-config` 默认启用四个 Codex 任务工具。使用项目配对与共享记录时，在同一配置节保留生成的 `command`、`args`，将工具列表扩展为：

```toml
[mcp_servers.deepseek_harness]
tool_timeout_sec = 900
enabled_tools = [
  "delegate_to_deepseek",
  "list_deepseek_messages",
  "reply_to_deepseek",
  "get_bridge_task_status",
  "list_project_links",
  "read_project_context",
  "share_project_context",
]
```

这些设置不授予任务以外的权限。是否免逐次确认调用，由使用者明确授权。

DSH 端运行同一 `server.mjs`，在其 MCP 配置中设置 `DSH_BRIDGE_ROLE=dsh`，即可提供 `ask_codex`。双方都提供三个项目工具；需要两端共享状态时，`DSH_CODEX_MAILBOX_DIR` 应指向同一个由使用者保管的私有邮箱目录。协作主导方向可在两端一致设置 `DSH_BRIDGE_LEAD`。

如需复用 DSH 自己保存的桌面账号登录，可打印显式选择的认证 overlay 配置：

```powershell
node .\diagnose.mjs --mcp-config --stored-auth
```

随附的 `profiles/headless-stored-auth.yml` 只是通用启动模板，不含凭据。DSH 自己读取有效登录；桥不提取或复制登录 token。未选择该模式时，使用 DSH headless 的默认认证方式。Windows 入口和环境变量详见 [WINDOWS.md](WINDOWS.md)。

## 配对并绑定已有会话

以下名称、目录和 ID **全部为示例占位**。先换成自己存在的工作区及经核实的已有会话 ID：

```powershell
node .\server.mjs link-projects --name example-project --codex-workspace 'C:\Projects\CodexWorkspace' --dsh-workspace 'C:\Projects\DshWorkspace'
node .\server.mjs bind-project-conversation --link-id example-project --thread-id EXISTING_CODEX_THREAD_ID --reason '选择已有协作对话'
node .\server.mjs bind-project-dsh-session --link-id example-project --session-id EXISTING_DSH_SESSION_ID --reason '选择兼容的已有headless会话'
node .\server.mjs project-links
```

关联项目缺少默认 DSH 绑定、且请求未显式选择已有会话时会报错，不自动创建。普通请求只传 `projectLinkId` 和当前问题，省略两端 ID 即可复用。例如 Codex 调用 `delegate_to_deepseek`：

```json
{"projectLinkId":"example-project","task":"请检查这个最小复现，并给出原因和建议。"}
```

DSH 调用 `ask_codex` 时使用 `message`，并附简短的 `progress` 或 `evidence`：

```json
{"projectLinkId":"example-project","message":"请审查这处修改的边界。","progress":"已完成最小复现。","evidence":"相关文件与测试摘要。"}
```

同一项未完成请求应保留返回的 `taskId` 和回执。只有确有隔离上下文的需要时，才用 `newConversation: true` 与非空 `newConversationReason` 选择新的 Codex 对话；旧任务不能悄悄改绑。DSH 改绑通过显式 CLI 命令并说明原因。不要用新会话绕过繁忙、排队或超时。

## 工具和终端入口

Codex 角色有四个任务工具：`delegate_to_deepseek`、`list_deepseek_messages`、`reply_to_deepseek`、`get_bridge_task_status`。双方有 `list_project_links`、`read_project_context`、`share_project_context`；DSH 角色另有 `ask_codex`。

`deepseek-harness-mcp` 是 stdio MCP 服务；`dsh-codex-mail` 是邮箱与主动聊天 CLI。未全局安装时，可用 `node ./server.mjs` 运行相同命令。完整命令帮助：

```powershell
node .\server.mjs help
```

终端中的 `send`、`inbox`、`status`、`chat` 用于跟踪已分配任务。项目模式优先使用已有默认绑定；未配对流程的首次 `chat` 仍可创建 Codex 线程。DSH 进程停止后，需要外部调用再次启动它才能继续协作；桥不是永久在线的聊天机器人。

## 数据与验证边界

消息、绑定与投递状态默认位于 `~/.dsh-codex-bridge/`；完整上下文快照可位于工作区的 `.dsh-codex-bridge/`。这些是使用者的运行数据，不应提交或分享。共享工具仅交换明确发布的摘要，不扫描全部私人聊天历史。

大材料使用工作区文件路径；避免把共享记录全文反复复制进请求。默认超时为 `900000` 毫秒，MCP 客户端等待时间不应更短。可选变量包括 `DSH_BIN`、`DSH_DESKTOP_DIR`、`DSH_BRIDGE_PATCH`、`CODEX_BIN`、`DSH_CODEX_MAILBOX_DIR`、`DSH_BRIDGE_TIMEOUT_MS`、`DSH_CODEX_CHAT_TIMEOUT_MS`、`DSH_BRIDGE_ROLE` 与 `DSH_BRIDGE_LEAD`。

`npm test` 使用隔离临时目录和假 Agent，不需要账号或模型调用。真实联调需使用者自行配置模型与登录，明确授权，并核对真实回复和会话 ID。仓库包含跨平台 CI 定义；是否通过以对应提交的实际 CI 结果为准。

可在本地执行 `npm pack` 生成安装包。发布前检查实际包文件清单，排除运行邮箱、真实配置、日志和测试证据。MIT 许可证与原版权声明必须随代码和发行包保留。
