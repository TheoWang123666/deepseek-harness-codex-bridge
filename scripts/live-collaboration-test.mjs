import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = join(repository, 'tests', 'evidence');
const publicEnvironmentKeys = [
  'CODEX_BIN', 'CODEX_HOME', 'DSH_BIN', 'DSH_HOME', 'DSH_DESKTOP_DIR',
  'DSH_BRIDGE_PATCH', 'DSH_BRIDGE_TIMEOUT_MS', 'DSH_CODEX_CHAT_TIMEOUT_MS',
  'DSH_CODEX_MAILBOX_DIR', 'DSH_BRIDGE_ROLE',
];
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const publicEnvironment = (env) => Object.fromEntries(publicEnvironmentKeys
  .filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));

function parseOptions(args) {
  const options = {};
  const values = ['--config-json', '--dsh-config-json', '--workspace', '--server-entry', '--server-name',
    '--timeout-ms', '--dsh-session-id', '--codex-thread-id'];
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (['--run', '--prepare', '--help'].includes(key)) options[key.slice(2)] = true;
    else if (values.includes(key)) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = args[++index];
    } else throw new Error(`Unknown option: ${key}`);
  }
  if (options.run && options.prepare) throw new Error('Choose --prepare or --run');
  return options;
}

function parseModelJson(body) {
  let text = body.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try { return JSON.parse(text); } catch (originalError) {
    // Preserve all raw output, while tolerating a diagnostic line before final JSON.
    const end = text.lastIndexOf('}');
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
      if (start === 0) break;
    }
    throw originalError;
  }
}

async function writeReport(workspace, report) {
  await writeJson(join(workspace, 'live-report.json'), report);
  const checks = Object.entries(report.checks || {}).map(([key, value]) => `- ${key}: ${value ? 'PASS' : 'FAIL'}`);
  const markdown = [
    '# Codex ↔ DeepSeek Harness 原生 MCP 实际协作测试', '',
    `状态：${report.state}`, `工作区：${workspace}`, `外层任务：${report.taskId}`,
    `DSH session：${report.dshSessionId || '(自动新建；ID未回报)'}`, `反向任务：${report.reverseTaskId || '(尚无)'}`,
    `Codex thread：${report.threadId || '(尚无)'}`, `Nonce：${report.nonce}`, '',
    '链路：Codex 侧 Bridge MCP → 真实 DSH headless → 与桌面相同配置的 MCP ask_codex → 真实 Codex app-server → 原线程续聊 → DSH 最终 JSON。',
    '本次只覆写隔离邮箱和临时 headless patch；不运行 shell/helper，不修改持久配置。', '',
    ...checks, '',
    ...(report.error ? ['错误：', '```text', report.error, '```', ''] : []),
    ...(report.dshOutput ? ['DSH 最终返回：', '```text', report.dshOutput, '```', ''] : []),
    ...(report.codexAnswers ? ['Codex 两轮返回：', '```json', JSON.stringify(report.codexAnswers, null, 2), '```', ''] : []),
    '证据：request.json、assigned-task.txt、native-mcp.patch.yml、effective-dsh-mcp.json、live-report.json，以及 mailbox/tasks 和 mailbox/messages。', '',
  ].join('\n');
  await writeFile(join(workspace, 'live-report.md'), markdown, 'utf8');
}

async function main(options) {
  if (options.help) {
    console.log(`Usage: node scripts/live-collaboration-test.mjs --config-json REGISTERED-MCP.json [--dsh-config-json REGISTERED-DSH-MCP.json] [--prepare | --run] [--workspace ABSOLUTE-EVIDENCE-DIR] [--dsh-session-id UUID] [--codex-thread-id ID]\n\nDefault: prepare only. --run makes real DSH and Codex model requests through native MCP.\nThe DSH MCP JSON defaults to registered-dsh-mcp.json beside the Codex MCP JSON.\nWorkspaces must be under tests/evidence or the config's sibling live-test directory. No credential files are read.`);
    return;
  }
  if (!options['config-json']) throw new Error('--config-json is required');
  const configPath = resolve(options['config-json']);
  const document = await json(configPath);
  const config = document.command ? document
    : document.mcpServers?.[options['server-name']] || document.mcp_servers?.[options['server-name']];
  assert.ok(config && typeof config.command === 'string' && Array.isArray(config.args), 'The selected MCP configuration needs command and args');
  const reverseConfigPath = resolve(options['dsh-config-json'] || join(dirname(configPath), 'registered-dsh-mcp.json'));
  const reverseDocument = await json(reverseConfigPath);
  const reverseConfig = reverseDocument.config || reverseDocument;
  assert.equal(reverseConfig.transport, 'stdio');
  assert.equal(reverseConfig.env?.DSH_BRIDGE_ROLE, 'dsh');
  assert.equal(typeof reverseConfig.command, 'string');
  assert.ok(Array.isArray(reverseConfig.args));
  assert.match(reverseConfig.serverName, /^[A-Za-z0-9_]+$/u);
  const timeoutMs = Number(options['timeout-ms'] || 600000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 60000 && timeoutMs <= 3600000, '--timeout-ms must be 60000..3600000');
  const serverEntry = resolve(options['server-entry'] || config.args.find((argument) => /(?:^|[\\/])server\.mjs$/iu.test(argument)) || '');
  assert.equal((await stat(serverEntry)).isFile(), true);
  const packageManifest = await json(join(dirname(serverEntry), 'package.json'));
  assert.equal(packageManifest.name, 'deepseek-harness-mcp-bridge');
  const authPatchPath = config.env?.DSH_BRIDGE_PATCH;
  assert.ok(authPatchPath, 'The registered bridge must name its opt-in stored-auth overlay');
  // This is the explicit, credential-free overlay from registration, not the credential store.
  const authPatch = await readFile(authPatchPath, 'utf8');

  const installEvidenceRoot = join(dirname(configPath), 'live-test');
  const name = `native-mcp-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(3).toString('hex')}`;
  const workspace = resolve(options.workspace || join(installEvidenceRoot, name));
  const allowedRoot = [evidenceRoot, installEvidenceRoot].find((root) => {
    const difference = relative(root, workspace);
    return !difference.startsWith('..') && !isAbsolute(difference);
  });
  assert.ok(allowedRoot, 'The independent workspace must be inside an evidence directory');
  await mkdir(allowedRoot, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const physicalRelative = relative(await realpath(allowedRoot), await realpath(workspace));
  assert.ok(!physicalRelative.startsWith('..') && !isAbsolute(physicalRelative), 'The workspace must not resolve outside its evidence directory');
  const requestPath = join(workspace, 'request.json');
  let request;
  try { request = await json(requestPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const taskId = `live-${Date.now()}-${randomBytes(4).toString('hex')}`;
    request = {
      mode: 'native-mcp', workspace, mailboxDirectory: join(workspace, 'mailbox'),
      rootTaskId: taskId, taskId, nonce: randomBytes(16).toString('hex'),
      dshSessionId: options['dsh-session-id'] || null,
      codexThreadId: options['codex-thread-id'] || null,
      serverEntry, reverseServerName: reverseConfig.serverName,
    };
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  }
  assert.equal(request.mode, 'native-mcp', 'Preserve the old helper test evidence and choose a fresh native-MCP workspace');
  assert.equal(request.workspace, workspace);
  assert.equal(request.serverEntry, serverEntry);
  if (options['dsh-session-id']) assert.equal(request.dshSessionId, options['dsh-session-id']);
  if (options['codex-thread-id']) assert.equal(request.codexThreadId, options['codex-thread-id']);
  if (options.run) {
    try { await stat(join(request.mailboxDirectory, 'tasks', `${encodeURIComponent(request.taskId)}.json`)); throw new Error('This live task already ran; use a fresh workspace'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  const effectiveReverse = { ...reverseConfig,
    env: { ...(reverseConfig.env || {}), DSH_CODEX_MAILBOX_DIR: request.mailboxDirectory } };
  const temporaryPatch = join(workspace, 'native-mcp.patch.yml');
  await writeJson(join(workspace, 'effective-dsh-mcp.json'), effectiveReverse);
  await writeFile(temporaryPatch, `${authPatch.trim()}\n- insert:\n    - id: live-codex-bridge-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: ${JSON.stringify(effectiveReverse)}\n`, 'utf8');
  const tool = `mcp__${reverseConfig.serverName}__ask_codex`;
  const target = request.codexThreadId
    ? `For your FIRST call also supply codexThreadId=${JSON.stringify(request.codexThreadId)} to select that existing Codex conversation. Do not change it later.`
    : 'For your first call omit taskId and codexThreadId so the reverse bridge creates a separate persistent task and Codex conversation.';
  const task = [
    'Perform a bounded live collaboration test using the native MCP tool supplied in this headless session.',
    `Use only ${tool}, exactly twice. Do not run any command, shell, helper or code tool; do not read or write files, inspect credentials, search the web or use other network tools.`,
    'First compute 17 * 23 yourself.',
    `FIRST tool call: use workspace=${JSON.stringify(workspace)}, kind="question", and progress/evidence explaining your computed product. ${target}`,
    `In its message tell Codex your computed product and ask it to add 19 itself. Tell Codex to remember this independent nonce: ${request.nonce}. Require JSON only with fields nonce, product and total. Do not supply the expected total yourself.`,
    'Verify the first reply. SECOND tool call: use the taskId returned by the first call. Ask what independent nonce and total Codex returned in the preceding turn, requiring JSON only with nonce and total. Supply progress/evidence stating the first turn completed, but DO NOT include the nonce, the total, the first answer or the first message in this second message/progress/evidence. This must recover memory from the same Codex thread.',
    'After the second response, return only this final JSON object: {"reportedBy":"deepseek-harness-final","product":your computed product,"total":the verified Codex total,"nonce":"the remembered nonce","threadId":"the returned Codex threadId","reverseTaskId":"the returned taskId","rounds":2}.',
    'If a tool is unavailable or fails, report the actual failure and stop. Do not run a shell fallback, retry with broader permissions, fabricate tool results, or claim success without both replies.',
  ].join('\n\n');
  await writeFile(join(workspace, 'assigned-task.txt'), `${task}\n`, 'utf8');
  const environment = Object.fromEntries(Object.entries({ ...process.env, ...(config.env || {}),
    DSH_CODEX_MAILBOX_DIR: request.mailboxDirectory, DSH_BRIDGE_PATCH: temporaryPatch })
    .filter(([, value]) => typeof value === 'string'));
  const report = {
    mode: 'native-mcp', state: options.run ? 'running' : 'prepared', preparedAt: new Date().toISOString(), workspace,
    taskId: request.taskId, nonce: request.nonce, dshSessionId: request.dshSessionId,
    requestedCodexThreadId: request.codexThreadId,
    expected: { product: 391, total: 410, codexRounds: 2 },
    registeredConfig: configPath, registeredDshConfig: reverseConfigPath,
    bridgePackage: { name: packageManifest.name, version: packageManifest.version },
    invocation: { command: config.command, args: config.args, cwd: config.cwd,
      environment: publicEnvironment(environment) },
    changesForThisRunOnly: { mailboxDirectory: request.mailboxDirectory, temporaryPatch }, checks: {},
  };
  await writeReport(workspace, report);
  console.log(JSON.stringify({ state: report.state, workspace, taskId: request.taskId,
    dshSessionId: request.dshSessionId, report: join(workspace, 'live-report.json') }));
  if (!options.run) return;

  const client = new Client({ name: 'bridge-native-mcp-live-test', version: '2.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args,
    cwd: config.cwd || dirname(serverEntry), env: environment, stderr: 'pipe' });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(({ name }) => name === 'delegate_to_deepseek'));
    report.startedAt = new Date().toISOString();
    const delegated = await client.callTool({ name: 'delegate_to_deepseek', arguments: {
      task, workspace, rootTaskId: request.rootTaskId, taskId: request.taskId,
      ...(request.dshSessionId ? { dshSessionId: request.dshSessionId } : {}),
      ...(request.codexThreadId ? { codexThreadId: request.codexThreadId } : {}),
    } }, undefined, { timeout: timeoutMs });
    report.delegated = delegated;
    report.dshOutput = delegated.content?.filter(({ type }) => type === 'text').map(({ text }) => text).join('\n') || '';
    assert.notEqual(delegated.isError, true, report.dshOutput);
    const final = parseModelJson(report.dshOutput);
    report.dshFinal = final;
    assert.equal(final.reportedBy, 'deepseek-harness-final');
    assert.equal(final.product, 391);
    assert.equal(final.total, 410);
    assert.equal(final.nonce, request.nonce);
    assert.equal(final.rounds, 2);
    assert.equal(typeof final.reverseTaskId, 'string');
    assert.equal(typeof final.threadId, 'string');
    report.reverseTaskId = final.reverseTaskId;
    report.threadId = final.threadId;
    if (request.codexThreadId) assert.equal(final.threadId, request.codexThreadId);
    const outerLedger = await json(join(request.mailboxDirectory, 'tasks', `${encodeURIComponent(request.taskId)}.json`));
    assert.equal(outerLedger.status, 'completed');
    assert.equal(outerLedger.dshSessionId || null, request.dshSessionId);
    if (request.codexThreadId) assert.equal(outerLedger.codexThreadId, request.codexThreadId);
    report.outerLedger = outerLedger;
    const ledger = await json(join(request.mailboxDirectory, 'tasks', `${encodeURIComponent(final.reverseTaskId)}.json`));
    assert.equal(ledger.origin, 'dsh');
    assert.equal(ledger.owner, 'dsh');
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.codexThreadId, final.threadId);
    assert.equal(ledger.workspace, workspace);
    report.reverseLedger = ledger;
    report.checks.bothPersistentTaskLedgersMatch = true;
    const directory = join(request.mailboxDirectory, 'messages');
    const messages = (await Promise.all((await readdir(directory)).filter((file) => file.endsWith('.json'))
      .map((file) => json(join(directory, file))))).filter((message) => message.taskId === final.reverseTaskId);
    const requests = messages.filter(({ sender }) => sender === 'dsh').sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const replies = messages.filter(({ sender }) => sender === 'codex');
    assert.equal(requests.length, 2, 'Require exactly two real native-MCP request records');
    assert.equal(replies.length, 2, 'Require exactly two persisted real Codex replies');
    const firstReply = replies.find(({ replyTo }) => replyTo === requests[0].id);
    const secondReply = replies.find(({ replyTo }) => replyTo === requests[1].id);
    assert.ok(firstReply && secondReply && firstReply.id !== secondReply.id);
    const firstAnswer = parseModelJson(firstReply.body);
    const secondAnswer = parseModelJson(secondReply.body);
    assert.equal(firstAnswer.product, 391);
    assert.equal(firstAnswer.total, 410);
    assert.equal(firstAnswer.nonce, request.nonce);
    assert.equal(secondAnswer.total, 410);
    assert.equal(secondAnswer.nonce, request.nonce);
    const secondInput = JSON.stringify({ body: requests[1].body, progress: requests[1].progress, evidence: requests[1].evidence });
    assert.ok(!secondInput.includes(request.nonce), 'Second request must retrieve the nonce from native thread history');
    assert.ok(!secondInput.includes('410'), 'Second request must retrieve the total from native thread history');
    report.messages = messages;
    report.codexAnswers = { first: firstAnswer, second: secondAnswer };
    report.checks.twoRealMcpRequestReplyPairs = true;
    report.checks.secondPromptOmitsNonceAndTotal = true;
    report.checks.codexArithmeticAndMemoryMatch = true;
    report.checks.dshFinalJsonMatchesObservedReplies = true;
    report.state = 'passed';
    report.finishedAt = new Date().toISOString();
  } catch (error) {
    report.state = 'failed'; report.error = error.message; report.finishedAt = new Date().toISOString();
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
    await writeReport(workspace, report);
  }
  console.log(JSON.stringify({ state: report.state, workspace, dshSessionId: report.dshSessionId,
    reverseTaskId: report.reverseTaskId, threadId: report.threadId,
    report: join(workspace, 'live-report.json'), error: report.error }));
}

try { await main(parseOptions(process.argv.slice(2))); }
catch (error) { console.error(error.message); process.exitCode = 1; }
