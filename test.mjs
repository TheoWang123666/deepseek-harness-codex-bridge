import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProjectStore } from './project-links.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
// Fixtures, messages, task ledgers, and PID markers stay in this test-owned directory.
const temporary = await mkdtemp(join(tmpdir(), 'dsh-codex-bridge-'));
const mailbox = join(temporary, '隔离 mailbox');
const fixtures = join(temporary, '中文 fixtures with spaces');
await mkdir(fixtures, { recursive: true });
const fakeCodex = join(fixtures, 'fake codex.mjs');
const echoDsh = join(fixtures, 'echo dsh.mjs');
const jsonDsh = join(fixtures, 'json dsh.mjs');
const slowJsonDsh = join(fixtures, 'slow json dsh.mjs');
const jsonDshRequests = join(temporary, 'dsh json invocations.jsonl');
const slowJsonRequests = join(temporary, 'dsh slow invocations.jsonl');
const slowJsonReady = join(temporary, 'dsh slow ready');
const slowJsonRelease = join(temporary, 'dsh slow release');
const failOnceMarker = join(temporary, 'dsh fail once marker');
const slowDsh = join(fixtures, 'process tree.mjs');
const codexRequests = join(temporary, 'codex requests.jsonl');
const dshRequests = join(temporary, 'dsh invocations.jsonl');
const liveClients = new Set();
const fixturePids = new Set();

async function waitUntil(check, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 25));
  }
  throw new Error('condition timed out');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function treePids(directory) {
  const pids = [];
  for (const role of ['parent', 'child', 'grandchild']) {
    const pid = Number(await readFile(join(directory, `${role}.pid`), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    fixturePids.add(pid);
    pids.push(pid);
  }
  return pids;
}

async function waitTreeReady(directory) {
  await waitUntil(async () => {
    try { await treePids(directory); return true; } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
  return treePids(directory);
}

async function waitTreeDead(pids) {
  await waitUntil(() => pids.every((pid) => !alive(pid)));
}

await writeFile(fakeCodex, `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  appendFileSync(process.env.FAKE_CODEX_REQUESTS, JSON.stringify(request) + '\\n');
  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  if (request.method === 'initialize') reply({ userAgent: 'fake' });
  if (request.method === 'thread/start') reply({ thread: { id: 'thread-from-dsh' } });
  if (request.method === 'thread/resume') reply({ thread: { id: request.params.threadId } });
  if (request.method === 'thread/name/set') reply({});
  if (request.method === 'turn/start') {
    reply({ turn: { id: 'turn-1', status: 'inProgress', items: [] } });
    process.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'COMMENTARY_MUST_NOT_BE_FINAL' } }) + '\\n');
    process.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: request.params.threadId, turn: { id: 'turn-1', status: 'completed', items: [
      { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: 'CODEX_REPLY' },
    ] } } }) + '\\n');
  }
}
`);
await writeFile(echoDsh, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FAKE_DSH_REQUESTS, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
await writeFile(jsonDsh, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_DSH_JSON_REQUESTS, JSON.stringify({ argv, prompt: argv[argv.length - 1] }) + '\\n');
const sessionIndex = argv.indexOf('--session-id');
const sessionId = process.env.FAKE_DSH_JSON_WRONG ? 'session-wrong-id'
  : sessionIndex >= 0 ? argv[sessionIndex + 1] : 'session-json-fixture';
if (argv.includes('--json')) {
  if (process.env.FAKE_DSH_JSON_FAIL_ONCE && !existsSync(process.env.FAKE_DSH_JSON_FAIL_ONCE)) {
    writeFileSync(process.env.FAKE_DSH_JSON_FAIL_ONCE, 'first final will fail');
    process.stdout.write(JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() }) + '\\n');
    process.exitCode = 3;
  } else {
    process.stdout.write(JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'final', text: 'DSH_JSON_ANSWER' }) + '\\n');
  }
} else {
  process.stdout.write('DSH_PLAIN_ANSWER\\n');
}
`);
await writeFile(slowJsonDsh, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_SLOW_DSH_REQUESTS, JSON.stringify({ argv }) + '\\n');
writeFileSync(process.env.FAKE_SLOW_DSH_READY, 'ready');
const deadline = Date.now() + 8000;
while (!existsSync(process.env.FAKE_SLOW_DSH_RELEASE) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const sessionIndex = argv.indexOf('--session-id');
const sessionId = sessionIndex >= 0 ? argv[sessionIndex + 1] : 'session-slow-forward';
process.stdout.write(JSON.stringify({ type: 'session', sessionId, cwd: process.cwd() }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'final', text: 'SLOW_DSH_REPLY' }) + '\\n');
`);
await writeFile(slowDsh, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const role = process.env.FIXTURE_TREE_ROLE || 'parent';
writeFileSync(join(process.env.FIXTURE_TREE_DIR, role + '.pid'), String(process.pid));
if (role !== 'grandchild') {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, FIXTURE_TREE_ROLE: role === 'parent' ? 'child' : 'grandchild' },
    stdio: 'ignore', windowsHide: true,
  });
}
setInterval(() => {}, 1000);
`);

const env = {
  ...process.env,
  CODEX_BIN: fakeCodex,
  DSH_BIN: echoDsh,
  DSH_CODEX_MAILBOX_DIR: mailbox,
  FAKE_CODEX_REQUESTS: codexRequests,
  FAKE_DSH_REQUESTS: dshRequests,
  FAKE_DSH_JSON_REQUESTS: jsonDshRequests,
  DSH_BRIDGE_PATCH: '',
  DSH_BRIDGE_LEAD: 'codex',
  DSH_PROFILE: '',
  DSH_SESSION_ID: '',
};

async function connect(extraEnv = {}) {
  const client = new Client({ name: 'bridge-test', version: '0.2.2' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, 'server.mjs')],
    cwd: here,
    env: { ...env, ...extraEnv },
    stderr: 'pipe',
  });
  await client.connect(transport);
  liveClients.add(client);
  return client;
}

async function close(client) {
  await client.close();
  liveClients.delete(client);
}

const delegate = (client, taskId, task, options) => client.callTool({
  name: 'delegate_to_deepseek',
  arguments: { task, workspace: fixtures, rootTaskId: `root-${taskId}`, taskId },
}, undefined, options);

try {
  const client = await connect();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
    'delegate_to_deepseek', 'list_deepseek_messages', 'reply_to_deepseek', 'get_bridge_task_status',
    'list_project_links', 'read_project_context', 'share_project_context',
  ].sort());

  // This exceeds cmd.exe's limit and must remain one unchanged argument.
  const shellMarker = join(temporary, 'must not be created.txt');
  const task = `Inspect 中文 parser 'single' "double"\n&|<>^%PATH% & echo INJECTED > "${shellMarker}"\n${'long-input-'.repeat(1000)}`;
  assert.ok(task.length > 8191);
  const delegated = await delegate(client, 'task-1', task);
  assert.equal(delegated.isError, undefined, delegated.content[0].text);
  assert.match(delegated.content[0].text, /taskId=task-1/);
  const invocation = JSON.parse(delegated.content[0].text.split('\n\n').slice(1).join('\n\n'));
  assert.deepEqual(invocation.argv.slice(0, 2), ['--profile', 'headless']);
  assert.equal(invocation.argv.length, 3);
  assert.ok(invocation.argv[2].startsWith(task));
  assert.match(invocation.argv[2], /Do not return or re-delegate/);
  assert.equal(invocation.cwd, fixtures);
  await assert.rejects(readFile(shellMarker), { code: 'ENOENT' });

  const status = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId: 'task-1' } });
  assert.equal(JSON.parse(status.content[0].text).status, 'completed');
  const beforeUnjustifiedNew = await readFile(dshRequests, 'utf8');
  const unjustifiedNew = await client.callTool({ name: 'delegate_to_deepseek', arguments: {
    task: 'A new conversation requires an explicit reason before any DSH process launches',
    workspace: fixtures, taskId: 'task-unjustified-new', newConversation: true,
  } });
  assert.equal(unjustifiedNew.isError, true);
  assert.match(unjustifiedNew.content[0].text, /reason/iu);
  assert.equal(await readFile(dshRequests, 'utf8'), beforeUnjustifiedNew);
  const reservedTasks = [
    { taskId: 'CON', objective: 'Verify a reserved Windows task ID roundtrip' },
    { taskId: '_CON', objective: 'Verify a distinct underscored task does not collide' },
  ];
  for (const { taskId, objective } of reservedTasks) {
    const result = await delegate(client, taskId, objective);
    assert.equal(result.isError, undefined, result.content[0].text);
  }
  for (const { taskId, objective } of reservedTasks) {
    const result = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId } });
    const record = JSON.parse(result.content[0].text);
    assert.equal(record.taskId, taskId);
    assert.equal(record.objective, objective);
  }

  const patchDirectory = join(fixtures, '中文 profiles with spaces');
  await mkdir(patchDirectory);
  const patch = join(patchDirectory, 'stored auth & percent%.yml');
  await writeFile(patch, '# Test-only patch; no credentials or real providers.\n[]\n');
  const patchClient = await connect({ DSH_BRIDGE_PATCH: patch });
  const patchedTask = 'Verify the optional patch is one unchanged argument';
  const patched = await delegate(patchClient, 'task-with-patch', patchedTask);
  assert.equal(patched.isError, undefined, patched.content[0].text);
  const patchedInvocation = JSON.parse(patched.content[0].text.split('\n\n').slice(1).join('\n\n'));
  assert.deepEqual(patchedInvocation.argv.slice(0, 4), ['--profile', 'headless', '--patch', patch]);
  assert.equal(patchedInvocation.argv.length, 5);
  assert.ok(patchedInvocation.argv[4].startsWith(patchedTask));
  await close(patchClient);
  const missingPatchClient = await connect({ DSH_BRIDGE_PATCH: join(patchDirectory, 'missing patch.yml') });
  const missingPatch = await delegate(missingPatchClient, 'task-missing-patch', 'This patch must fail safely');
  assert.equal(missingPatch.isError, true);
  assert.match(missingPatch.content[0].text, /patch|ENOENT/iu);
  assert.equal((await missingPatchClient.listTools()).tools.length, 7);
  await close(missingPatchClient);

  const cli = (args, extraEnv = {}) => run(process.execPath, [join(here, 'server.mjs'), ...args], {
    env: { ...env, ...extraEnv }, cwd: fixtures, timeout: 10000, windowsHide: true,
  });
  await assert.rejects(cli([
    'send', '--root-task-id', 'root-task-1', '--task-id', 'task-1', '--kind', 'question', '--body', 'What next?',
  ]), /progress or evidence/);
  await assert.rejects(cli([
    'send', '--root-task-id', 'root-task-1', '--task-id', 'task-1', '--kind', 'milestone', '--body', task, '--progress', 'started',
  ]), /must not return the assigned subtask unchanged/);

  const sent = await cli([
    'send', '--root-task-id', 'root-task-1', '--task-id', 'task-1', '--kind', 'milestone',
    '--body', 'Parser inspection completed', '--progress', '100%', '--evidence', 'test fixture passed',
  ]);
  const messageId = JSON.parse(sent.stdout).id;
  const listed = await client.callTool({ name: 'list_deepseek_messages', arguments: { taskId: 'task-1', markRead: true } });
  assert.equal(JSON.parse(listed.content[0].text)[0].id, messageId);
  const nowEmpty = await client.callTool({ name: 'list_deepseek_messages', arguments: { taskId: 'task-1' } });
  assert.deepEqual(JSON.parse(nowEmpty.content[0].text), []);
  const replied = await client.callTool({
    name: 'reply_to_deepseek', arguments: { messageId, body: 'Accepted; continue with the edge case.' },
  });
  assert.equal(JSON.parse(replied.content[0].text).recipient, 'dsh');
  const inbox = await cli(['inbox', '--task-id', 'task-1', '--mark-read']);
  assert.match(inbox.stdout, /Accepted; continue/);

  const chatArgs = ['--root-task-id', 'root-task-1', '--task-id', 'task-1', '--kind', 'question',
    '--body', 'Should I keep the current parser?', '--progress', 'All cases inspected', '--evidence', 'fixture passed', '--workspace', fixtures];
  const chatResult = JSON.parse((await cli(['chat', ...chatArgs])).stdout);
  assert.equal(chatResult.threadId, 'thread-from-dsh');
  assert.equal(chatResult.reply.body, 'CODEX_REPLY');
  const resumed = JSON.parse((await cli(['chat', ...chatArgs])).stdout);
  assert.equal(resumed.threadId, 'thread-from-dsh');
  const requests = (await readFile(codexRequests, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(({ method }) => method === 'thread/start').length, 1);
  const resumeRequests = requests.filter(({ method }) => method === 'thread/resume');
  assert.equal(resumeRequests.length, 1);
  assert.equal(resumeRequests[0].params.threadId, 'thread-from-dsh');
  assert.equal(resumeRequests[0].params.cwd, fixtures);
  assert.equal(requests.filter(({ method }) => method === 'turn/start').length, 2);
  assert.equal(requests.filter(({ method }) => method === 'thread/name/set').length, 1, 'Continuing the same Codex conversation must preserve its title');
  const linked = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId: 'task-1' } });
  assert.equal(JSON.parse(linked.content[0].text).codexThreadId, 'thread-from-dsh');

  const fixedDshSession = 'fixture-existing-dsh-session';
  const fixedCodexThread = 'fixture-existing-codex-thread';
  const targeted = await client.callTool({ name: 'delegate_to_deepseek', arguments: {
    task: 'Continue only the explicitly selected DSH and Codex sessions', workspace: fixtures,
    rootTaskId: 'root-targeted', taskId: 'task-targeted',
    dshSessionId: fixedDshSession, codexThreadId: fixedCodexThread,
  } });
  assert.equal(targeted.isError, undefined, targeted.content[0].text);
  assert.match(targeted.content[0].text, /dshSessionId=fixture-existing-dsh-session/u);
  assert.match(targeted.content[0].text, /codexThreadId=fixture-existing-codex-thread/u);
  const targetedInvocation = JSON.parse(targeted.content[0].text.split('\n\n').slice(1).join('\n\n'));
  assert.deepEqual(targetedInvocation.argv.slice(0, 4), ['--profile', 'headless', '--session-id', fixedDshSession]);
  assert.equal(targetedInvocation.argv.length, 5);
  assert.ok(targetedInvocation.argv[4].includes(`dshSessionId=${fixedDshSession}`));
  assert.ok(targetedInvocation.argv[4].includes(`codexThreadId=${fixedCodexThread}`));
  const targetedStatus = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId: 'task-targeted' } });
  const targetLedger = JSON.parse(targetedStatus.content[0].text);
  assert.equal(targetLedger.dshSessionId, fixedDshSession);
  assert.equal(targetLedger.codexThreadId, fixedCodexThread);
  const targetedChatArgs = ['chat', '--root-task-id', 'root-targeted', '--task-id', 'task-targeted',
    '--kind', 'question', '--body', 'Confirm the selected existing Codex conversation',
    '--progress', 'The explicitly selected DSH fixture completed', '--workspace', fixtures];
  const beforeTargetedChat = (await readFile(codexRequests, 'utf8')).trim().split('\n').map(JSON.parse);
  const targetedChat = JSON.parse((await cli(targetedChatArgs)).stdout);
  assert.equal(targetedChat.threadId, fixedCodexThread);
  const afterTargetedChat = (await readFile(codexRequests, 'utf8')).trim().split('\n').map(JSON.parse);
  const targetedRequests = afterTargetedChat.slice(beforeTargetedChat.length);
  assert.equal(targetedRequests.filter(({ method }) => method === 'thread/start').length, 0);
  assert.equal(targetedRequests.filter(({ method }) => method === 'thread/name/set').length, 0, 'An explicitly selected existing Codex conversation must not be renamed');
  assert.equal(targetedRequests.filter(({ method }) => method === 'thread/resume').length, 1);
  assert.equal(targetedRequests.find(({ method }) => method === 'thread/resume').params.threadId, fixedCodexThread);
  await assert.rejects(cli([...targetedChatArgs, '--thread-id', 'forbidden-rebinding']), /thread|bound/iu);
  const afterRejectedRebinding = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId: 'task-targeted' } });
  const unchangedTarget = JSON.parse(afterRejectedRebinding.content[0].text);
  assert.equal(unchangedTarget.dshSessionId, fixedDshSession);
  assert.equal(unchangedTarget.codexThreadId, fixedCodexThread);
  assert.equal((await readFile(codexRequests, 'utf8')).trim().split('\n').length, afterTargetedChat.length);

  const jsonClient = await connect({ DSH_BIN: jsonDsh });
  const contextStore = createProjectStore(mailbox);
  const contextProject = await contextStore.linkProjects({ name: 'incremental-context-fixture',
    codexWorkspace: fixtures, dshWorkspace: fixtures });
  const sharedA = await jsonClient.callTool({ name: 'share_project_context',
    arguments: { linkId: contextProject.id, summary: 'CONTEXT_A', topic: 'A' } });
  assert.equal(sharedA.isError, undefined, sharedA.content[0].text);
  const noDefaultProject = await contextStore.linkProjects({ name: 'no-default-dsh-project',
    codexWorkspace: fixtures, dshWorkspace: fixtures });
  const noDefault = await jsonClient.callTool({ name: 'delegate_to_deepseek', arguments: {
    task: 'A linked project without a default DSH session must not auto-create one', workspace: fixtures,
    rootTaskId: 'root-no-default-dsh', taskId: 'no-default-dsh', projectLinkId: noDefaultProject.id,
  } });
  assert.equal(noDefault.isError, true);
  assert.match(noDefault.content[0].text, /no default DSH|bind-project-dsh-session/iu);
  await assert.rejects(readFile(jsonDshRequests), { code: 'ENOENT' },
    'Rejecting a missing default must not start a DSH process');
  const projectDelegate = (taskId, task, dshSessionId) => jsonClient.callTool({ name: 'delegate_to_deepseek', arguments: {
    task, workspace: fixtures, rootTaskId: `root-${taskId}`, taskId, projectLinkId: contextProject.id,
    ...(dshSessionId ? { dshSessionId } : {}),
  } });
  const firstProject = await projectDelegate('dsh-json-1', 'FIRST_PROJECT_TASK', 'session-json-fixture');
  assert.equal(firstProject.isError, undefined, firstProject.content[0].text);
  assert.match(firstProject.content[0].text, /DSH_JSON_ANSWER/u);
  assert.match(firstProject.content[0].text, /dshSessionId=session-json-fixture/u);
  assert.equal((await contextStore.getProjectDshSession(contextProject.id)).dshSessionId, 'session-json-fixture');
  const jsonLines = async () => (await readFile(jsonDshRequests, 'utf8')).trim().split('\n').map(JSON.parse);
  let jsonInvocations = await jsonLines();
  assert.equal(jsonInvocations.length, 1);
  assert.ok(jsonInvocations[0].argv.includes('--json'));
  const firstSessionIndex = jsonInvocations[0].argv.indexOf('--session-id');
  assert.ok(firstSessionIndex >= 0, 'The first linked request must select an existing native session');
  assert.equal(jsonInvocations[0].argv[firstSessionIndex + 1], 'session-json-fixture');
  assert.ok(jsonInvocations[0].prompt.startsWith('FIRST_PROJECT_TASK'));
  assert.ok(jsonInvocations[0].prompt.includes('CONTEXT_A'));

  const secondProject = await projectDelegate('dsh-json-2', 'SECOND_PROJECT_TASK');
  assert.equal(secondProject.isError, undefined, secondProject.content[0].text);
  assert.match(secondProject.content[0].text, /DSH_JSON_ANSWER/u);
  jsonInvocations = await jsonLines();
  assert.equal(jsonInvocations.length, 2);
  const sessionIndex = jsonInvocations[1].argv.indexOf('--session-id');
  assert.ok(sessionIndex >= 0);
  assert.equal(jsonInvocations[1].argv[sessionIndex + 1], 'session-json-fixture');
  assert.ok(jsonInvocations[1].argv.includes('--json'), 'continuation must also verify the native session event');
  assert.ok(!jsonInvocations[1].prompt.includes('CONTEXT_A'), 'an existing session must not repeat old background');
  assert.ok(jsonInvocations[1].prompt.startsWith('SECOND_PROJECT_TASK'));

  const sharedB = await jsonClient.callTool({ name: 'share_project_context',
    arguments: { linkId: contextProject.id, summary: 'CONTEXT_B', topic: 'B' } });
  assert.equal(sharedB.isError, undefined, sharedB.content[0].text);
  const thirdProject = await projectDelegate('dsh-json-3', 'THIRD_PROJECT_TASK');
  assert.equal(thirdProject.isError, undefined, thirdProject.content[0].text);
  jsonInvocations = await jsonLines();
  assert.equal(jsonInvocations.length, 3);
  assert.ok(jsonInvocations[2].prompt.includes('CONTEXT_B'));
  assert.ok(!jsonInvocations[2].prompt.includes('CONTEXT_A'));

  const wrongSessionClient = await connect({ DSH_BIN: jsonDsh, FAKE_DSH_JSON_WRONG: '1' });
  const wrongSession = await wrongSessionClient.callTool({ name: 'delegate_to_deepseek', arguments: {
    task: 'A mismatched resumed DSH session must be rejected', workspace: fixtures,
    rootTaskId: 'root-dsh-json-wrong', taskId: 'dsh-json-wrong', projectLinkId: contextProject.id,
  } });
  assert.equal(wrongSession.isError, true);
  assert.match(wrongSession.content[0].text, /different native session|DSH session/iu);
  assert.equal((await contextStore.getProjectDshSession(contextProject.id)).dshSessionId, 'session-json-fixture');
  await close(wrongSessionClient);

  const retryClient = await connect({ DSH_BIN: jsonDsh, FAKE_DSH_JSON_FAIL_ONCE: failOnceMarker });
  const retryProject = await contextStore.linkProjects({ name: 'dsh-fail-once-project',
    codexWorkspace: fixtures, dshWorkspace: fixtures });
  const retryDelegate = (taskId, dshSessionId) => retryClient.callTool({ name: 'delegate_to_deepseek', arguments: {
    task: `Retry after first final failure ${taskId}`, workspace: fixtures,
    rootTaskId: `root-${taskId}`, taskId, projectLinkId: retryProject.id,
    ...(dshSessionId ? { dshSessionId } : {}),
  } });
  const failedFirst = await retryDelegate('dsh-fail-once-1', 'session-json-fixture');
  assert.equal(failedFirst.isError, true);
  assert.equal((await contextStore.getProjectDshSession(retryProject.id)).dshSessionId, 'session-json-fixture',
    'A session event emitted before the first final failure must be retained');
  const retriedSecond = await retryDelegate('dsh-fail-once-2');
  assert.equal(retriedSecond.isError, undefined, retriedSecond.content[0].text);
  assert.match(retriedSecond.content[0].text, /DSH_JSON_ANSWER/u);
  const retryInvocations = (await readFile(jsonDshRequests, 'utf8')).trim().split('\n').map(JSON.parse);
  const retryLast = retryInvocations.at(-1);
  const retrySessionIndex = retryLast.argv.indexOf('--session-id');
  assert.ok(retrySessionIndex >= 0);
  assert.equal(retryLast.argv[retrySessionIndex + 1], 'session-json-fixture');
  assert.ok(retryLast.argv.includes('--json'));
  await close(retryClient);
  await close(jsonClient);

  const slowClient = await connect({ DSH_BIN: slowJsonDsh,
    FAKE_SLOW_DSH_REQUESTS: slowJsonRequests, FAKE_SLOW_DSH_READY: slowJsonReady,
    FAKE_SLOW_DSH_RELEASE: slowJsonRelease });
  const slowStore = createProjectStore(mailbox);
  const slowProject = await slowStore.linkProjects({ name: 'slow-forward-lock-fixture',
    codexWorkspace: fixtures, dshWorkspace: fixtures });
  const slowDelegate = (taskId) => slowClient.callTool({ name: 'delegate_to_deepseek', arguments: {
    task: `Slow forward task ${taskId}`, workspace: fixtures, rootTaskId: `root-${taskId}`,
    taskId, projectLinkId: slowProject.id, dshSessionId: 'session-slow-forward',
  } });
  const firstSlow = slowDelegate('slow-forward-1');
  await waitUntil(async () => {
    try { await readFile(slowJsonReady); return true; } catch { return false; }
  });
  const secondSlow = await slowDelegate('slow-forward-2');
  assert.equal(secondSlow.isError, true);
  assert.match(secondSlow.content[0].text, /busy|lock/iu);
  assert.equal((await readFile(slowJsonRequests, 'utf8')).trim().split('\n').length, 1,
    'A concurrent forward request must not start a second DSH session');
  await writeFile(slowJsonRelease, 'release the first forward run');
  const firstSlowResult = await firstSlow;
  assert.equal(firstSlowResult.isError, undefined, firstSlowResult.content[0].text);
  assert.match(firstSlowResult.content[0].text, /SLOW_DSH_REPLY/u);
  assert.equal((await readFile(slowJsonRequests, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await slowStore.getProjectDshSession(slowProject.id)).dshSessionId, 'session-slow-forward');
  await close(slowClient);

  // Missing commands produce ordinary failures without killing the MCP server.
  const missing = join(fixtures, 'definitely missing executable');
  const missingClient = await connect({ DSH_BIN: missing });
  const missingResult = await delegate(missingClient, 'task-missing', 'This must fail safely');
  assert.equal(missingResult.isError, true);
  assert.equal((await missingClient.listTools()).tools.length, 7);
  await close(missingClient);
  const failedChat = await cli(['chat', ...chatArgs], { CODEX_BIN: missing }).then(
    () => { throw new Error('Missing Codex unexpectedly succeeded'); }, (error) => error,
  );
  assert.equal(failedChat.code, 1);
  assert.doesNotMatch(failedChat.stderr, /Unhandled 'error' event|UnhandledPromiseRejection|uncaughtException/);
  await close(client);

  for (const mode of ['timeout', 'cancel', 'disconnect']) {
    const treeDirectory = join(temporary, `${mode} tree`);
    await mkdir(treeDirectory);
    const treeClient = await connect({
      DSH_BIN: slowDsh, FIXTURE_TREE_DIR: treeDirectory,
      DSH_BRIDGE_TIMEOUT_MS: mode === 'timeout' ? '1500' : '30000',
    });
    const controller = new AbortController();
    const call = delegate(treeClient, `task-${mode}`, `Wait for ${mode}`, {
      timeout: 10000, signal: controller.signal,
    }).catch((error) => error);
    const pids = await waitTreeReady(treeDirectory);
    assert.ok(pids.every(alive));
    if (mode === 'cancel') controller.abort();
    if (mode === 'disconnect') await close(treeClient);
    const result = await call;
    if (mode === 'timeout') assert.equal(result.isError, true);
    await waitTreeDead(pids);
    if (mode !== 'disconnect') {
      assert.equal((await treeClient.listTools()).tools.length, 7);
      await close(treeClient);
    }
  }
  console.log('bridge protocol, isolated mailbox, Unicode/long prompt, reserved task ID, optional patch, explicit DSH/Codex sessions, immutable thread binding, Codex resume, missing commands, timeout/cancel/disconnect tree cleanup: ok');
} finally {
  for (const client of liveClients) await client.close().catch(() => {});
  // Emergency cleanup only addresses PIDs published by these test fixtures.
  for (const pid of fixturePids) {
    try { if (alive(pid)) process.kill(pid); } catch {}
  }
  await rm(temporary, { recursive: true, force: true });
}
