# Upstream, license and adaptation

This project is derived from [Aloneswork/deepseek-harness-codex-bridge](https://github.com/Aloneswork/deepseek-harness-codex-bridge).

- Base revision: `b17d6d9774f558fa724a9d04823a305c6554364a`.
- Original copyright: `Copyright (c) 2026 DeepSeek Harness MCP Bridge contributors`.
- License: MIT. The original [LICENSE](LICENSE) is retained without modification.

The adaptation adds native Windows process handling, discovery of an installed DSH desktop CLI, configurable coordination roles, registered project pairs, persistent conversation bindings, incremental shared context, and correlated recovery of queued Codex replies. Local simulated-agent tests cover the bridge without requiring accounts or model calls.

This source distribution contains no deployment-specific project registration, conversation binding, mailbox, authentication store, or real interaction transcript. Each installation supplies its own paths, accounts and existing conversation IDs.

This fork is published at [TheoWang123666/deepseek-harness-codex-bridge](https://github.com/TheoWang123666/deepseek-harness-codex-bridge). The upstream URL above records provenance and does not imply that the upstream repository already contains these adaptations.

This is a community adaptation, not an official DeepSeek or OpenAI integration.
