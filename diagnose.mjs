#!/usr/bin/env node

import { resolveCommand } from './runtime.mjs';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--mcp-config')) {
  const lines = [
    '[mcp_servers.deepseek_harness]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify([fileURLToPath(new URL('./server.mjs', import.meta.url))])}`,
    'tool_timeout_sec = 900',
    'enabled_tools = ["delegate_to_deepseek", "list_deepseek_messages", "reply_to_deepseek", "get_bridge_task_status"]',
  ];
  if (process.argv.includes('--stored-auth')) {
    lines.push('', '[mcp_servers.deepseek_harness.env]',
      `DSH_BRIDGE_PATCH = ${JSON.stringify(fileURLToPath(new URL('./profiles/headless-stored-auth.yml', import.meta.url)))}`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// Read-only preflight: no model calls, account reads, installations or config writes.
const nodeVersion = process.versions.node.split('.').map(Number);
const supported = nodeVersion[0] > 22 || (nodeVersion[0] === 22 && nodeVersion[1] >= 19);
console.log(`Bridge: ${process.platform} / ${process.arch}; Node.js ${process.versions.node} ${supported ? 'OK' : 'UNSUPPORTED (requires >=22.19.0)'}`);
if (!supported) process.exitCode = 1;

for (const [label, variable, fallback] of [
  ['DeepSeek Harness', 'DSH_BIN', 'dsh'],
  ['Codex', 'CODEX_BIN', 'codex'],
]) {
  try {
    const command = await resolveCommand(process.env[variable] || fallback);
    console.log(`${label}: OK ${JSON.stringify([command.file, ...command.argsPrefix])}`);
    if (command.env?.ELECTRON_RUN_AS_NODE === '1') {
      console.log('  Desktop CLI mode: ELECTRON_RUN_AS_NODE=1 (background CLI, no graphical window)');
    }
  } catch (error) {
    console.log(`${label}: MISSING / UNUSABLE: ${error.message}`);
    console.log(`  Install/configure this prerequisite, or set ${variable} to its executable or Node.js entry file.`);
    process.exitCode = 1;
  }
}

for (const dependency of ['@modelcontextprotocol/sdk/server/mcp.js', 'zod']) {
  try {
    import.meta.resolve(dependency);
    console.log(`Dependency ${dependency}: OK`);
  } catch {
    console.log(`Dependency ${dependency}: MISSING; run npm ci --ignore-scripts in this folder.`);
    process.exitCode = 1;
  }
}

console.log('This check verifies local entry points only. It does not verify credentials, quota, model calls or desktop-session attachment.');
