# DeepSeek Harness ↔ Codex Bridge

[简体中文](README.md) | English | [Windows guide](WINDOWS.md)

Documentation for this adaptation written and edited by **TheoWang123666 and Codex (OpenAI AI assistant)**.

Version `0.2.9-windows.2`. Based on [Aloneswork/deepseek-harness-codex-bridge](https://github.com/Aloneswork/deepseek-harness-codex-bridge), with native Windows support, fixed project conversations, incremental shared context and queued-reply recovery. See [UPSTREAM.md](UPSTREAM.md) and the original [MIT license](LICENSE).

This unofficial local MCP bridge is not affiliated with or endorsed by DeepSeek or OpenAI. Users provide their own configuration. The source does not include account credentials, project bindings or chat history.

## Features

- Codex delegates bounded tasks to DSH; DSH can contact Codex through `ask_codex` or the CLI.
- Set `DSH_BRIDGE_LEAD=dsh` for DSH-led coordination. The compatibility default is Codex-led.
- Linked projects reuse one Codex conversation and one compatible existing DSH headless session. Busy, invalid or timed-out calls do not silently open replacements.
- Shared records are delivered incrementally per project, direction and native session. Entries outside the current budget remain pending; long records have complete snapshot/index paths.
- Queue acceptance is not completion. Context is acknowledged only after the actual final reply, and pending retries retain their original snapshot.
- Windows, macOS and Linux are supported. Windows can discover the official desktop CLI without WSL.

## Setup

Requirements: Node.js `>=22.19.0`, configured [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), and Codex CLI for DSH → Codex requests. Follow DSH's own higher runtime requirements where applicable; Node.js 24 LTS is recommended.

Download this repository's source, then run in its directory:

```sh
npm ci --ignore-scripts
npm test
npm run check
node ./diagnose.mjs --mcp-config
```

The last command only prints configuration for this checkout. Merge it into your own `~/.codex/config.toml`, preserve existing entries, and reload the relevant MCP server. The upstream URL is attribution; an upstream release does not necessarily contain this build's enhancements.

The generated configuration enables four Codex task tools by default. For project pairing and shared context, keep its generated `command` and `args` and extend the same section's tool list:

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

On DSH, configure the same `server.mjs` as an MCP server with `DSH_BRIDGE_ROLE=dsh` to expose `ask_codex`. Both roles provide the three project tools. Set `DSH_CODEX_MAILBOX_DIR` to the same private mailbox for shared state. Choose the same `DSH_BRIDGE_LEAD` on both ends. Tool configuration never extends the user's authorization for a task.

To explicitly opt into DSH's own stored desktop login:

```sh
node ./diagnose.mjs --mcp-config --stored-auth
```

The bundled `profiles/headless-stored-auth.yml` is a generic launch template without credentials. DSH reads its own valid login; the bridge does not extract or copy tokens. Otherwise DSH's default headless authentication applies. See [WINDOWS.md](WINDOWS.md) for executable selection and Windows configuration.

## Bind existing conversations

Every name, path and ID below is an **example placeholder**. Substitute existing workspace directories and verified existing native IDs:

```sh
node ./server.mjs link-projects --name example-project --codex-workspace /absolute/codex-workspace --dsh-workspace /absolute/dsh-workspace
node ./server.mjs bind-project-conversation --link-id example-project --thread-id EXISTING_CODEX_THREAD_ID --reason "Select the existing collaboration conversation"
node ./server.mjs bind-project-dsh-session --link-id example-project --session-id EXISTING_DSH_SESSION_ID --reason "Select a compatible existing headless session"
node ./server.mjs project-links
```

A linked project without a default DSH binding or explicit existing DSH session ID is rejected; it is not auto-created. Ordinary Codex requests can omit both session IDs:

```json
{"projectLinkId":"example-project","task":"Inspect this minimal reproduction and return findings."}
```

DSH uses `ask_codex` with `message` and concise progress or evidence:

```json
{"projectLinkId":"example-project","message":"Review the boundaries of this change.","progress":"A minimal reproduction is ready.","evidence":"Relevant files and test summary."}
```

Keep the returned `taskId` and receipt for an unfinished request. A justified new Codex conversation requires `newConversation: true` and a nonempty `newConversationReason`; existing tasks cannot silently change their binding. Rebinding DSH is explicit and requires a reason. Do not bypass busy, queued or timed-out calls with another conversation.

## Tools and CLI

The Codex role has four task tools: `delegate_to_deepseek`, `list_deepseek_messages`, `reply_to_deepseek` and `get_bridge_task_status`. Both roles have `list_project_links`, `read_project_context` and `share_project_context`. The DSH role also has `ask_codex`.

`deepseek-harness-mcp` is the stdio MCP entry point. `dsh-codex-mail` provides mailbox and chat commands; a source checkout can use `node ./server.mjs` for the same commands:

```sh
node ./server.mjs help
```

`send`, `inbox`, `status` and `chat` track assigned tasks. Linked workflows use their default binding; the first unlinked `chat` can still create a Codex thread. After DSH stops, another external invocation is needed to resume collaboration. This is not an always-online chat bot.

## Data and verification

Messages, bindings and delivery state default to `~/.dsh-codex-bridge/`; complete context snapshots may be stored under a workspace's `.dsh-codex-bridge/`. These are user runtime data and should not be committed or shared. Shared-context tools exchange explicitly published summaries, not private chat-history scans.

Use workspace files for large inputs and avoid copying all shared records into every request. The default timeout is `900000` milliseconds; the MCP client timeout should not be shorter. Optional environment variables include `DSH_BIN`, `DSH_DESKTOP_DIR`, `DSH_BRIDGE_PATCH`, `CODEX_BIN`, `DSH_CODEX_MAILBOX_DIR`, `DSH_BRIDGE_TIMEOUT_MS`, `DSH_CODEX_CHAT_TIMEOUT_MS`, `DSH_BRIDGE_ROLE` and `DSH_BRIDGE_LEAD`.

`npm test` uses isolated temporary directories and fake agents, without an account or model call. Live verification needs the user's own model/login configuration, authorization and actual final replies. Cross-platform CI definitions are included; consult actual runs for the relevant commit before claiming a platform passed.

`npm pack` creates a local archive. Review its real file list before publishing; omit mailboxes, real configuration, logs and test evidence. Preserve the original MIT license and copyright notices in the source and distributions.
