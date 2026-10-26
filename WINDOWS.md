# Windows guide

版本 `0.2.9-windows.2`，基于 [Aloneswork/deepseek-harness-codex-bridge](https://github.com/Aloneswork/deepseek-harness-codex-bridge) 的 `b17d6d9774f558fa724a9d04823a305c6554364a`。原 MIT 许可证保留于 [LICENSE](LICENSE)。以下目录与 ID 均为通用示例，需替换为使用者自己的值。

## 运行环境

桥自身要求 Node.js `>=22.19.0`；遵守所安装 DSH 的运行要求，建议使用 Node.js 24 LTS。准备已配置的 DSH，以及用于反向请求的 Codex CLI。

在本仓库源码目录执行：

```powershell
npm ci --ignore-scripts
npm test
npm run check
node .\server.mjs help
```

`npm run check` 只检查本地入口与依赖，不读取登录凭据、不调用模型或修改设置。没有参数的 `server.mjs` 是等待客户端连接的 stdio MCP 服务。可选启动脚本为 `scripts\Start-Bridge.ps1`；若本机执行策略不允许脚本，直接使用 Node 命令，无需改变系统策略。

## MCP 配置

```powershell
node .\diagnose.mjs --mcp-config
```

该命令根据当前安装位置打印 Node 与脚本路径。将输出合并到自己的 `.codex\config.toml`，保留已有配置和同名配置节，然后重载相关 MCP 服务。生成器默认启用四个 Codex 任务工具；使用项目功能时，按 [README.md](README.md) 额外启用三个项目工具。

DSH 端配置同一脚本并设置 `DSH_BRIDGE_ROLE=dsh`。两端的邮箱目录应一致，主导方向由 `DSH_BRIDGE_LEAD` 配置。项目注册、固定已有会话的命令示例见 README；关联项目缺少 DSH 绑定会报错，不自动创建会话。

## 认证与 CLI 选择

如已安装官方 Windows 桌面版且不在 PATH，桥会检查 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，复用其内置 CLI。非默认目录可在当前终端设置：

```powershell
$env:DSH_DESKTOP_DIR = 'D:\Apps\DeepSeek Harness'
npm run check
```

需要显式复用 DSH 自己保存的桌面登录时：

```powershell
node .\diagnose.mjs --mcp-config --stored-auth
```

这会选择随附的通用 `profiles/headless-stored-auth.yml` overlay。认证由 DSH 读取，不包含或提取 token。使用者需要自己的有效登录；没有选择此模式时，遵守 DSH headless 的默认认证要求。参见 [DSH 官方认证说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md#credentials)。

也可在当前 PowerShell 设置 overlay，仅影响当前进程及子进程：

```powershell
$env:DSH_BRIDGE_PATCH = Join-Path $PWD 'profiles\headless-stored-auth.yml'
```

已存在的 PATH 命令优先；显式设置 `DSH_BIN` 时，错误路径不会被自动桌面发现掩盖。普通 npm CLI 示例使用环境变量，不硬编码用户目录：

```powershell
$env:DSH_BIN = Join-Path $env:APPDATA 'npm\dsh.cmd'
$env:CODEX_BIN = 'C:\Tools\Codex\codex.exe'
npm run check
```

这些是示例位置。变量只填写一个可执行文件或 JavaScript 入口，不含额外命令参数。也支持官方桌面版的 `resources\runtime\cli\bin\dsh.cmd` 或根目录的 `DeepSeek Harness.exe`。桌面客户端通过其 MCP 配置的环境变量提供相同设置。

## Windows 适配

- 启动原生 `.exe` 或以当前 Node 启动 `.js`、`.mjs`、`.cjs` 入口。
- 识别官方桌面固定启动器与 ASAR 布局，以 Electron Node 模式后台运行 CLI。
- 解析 npm 生成的 `.cmd` / `.ps1` 启动器，直接定位 Node 入口；不把提示拼入 shell 命令。
- 自定义任意批处理脚本不作为 shell 执行；应指定实际可执行文件或 JavaScript 入口。
- 处理 PATH 大小写、中文、空格和 Windows 保留设备名称；子进程不弹控制台窗口。
- 超时、取消或断连时，只清理由本桥创建且仍存活的根进程及其后代，不按进程名批量结束其他任务。
- 终端回邮命令使用 Node 和脚本的明确路径，并提供 PowerShell 调用格式。

Windows 原生命令行存在总长度限制，源码会在启动前检查 UTF-16 参数长度。材料过长时使用工作区文件路径。已自行脱离或在根进程退出后仍运行的后台后代不能保证回收；取消也不会回滚 Agent 已修改的文件。

## 会话和数据边界

Codex 角色有四个任务工具，两端都有三个项目工具；DSH 角色可通过 `ask_codex` 主动请求。关联项目日常使用同一对固定会话。繁忙、无效、锁冲突或超时应检查原任务与回执，不使用新会话绕过。

DSH headless 只接受兼容的已有会话。普通桌面 preset 或另一个活动 writer 可能被原生拒绝，桥不会强行接管。Codex 桌面持有对话时使用公开线程队列；只有对应回合的真实最终回复才算完成。等待超时不代表排队消息已撤回，不能盲目重发。

运行数据默认在 `%USERPROFILE%\.dsh-codex-bridge`，继承该目录的 Windows ACL。共享记录仅来自明确发布的摘要，长记录和早期历史通过完整快照或索引提供，不扫描全部私人聊天。实际邮箱、登录配置、绑定、快照、日志和测试证据应留在使用者设备上。

## 通用验证与打包

`npm test` 使用隔离临时目录与本地假 Agent，覆盖协议、Windows 启动、路径和长参数、会话绑定、队列关联、上下文投递及退出清理，不需要登录账号。通过这些测试不代表真实模型已经调用成功。

真实联调由使用者在授权后自行执行：记录自己两端的原生会话 ID，连续发出小型请求，核对实际最终回复、固定会话、增量记录和会话数量。证据保存在私有目录，不加入发布内容。

仓库包含 Windows/Linux/macOS 与 Node.js 22/24 的 CI 定义。各平台的通过情况以对应提交的实际 CI 结果为准，本说明不提供任何个人机器的运行记录。

```powershell
npm pack
```

生成的 `.tgz` 是当前源码的本地包。发布前复核包清单与许可证；实际运行数据和配置不应出现在包中。
