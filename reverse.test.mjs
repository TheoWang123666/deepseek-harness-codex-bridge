import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProjectStore } from './project-links.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'bridge-reverse-test-'));
const workspace = join(temporary, '中文 workspace with spaces');
const otherWorkspace = join(temporary, 'different workspace');
const mailbox = join(temporary, 'isolated mailbox');
const requestsPath = join(temporary, 'fake codex requests.jsonl');
const fakeCodex = join(temporary, 'fake codex.mjs');
const fakeDsh = join(temporary, 'fake dsh.mjs');
const liveClients = new Set();
await mkdir(workspace);
await mkdir(otherWorkspace);

await writeFile(fakeCodex, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of lines) {
  const request = JSON.parse(line);
  appendFileSync(process.env.REVERSE_TEST_REQUESTS, JSON.stringify({ ...request, processArgs: process.argv.slice(2) }) + '\\n');
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') {
    if (process.env.REVERSE_TEST_MODE === 'init-error') send({ id: request.id, error: { code: -32002, message: 'FIXTURE_INITIALIZE_FAILED' } });
    else reply({ userAgent: 'isolated-fake-codex' });
  }
  if (request.method === 'thread/start') reply({ thread: { id: 'fake-thread-' + randomUUID() } });
  if (request.method === 'thread/resume') {
    if (process.env.REVERSE_TEST_MODE === 'resume-mismatch') reply({ thread: { id: 'wrong-resumed-thread' } });
    else if (process.env.REVERSE_TEST_MODE.startsWith('queue-')) send({ id: request.id, error: { code: -32001, message: 'Thread has an active writer; only one active writer is allowed' } });
    else if (process.env.REVERSE_TEST_MODE === 'resume-error') send({ id: request.id, error: { code: -32001, message: 'FIXTURE_EXISTING_THREAD_UNAVAILABLE' } });
    else reply({ thread: { id: request.params.threadId } });
  }
  if (request.method === 'thread/queue/add') {
    const state = { id: 'fixture-queue-' + randomUUID(), clientUserMessageId: request.params.clientUserMessageId,
      input: request.params.input, threadId: request.params.threadId };
    writeFileSync(process.env.REVERSE_QUEUE_STATE, JSON.stringify(state));
    reply({ queuedSubmission: { id: state.id, input: state.input, clientUserMessageId: state.clientUserMessageId } });
  }
  if (['thread/read', 'thread/turns/list', 'thread/items/list'].includes(request.method)) {
    if (!existsSync(process.env.REVERSE_QUEUE_STATE)) {
      const baseline = [{ id: 'older-unrelated', status: 'completed', error: null, items: [
        { id: 'baseline-user', type: 'userMessage', clientId: 'unrelated-baseline-client', content: [{ type: 'text', text: 'Prior conversation history' }] },
        { id: 'baseline-answer', type: 'agentMessage', phase: 'final_answer', text: 'WRONG_UNRELATED_ANSWER' },
      ] }];
      if (request.method === 'thread/read') reply({ thread: { id: request.params.threadId, turns: baseline } });
      else reply({ data: baseline, nextCursor: null });
      continue;
    }
    const state = JSON.parse(readFileSync(process.env.REVERSE_QUEUE_STATE, 'utf8'));
    const mode = process.env.REVERSE_TEST_MODE;
    const released = existsSync(process.env.REVERSE_QUEUE_RELEASE);
    const status = mode === 'queue-failed' ? 'failed' : mode === 'queue-interrupted' ? 'interrupted' : released ? 'completed' : 'inProgress';
    const unrelated = (id) => ({ id, status: 'completed', error: null, items: [
      { id: id + '-user', type: 'userMessage', clientId: 'different-client-' + id, content: [{ type: 'text', text: 'An unrelated request' }] },
      { id: id + '-answer', type: 'agentMessage', phase: 'final_answer', text: 'WRONG_UNRELATED_ANSWER' },
    ] });
    const target = { id: 'fixture-correlated-turn', status,
      error: status === 'failed' ? { message: 'FIXTURE_QUEUED_TURN_FAILED' } : null,
      items: [
        { id: 'fixture-matching-user', type: 'userMessage', clientId: mode === 'queue-mismatch' ? 'wrong-' + state.clientUserMessageId : state.clientUserMessageId, content: state.input },
        { id: 'fixture-partial-answer', type: 'agentMessage', phase: 'commentary', text: 'PARTIAL_MUST_NOT_SETTLE' },
        { id: 'fixture-final-answer', type: 'agentMessage', phase: 'final_answer', text: status === 'completed' ? 'QUEUED_CODEX_REPLY' : 'EARLY_TEXT_IS_NOT_COMPLETION' },
      ] };
    const turns = [unrelated('newer-unrelated'), target, unrelated('older-unrelated')];
    if (request.method === 'thread/read') reply({ thread: { id: state.threadId, turns } });
    else if (request.method === 'thread/items/list') {
      const entries = target.items.map((item) => ({ item, turnId: target.id, startedAtMs: null, completedAtMs: null }));
      if (!request.params.cursor) reply({ data: entries.slice(0, 2), nextCursor: 'fixture-items-page-2' });
      else reply({ data: [{ turnId: 'foreign-turn-must-be-ignored',
        item: { id: 'foreign-answer', type: 'agentMessage', phase: 'final_answer', text: 'WRONG_FOREIGN_TURN_ANSWER' } },
        ...entries.slice(2)], nextCursor: null });
    } else if (mode === 'queue-paged' && !request.params.cursor) {
      reply({ data: [unrelated('newer-unrelated')], nextCursor: 'fixture-turns-page-2' });
    } else {
      if (mode === 'queue-full-items') target.items = target.items.filter(({ type }) => type === 'userMessage');
      const page = mode === 'queue-paged' ? [target, unrelated('older-unrelated')] : turns;
      reply({ data: page, nextCursor: null });
    }
  }
  if (request.method === 'thread/name/set') reply({});
  if (request.method === 'turn/start') {
    if (process.env.REVERSE_TEST_MODE === 'turn-error') {
      send({ id: request.id, error: { code: -32003, message: 'FIXTURE_TURN_FAILED_AFTER_THREAD_CREATED' } });
      continue;
    }
    reply({ turn: { id: 'fake-turn', status: 'inProgress', items: [] } });
    const currentThreadId = request.params.threadId;
    if (process.env.REVERSE_TEST_MODE === 'approval') {
      send({ id: 'untrusted-approval-request', method: 'item/commandExecution/requestApproval', params: { command: 'must never run' } });
    } else if (process.env.REVERSE_TEST_MODE === 'item-final') {
      send({ method: 'item/completed', params: { threadId: 'foreign-thread', turnId: 'fake-turn',
        item: { id: 'foreign-item', type: 'agentMessage', phase: 'final_answer', text: 'FOREIGN_THREAD_FINAL' } } });
      send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'old-turn',
        item: { id: 'old-item', type: 'agentMessage', phase: 'final_answer', text: 'OLD_TURN_FINAL' } } });
      send({ method: 'turn/completed', params: { threadId: 'foreign-thread',
        turn: { id: 'fake-turn', status: 'completed', items: [{ id: 'foreign-turn', type: 'agentMessage', phase: 'final_answer', text: 'FOREIGN_TURN_FINAL' }] } } });
      send({ method: 'turn/completed', params: { threadId: currentThreadId,
        turn: { id: 'old-turn', status: 'completed', items: [{ id: 'old-turn', type: 'agentMessage', phase: 'final_answer', text: 'OLD_TURN_FINAL' }] } } });
      send({ method: 'item/completed', params: { threadId: currentThreadId, turnId: 'fake-turn',
        item: { id: 'item-final', type: 'agentMessage', phase: 'final_answer', text: 'ITEM_COMPLETED_FINAL' } } });
      send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'fake-turn', status: 'completed', items: [] } } });
    } else if (process.env.REVERSE_TEST_MODE !== 'hold') {
      const mode = process.env.REVERSE_TEST_MODE;
      const finalItems = mode === 'empty-final' ? []
        : mode === 'commentary-only' ? [{ id: 'commentary-only', type: 'agentMessage', phase: 'commentary', text: 'COMMENTARY_MUST_NOT_SETTLE' }]
        : [{ id: 'final-reply', type: 'agentMessage', phase: 'final_answer', text: 'FAKE_CODEX_REPLY' }];
      send({ method: 'item/agentMessage/delta', params: { delta: 'COMMENTARY_DELTA_MUST_NOT_BE_FINAL' } });
      send({ method: 'turn/completed', params: { threadId: currentThreadId, turn: { id: 'fake-turn', status: 'completed', items: finalItems } } });
    }
  }
}
`);
await writeFile(fakeDsh, 'process.stdout.write("ISOLATED_DSH_FIXTURE_COMPLETE");\n');

const baseEnv = {
  ...process.env,
  CODEX_BIN: fakeCodex,
  DSH_BIN: fakeDsh,
  DSH_CODEX_MAILBOX_DIR: mailbox,
  DSH_BRIDGE_PATCH: '',
  DSH_CODEX_CHAT_TIMEOUT_MS: '3000',
  REVERSE_TEST_REQUESTS: requestsPath,
  REVERSE_TEST_MODE: '',
  DSH_BRIDGE_LEAD: 'codex',
  DSH_PROFILE: '',
  DSH_SESSION_ID: '',
};

async function connect(role, extraEnv = {}) {
  const client = new Client({ name: 'reverse-role-fixture-test', version: '0.2.4-windows.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(here, 'server.mjs')],
    cwd: here,
    env: { ...baseEnv, DSH_BRIDGE_ROLE: role, ...extraEnv },
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

function parsed(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

const ask = (client, arguments_) => client.callTool({ name: 'ask_codex', arguments: arguments_ }, undefined, { timeout: 10000 });
const status = async (client, taskId) => parsed(await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId } }));
async function requests() {
  try { return (await readFile(requestsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function waitUntil(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((accept) => setTimeout(accept, 20));
  }
  throw new Error('condition timed out');
}

try {
  const originalClient = await connect('');
  assert.deepEqual((await originalClient.listTools()).tools.map(({ name }) => name).sort(), [
    'delegate_to_deepseek', 'list_deepseek_messages', 'reply_to_deepseek', 'get_bridge_task_status',
    'list_project_links', 'read_project_context', 'share_project_context',
  ].sort());
  const reverseClient = await connect('dsh');
  assert.deepEqual((await reverseClient.listTools()).tools.map(({ name }) => name).sort(), [
    'ask_codex', 'get_bridge_task_status',
    'list_project_links', 'read_project_context', 'share_project_context',
  ].sort());

  const noProgress = await ask(reverseClient, { message: 'Do work without any evidence', workspace });
  assert.equal(noProgress.isError, true);
  assert.match(noProgress.content[0].text, /progress|evidence/iu);
  assert.equal((await requests()).length, 0);
  assert.equal((await reverseClient.listTools()).tools.length, 5);

  const first = parsed(await ask(reverseClient, {
    message: 'I inspected the parser. Should I retain its current error handling?',
    progress: 'Parser and failure cases inspected',
    evidence: 'All work is inside an isolated Node fixture',
    workspace,
  }));
  assert.ok(first.taskId);
  assert.equal(first.rootTaskId, first.taskId);
  assert.match(first.threadId, /^fake-thread-/u);
  assert.equal(first.reply.sender, 'codex');
  assert.equal(first.reply.recipient, 'dsh');
  assert.equal(first.reply.body, 'FAKE_CODEX_REPLY');
  const firstLedger = await status(reverseClient, first.taskId);
  assert.equal(firstLedger.owner, 'dsh');
  assert.equal(firstLedger.origin, 'dsh');
  assert.equal(firstLedger.workspace, resolve(workspace));
  assert.equal(firstLedger.status, 'completed');
  assert.equal(firstLedger.codexThreadId, first.threadId);

  const resumed = parsed(await ask(reverseClient, {
    taskId: first.taskId,
    message: 'Continue the same conversation after checking the final edge case.',
    progress: 'First Codex response was received and reviewed',
  }));
  assert.equal(resumed.taskId, first.taskId);
  assert.equal(resumed.rootTaskId, first.taskId);
  assert.equal(resumed.threadId, first.threadId);
  assert.equal(resumed.reply.body, 'FAKE_CODEX_REPLY');
  let recorded = await requests();
  const starts = recorded.filter(({ method }) => method === 'thread/start');
  const resumes = recorded.filter(({ method }) => method === 'thread/resume');
  assert.equal(starts.length, 1);
  assert.equal(resumes.length, 1);
  assert.equal(starts[0].params.cwd, resolve(workspace));
  assert.equal(resumes[0].params.cwd, resolve(workspace));
  assert.equal(resumes[0].params.threadId, first.threadId);
  assert.equal(recorded.filter(({ method }) => method === 'turn/start').length, 2);
  assert.equal(recorded.filter(({ method }) => method === 'thread/name/set').length, 1, 'Resuming must preserve the existing title');
  assert.ok(recorded.every(({ processArgs }) => processArgs.includes('app-server')));

  const mismatchClient = await connect('dsh', { REVERSE_TEST_MODE: 'resume-mismatch' });
  const beforeResumeMismatch = (await requests()).length;
  const resumeMismatch = await ask(mismatchClient, {
    taskId: first.taskId, message: 'This resume must not accept a different thread',
    progress: 'The fixture returns the wrong resumed thread ID',
  });
  assert.equal(resumeMismatch.isError, true);
  assert.match(resumeMismatch.content[0].text, /different thread|resum/iu);
  const resumeMismatchRequests = (await requests()).slice(beforeResumeMismatch);
  assert.equal(resumeMismatchRequests.filter(({ method }) => method === 'thread/resume').length, 1);
  assert.equal(resumeMismatchRequests.filter(({ method }) => method === 'turn/start').length, 0,
    'A mismatched resume must be rejected before any turn starts');
  assert.equal((await status(mismatchClient, first.taskId)).codexThreadId, first.threadId);
  await close(mismatchClient);

  const itemFinalClient = await connect('dsh', { REVERSE_TEST_MODE: 'item-final' });
  const itemFinal = parsed(await ask(itemFinalClient, {
    workspace, message: 'Use the authoritative item/completed final when the turn items are empty',
    progress: 'The fixture sends the final only through item/completed',
  }));
  assert.equal(itemFinal.reply.body, 'ITEM_COMPLETED_FINAL');
  await close(itemFinalClient);

  const beforeChangedWorkspace = (await requests()).length;
  const changedWorkspace = await ask(reverseClient, {
    taskId: first.taskId, workspace: otherWorkspace,
    message: 'Attempt to move the existing thread to another workspace', progress: 'This must be rejected',
  });
  assert.equal(changedWorkspace.isError, true);
  assert.match(changedWorkspace.content[0].text, /workspace/iu);
  assert.equal((await requests()).length, beforeChangedWorkspace);
  const unchanged = await status(reverseClient, first.taskId);
  assert.equal(unchanged.workspace, firstLedger.workspace);
  assert.equal(unchanged.codexThreadId, first.threadId);

  const explicitThread = 'fixture-preexisting-codex-thread';
  const beforeExplicit = (await requests()).length;
  const explicit = parsed(await ask(reverseClient, {
    message: 'Continue the specific existing Codex conversation selected by the user',
    progress: 'The requested existing conversation was explicitly supplied', workspace,
    codexThreadId: explicitThread,
  }));
  assert.equal(explicit.threadId, explicitThread);
  assert.equal(explicit.codexThreadId, explicitThread);
  assert.equal(explicit.dshSessionId, null);
  const explicitLedger = await status(reverseClient, explicit.taskId);
  assert.equal(explicitLedger.origin, 'dsh');
  assert.equal(explicitLedger.codexThreadId, explicitThread);
  let explicitRequests = (await requests()).slice(beforeExplicit);
  assert.equal(explicitRequests.filter(({ method }) => method === 'thread/start').length, 0);
  assert.equal(explicitRequests.filter(({ method }) => method === 'thread/name/set').length, 0, 'An explicitly selected existing thread must not be renamed');
  assert.equal(explicitRequests.filter(({ method }) => method === 'thread/resume').length, 1);
  assert.equal(explicitRequests.find(({ method }) => method === 'thread/resume').params.threadId, explicitThread);
  const explicitResumed = parsed(await ask(reverseClient, {
    taskId: explicit.taskId, codexThreadId: explicitThread,
    message: 'Continue the same explicitly bound conversation after checking its response',
    evidence: 'The first response from that existing conversation was verified',
  }));
  assert.equal(explicitResumed.threadId, explicitThread);
  assert.equal(explicitResumed.taskId, explicit.taskId);
  explicitRequests = (await requests()).slice(beforeExplicit);
  assert.equal(explicitRequests.filter(({ method }) => method === 'thread/resume').length, 2);
  assert.equal(explicitRequests.filter(({ method }) => method === 'thread/start').length, 0);
  const beforeRejectedRebinding = (await requests()).length;
  const rebound = await ask(reverseClient, {
    taskId: explicit.taskId, codexThreadId: 'forbidden-other-thread',
    message: 'Attempt an unauthorized change to the task conversation', progress: 'This must be rejected',
  });
  assert.equal(rebound.isError, true);
  assert.match(rebound.content[0].text, /thread|bound|change/iu);
  assert.equal((await requests()).length, beforeRejectedRebinding);
  assert.equal((await status(reverseClient, explicit.taskId)).codexThreadId, explicitThread);
  recorded = await requests();

  const delegatedId = 'already-delegated-by-codex';
  const delegated = await originalClient.callTool({
    name: 'delegate_to_deepseek',
    arguments: { task: 'Complete the fixture-owned delegated task', workspace, taskId: delegatedId, rootTaskId: 'delegated-root' },
  });
  assert.equal(delegated.isError, undefined, delegated.content?.[0]?.text);
  const originalLedger = await status(originalClient, delegatedId);
  const takeover = await ask(reverseClient, {
    taskId: delegatedId, message: 'Attempt to take over the delegated task', progress: 'This must be rejected',
  });
  assert.equal(takeover.isError, true);
  assert.match(takeover.content[0].text, /origin|delegat|DSH|initiated/iu);
  assert.equal((await requests()).length, recorded.length);
  assert.deepEqual(await status(originalClient, delegatedId), originalLedger);

  const blocker = parsed(await ask(reverseClient, {
    kind: 'blocker', message: 'A concrete blocker prevents continuing the isolated fixture.', workspace,
  }));
  assert.notEqual(blocker.taskId, first.taskId);
  assert.notEqual(blocker.threadId, first.threadId, 'Unlinked new tasks retain the legacy independent-conversation behavior');
  assert.equal(blocker.reply.body, 'FAKE_CODEX_REPLY');
  assert.equal((await status(reverseClient, blocker.taskId)).origin, 'dsh');
  const messageFiles = (await readdir(join(mailbox, 'messages'))).filter((name) => name.endsWith('.json'));
  const messages = await Promise.all(messageFiles.map(async (name) => JSON.parse(await readFile(join(mailbox, 'messages', name), 'utf8'))));
  const firstQuestion = messages.find(({ id }) => id === first.reply.replyTo);
  assert.equal(firstQuestion.kind, 'question');
  assert.equal(firstQuestion.sender, 'dsh');
  assert.equal(firstQuestion.recipient, 'codex');
  assert.ok(firstQuestion.progress && firstQuestion.evidence);
  assert.equal(messages.find(({ id }) => id === blocker.reply.replyTo).kind, 'blocker');

  const approvalClient = await connect('dsh', { REVERSE_TEST_MODE: 'approval' });
  const approval = await ask(approvalClient, {
    kind: 'blocker', message: 'Exercise an unsupported approval request', workspace,
  });
  assert.equal(approval.isError, true);
  assert.match(approval.content[0].text, /request|approval|unsupported|unexpected/iu);
  assert.doesNotMatch(approval.content[0].text, /timed out/iu);
  assert.equal((await approvalClient.listTools()).tools.length, 5);
  recorded = await requests();
  assert.ok(recorded.some(({ method }) => method === 'turn/start'));

  const dshLeadClient = await connect('dsh', { DSH_BRIDGE_LEAD: 'dsh' });
  const beforeDshLead = (await requests()).length;
  const dshLead = parsed(await ask(dshLeadClient, {
    kind: 'blocker', message: 'DSH requests a bounded debugging review from its Codex assistant', workspace,
  }));
  assert.equal(dshLead.reply.body, 'FAKE_CODEX_REPLY');
  const dshLeadRequests = (await requests()).slice(beforeDshLead);
  const dshLeadTurn = dshLeadRequests.find(({ method }) => method === 'turn/start');
  const dshLeadPrompt = dshLeadTurn.params.input.map(({ text }) => text || '').join('\n');
  assert.ok(dshLeadPrompt.includes('DSH is the project lead and owns planning, coordination, and final decisions.'));
  assert.ok(dshLeadPrompt.includes('Codex is an auxiliary assistant for debugging, review, and recommendations.'));
  assert.ok(dshLeadPrompt.includes('Do not delegate this request back to DSH; return concrete findings and evidence for DSH to assess.'));
  assert.ok(!dshLeadPrompt.includes('Codex is the lead coordinator'));

  const project = await createProjectStore(mailbox).linkProjects({
    name: 'single-collaboration-thread-fixture', codexWorkspace: workspace, dshWorkspace: otherWorkspace,
  });
  const otherProcess = await connect('dsh');
  const projectAsk = (client, input = {}) => ask(client, {
    projectLinkId: project.id, message: 'Review this bounded debugging question for the shared project',
    progress: 'The independent DSH task has supplied concrete debugging progress', ...input,
  });
  const beforeProject = (await requests()).length;
  const projectFirst = parsed(await projectAsk(reverseClient));
  const projectSecond = parsed(await projectAsk(otherProcess, { message: 'A separate DSH task asks its next debugging question' }));
  assert.notEqual(projectFirst.taskId, projectSecond.taskId);
  assert.equal(projectSecond.threadId, projectFirst.threadId, 'Separate tasks and MCP processes must reuse the project conversation');
  let projectRequests = (await requests()).slice(beforeProject);
  assert.equal(projectRequests.filter(({ method }) => method === 'thread/start').length, 1);
  assert.equal(projectRequests.filter(({ method }) => method === 'thread/resume').length, 1);
  assert.equal(projectRequests.find(({ method }) => method === 'thread/resume').params.threadId, projectFirst.threadId);
  assert.equal(projectRequests.filter(({ method }) => method === 'thread/name/set').length, 1);
  assert.equal((await status(reverseClient, projectFirst.taskId)).codexThreadId, projectFirst.threadId);
  assert.equal((await status(otherProcess, projectSecond.taskId)).codexThreadId, projectFirst.threadId);
  const inferred = parsed(await ask(otherProcess, {
    workspace: otherWorkspace, message: 'Infer the uniquely registered project from its DSH workspace',
    progress: 'The caller supplied a workspace but no task or project IDs',
  }));
  assert.equal(inferred.projectLinkId, project.id);
  assert.equal(inferred.threadId, projectFirst.threadId);
  assert.equal((await status(otherProcess, inferred.taskId)).workspace, project.codexWorkspace, 'Workspace inference must route to the canonical paired Codex root');

  let beforeRejected = (await requests()).length;
  for (const newConversationReason of [undefined, ' ']) {
    const missingReason = await projectAsk(reverseClient, {
      newConversation: true, ...(newConversationReason === undefined ? {} : { newConversationReason }),
    }).catch((error) => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
    assert.equal(missingReason.isError, true);
    assert.match(missingReason.content[0].text, /reason|nonempty|small|characters|String/iu);
  }
  assert.equal((await requests()).length, beforeRejected, 'Missing reasons must not create any Codex process');
  const existingTaskNew = await projectAsk(reverseClient, {
    taskId: projectFirst.taskId, newConversation: true,
    newConversationReason: 'A reason cannot authorize replacing the existing task binding',
  });
  assert.equal(existingTaskNew.isError, true);
  assert.match(existingTaskNew.content[0].text, /task|existing|bound|conversation/iu);
  assert.equal((await requests()).length, beforeRejected);
  assert.equal((await status(reverseClient, projectFirst.taskId)).codexThreadId, projectFirst.threadId);

  const projectNew = parsed(await projectAsk(reverseClient, {
    newConversation: true,
    newConversationReason: 'The prior debugging context is complete; this independently scoped topic needs a new conversation.',
  }));
  assert.notEqual(projectNew.threadId, projectFirst.threadId);
  const projectAfterNew = parsed(await projectAsk(otherProcess, {
    message: 'A later independent task must reuse the newly selected project conversation',
  }));
  assert.equal(projectAfterNew.threadId, projectNew.threadId);
  const beforeStaleTask = (await requests()).length;
  const staleTask = await projectAsk(reverseClient, {
    taskId: projectFirst.taskId, message: 'An old task must not silently revive the previous project conversation',
  });
  assert.equal(staleTask.isError, true);
  assert.match(staleTask.content[0].text, /default|current|stale|project.*conversation/iu);
  assert.equal((await requests()).length, beforeStaleTask, 'A stale task must not resume or fork after the project default changes');
  const preservedStaleLedger = await status(reverseClient, projectFirst.taskId);
  assert.equal(preservedStaleLedger.codexThreadId, projectFirst.threadId, 'Reject rather than rewriting an existing task binding');
  assert.equal(preservedStaleLedger.projectLinkId, project.id);
  projectRequests = (await requests()).slice(beforeProject);
  assert.equal(projectRequests.filter(({ method }) => method === 'thread/start').length, 2);
  assert.equal(projectRequests.filter(({ method }) => method === 'thread/resume').length, 3);
  const projectNames = projectRequests.filter(({ method }) => method === 'thread/name/set');
  assert.equal(projectNames.length, 2, 'Only newly created conversations may receive a title');
  assert.equal(projectNames[0].params.name, projectNames[1].params.name, 'Project conversation titles must be stable across tasks');

  const unavailable = await connect('dsh', { REVERSE_TEST_MODE: 'resume-error' });
  const beforeUnavailable = (await requests()).length;
  const unavailableResult = await projectAsk(unavailable);
  assert.equal(unavailableResult.isError, true);
  assert.match(unavailableResult.content[0].text, /FIXTURE_EXISTING_THREAD_UNAVAILABLE/u);
  const unavailableRequests = (await requests()).slice(beforeUnavailable);
  assert.equal(unavailableRequests.filter(({ method }) => method === 'thread/resume').length, 1);
  assert.equal(unavailableRequests.filter(({ method }) => method === 'thread/start').length, 0, 'A resume failure must never fork a replacement conversation');
  assert.equal(unavailableRequests.filter(({ method }) => method === 'thread/queue/add').length, 0, 'Only an active-writer conflict may use the public queue');
  const afterUnavailable = parsed(await projectAsk(otherProcess));
  assert.equal(afterUnavailable.threadId, projectNew.threadId, 'A failed resume must preserve the project default');

  // A real second bridge process must reject while the first owns the project turn.
  const holding = await connect('dsh', { REVERSE_TEST_MODE: 'hold', DSH_CODEX_CHAT_TIMEOUT_MS: '1500' });
  const beforeHolding = (await requests()).length;
  const holdCall = projectAsk(holding).catch((error) => error);
  await waitUntil(async () => (await requests()).slice(beforeHolding).some(({ method }) => method === 'turn/start'));
  const duringHolding = (await requests()).length;
  const busy = await projectAsk(otherProcess);
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /busy|lock/iu);
  assert.equal((await requests()).length, duringHolding, 'A busy project must not launch, queue, or fork a second Codex process');
  assert.equal((await holdCall).isError, true);
  const afterHolding = parsed(await projectAsk(otherProcess));
  assert.equal(afterHolding.threadId, projectNew.threadId);

  const store = createProjectStore(mailbox);
  const initFailureProject = await store.linkProjects({
    name: 'initialization-failure-project', codexWorkspace: workspace, dshWorkspace: otherWorkspace,
  });
  const initializationFailure = await connect('dsh', { REVERSE_TEST_MODE: 'init-error' });
  const beforeInitializationFailure = (await requests()).length;
  const failedInitialization = await projectAsk(initializationFailure, { projectLinkId: initFailureProject.id });
  assert.equal(failedInitialization.isError, true);
  assert.match(failedInitialization.content[0].text, /FIXTURE_INITIALIZE_FAILED/u);
  assert.equal((await requests()).slice(beforeInitializationFailure).filter(({ method }) => method === 'thread/start').length, 0);
  assert.equal(await store.getProjectConversation(initFailureProject.id), null, 'An initialization failure must not invent a default thread');
  const afterInitializationFailure = parsed(await projectAsk(otherProcess, { projectLinkId: initFailureProject.id }));
  assert.match(afterInitializationFailure.threadId, /^fake-thread-/u);
  assert.equal((await requests()).slice(beforeInitializationFailure).filter(({ method }) => method === 'thread/start').length, 1);

  const turnFailureProject = await store.linkProjects({
    name: 'turn-failure-project', codexWorkspace: workspace, dshWorkspace: otherWorkspace,
  });
  const turnFailure = await connect('dsh', { REVERSE_TEST_MODE: 'turn-error' });
  const beforeTurnFailure = (await requests()).length;
  const failedTurn = await projectAsk(turnFailure, { projectLinkId: turnFailureProject.id });
  assert.equal(failedTurn.isError, true);
  assert.match(failedTurn.content[0].text, /FIXTURE_TURN_FAILED_AFTER_THREAD_CREATED/u);
  const createdBeforeFailure = await store.getProjectConversation(turnFailureProject.id);
  assert.match(createdBeforeFailure.threadId, /^fake-thread-/u, 'A real thread ID must persist even when its first model turn fails');
  const failedTurnTaskId = /\(taskId=([^)]+)\)/u.exec(failedTurn.content[0].text)?.[1];
  assert.ok(failedTurnTaskId);
  assert.equal((await status(reverseClient, failedTurnTaskId)).codexThreadId, createdBeforeFailure.threadId,
    'The failed task must retain the native thread that was actually created');
  const afterTurnFailure = parsed(await projectAsk(otherProcess, { projectLinkId: turnFailureProject.id }));
  assert.equal(afterTurnFailure.threadId, createdBeforeFailure.threadId);
  const turnFailureRequests = (await requests()).slice(beforeTurnFailure);
  assert.equal(turnFailureRequests.filter(({ method }) => method === 'thread/start').length, 1, 'A failed initial turn must not cause the next task to fork');
  assert.equal(turnFailureRequests.filter(({ method }) => method === 'thread/resume').length, 1);

  const emptyFinalProject = await store.linkProjects({
    name: 'empty-final-project', codexWorkspace: workspace, dshWorkspace: otherWorkspace,
  });
  const emptyFinalContext = await store.shareProjectContext({ linkId: emptyFinalProject.id,
    summary: 'EMPTY_FINAL_CONTEXT_MUST_NOT_COMMIT', sourceRole: 'dsh' });
  const emptyFinalClient = await connect('dsh', { REVERSE_TEST_MODE: 'empty-final' });
  const beforeEmptyFinal = (await requests()).length;
  const emptyFinal = await projectAsk(emptyFinalClient, { projectLinkId: emptyFinalProject.id });
  assert.equal(emptyFinal.isError, true);
  assert.match(emptyFinal.content[0].text, /final|empty/iu);
  const emptyFinalConversation = await store.getProjectConversation(emptyFinalProject.id);
  assert.match(emptyFinalConversation.threadId, /^fake-thread-/u);
  const emptyFinalStatePath = join(mailbox, 'project-context-delivery', emptyFinalProject.id,
    'codex', `${emptyFinalConversation.threadId}.json`);
  await assert.rejects(readFile(emptyFinalStatePath), { code: 'ENOENT' },
    'An empty final reply must not commit the context cursor');
  assert.equal((await requests()).slice(beforeEmptyFinal).filter(({ method }) => method === 'turn/start').length, 1);
  await close(emptyFinalClient);
  assert.ok(emptyFinalContext.id);

  const beforeAmbiguous = (await requests()).length;
  const ambiguous = await ask(otherProcess, {
    workspace, message: 'The workspace now matches several registered project pairs', progress: 'The caller must select an explicit project link',
  });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /multiple|more than one|ambiguous|projectLinkId/iu);
  assert.equal((await requests()).length, beforeAmbiguous);
  const unlinkedWorkspace = join(temporary, 'unregistered standalone workspace');
  await mkdir(unlinkedWorkspace);
  const standaloneFirst = parsed(await ask(otherProcess, { workspace: unlinkedWorkspace,
    message: 'An unlinked workspace retains standalone conversation behavior', progress: 'No registered project pair matches this directory' }));
  const standaloneSecond = parsed(await ask(otherProcess, { workspace: unlinkedWorkspace,
    message: 'A second standalone task remains a separate legacy conversation', progress: 'No project was inferred or specified' }));
  assert.equal(standaloneFirst.projectLinkId, null);
  assert.equal(standaloneSecond.projectLinkId, null);
  assert.notEqual(standaloneFirst.threadId, standaloneSecond.threadId);

  async function queueFixture(mode) {
    const directory = join(temporary, mode);
    await mkdir(directory);
    const project = await store.linkProjects({ name: `fixture-${mode}`, codexWorkspace: workspace, dshWorkspace: otherWorkspace });
    const threadId = `fixture-desktop-active-${mode}`;
    await store.bindProjectConversation({ linkId: project.id, threadId, reason: 'Isolated public-queue protocol fixture' });
    const statePath = join(directory, 'queue-state.json');
    const releasePath = join(directory, 'release-completion');
    const environment = { REVERSE_TEST_MODE: mode, REVERSE_QUEUE_STATE: statePath,
      REVERSE_QUEUE_RELEASE: releasePath, DSH_CODEX_CHAT_TIMEOUT_MS: '1500', DSH_CODEX_QUEUE_POLL_MS: '20' };
    const client = await connect('dsh', environment);
    const input = { projectLinkId: project.id, message: `Review the queued debugging request for ${mode}`,
      progress: 'DSH has supplied concrete evidence for this isolated queue fixture' };
    return { project, threadId, statePath, releasePath, environment, client, input };
  }
  const queuedCalls = (recorded) => recorded.filter(({ method }) => method === 'thread/queue/add');
  const assertNoFork = (recorded) => {
    assert.equal(recorded.filter(({ method }) => method === 'thread/start').length, 0);
    assert.equal(recorded.filter(({ method }) => method === 'turn/start').length, 0);
    assert.equal(recorded.filter(({ method }) => method === 'thread/name/set').length, 0);
  };
  const taskIdFromFailure = (result) => {
    try { return JSON.parse(result.content[0].text).taskId; }
    catch { return /\(taskId=([^)]+)\)/u.exec(result.content[0].text)?.[1]; }
  };

  const pagedQueue = await queueFixture('queue-paged');
  const beforePagedQueue = (await requests()).length;
  let queuedSettled = false;
  const queuedCall = ask(pagedQueue.client, pagedQueue.input).then((value) => { queuedSettled = true; return value; },
    (error) => { queuedSettled = true; return error; });
  await waitUntil(async () => {
    const captured = (await requests()).slice(beforePagedQueue);
    const enqueue = captured.findIndex(({ method }) => method === 'thread/queue/add');
    return enqueue >= 0 && captured.slice(enqueue + 1).some(({ method }) => method === 'thread/turns/list');
  });
  assert.equal(queuedSettled, false, 'An enqueue receipt, unrelated completed turn, or matching in-progress text is not a completed assistant reply');
  await writeFile(pagedQueue.releasePath, 'allow matching turn completion');
  const queuedReply = parsed(await queuedCall);
  assert.equal(queuedReply.threadId, pagedQueue.threadId);
  assert.equal(queuedReply.reply.body, 'QUEUED_CODEX_REPLY');
  const pagedRequests = (await requests()).slice(beforePagedQueue);
  assertNoFork(pagedRequests);
  assert.equal(queuedCalls(pagedRequests).length, 1);
  const enqueue = queuedCalls(pagedRequests)[0].params;
  assert.equal(enqueue.threadId, pagedQueue.threadId);
  assert.match(enqueue.clientUserMessageId, /^[a-f0-9-]{36}$/u);
  assert.equal(enqueue.input[0].type, 'text');
  assert.ok(enqueue.input[0].text.includes(pagedQueue.input.message));
  assert.ok(pagedRequests.filter(({ method }) => method === 'initialize').every(({ params }) => params.capabilities?.experimentalApi === true));
  const summaryCalls = pagedRequests.filter(({ method }) => method === 'thread/turns/list');
  assert.ok(summaryCalls.some(({ params }) => params.cursor === 'fixture-turns-page-2'), 'Correlation must search subsequent summary pages');
  assert.ok(summaryCalls.every(({ params }) => params.threadId === pagedQueue.threadId && params.itemsView === 'summary'));
  assert.equal(pagedRequests.filter(({ method }) => method === 'thread/read').length, 0, 'Queue correlation must not read the complete conversation history');

  const itemQueue = await queueFixture('queue-full-items');
  await writeFile(itemQueue.releasePath, 'matching completed summary lacks final text');
  const beforeItems = (await requests()).length;
  const itemReply = parsed(await ask(itemQueue.client, itemQueue.input));
  assert.equal(itemReply.reply.body, 'QUEUED_CODEX_REPLY');
  const itemRequests = (await requests()).slice(beforeItems);
  assertNoFork(itemRequests);
  const itemReads = itemRequests.filter(({ method }) => method === 'thread/items/list');
  assert.ok(itemReads.length >= 2);
  assert.ok(itemReads.every(({ params }) => params.threadId === itemQueue.threadId && params.turnId === 'fixture-correlated-turn'));
  assert.ok(itemReads.some(({ params }) => params.cursor === 'fixture-items-page-2'));
  assert.equal(queuedCalls(itemRequests).length, 1);

  for (const mode of ['queue-failed', 'queue-interrupted']) {
    const f = await queueFixture(mode);
    const before = (await requests()).length;
    const failed = await ask(f.client, f.input);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, mode === 'queue-failed' ? /failed/iu : /interrupted|cancel/iu);
    const native = (await requests()).slice(before);
    assertNoFork(native);
    assert.equal(queuedCalls(native).length, 1);
    const taskId = taskIdFromFailure(failed);
    assert.ok(taskId);
    assert.notEqual((await status(f.client, taskId)).status, 'completed');
  }

  const timeoutQueue = await queueFixture('queue-timeout');
  const timeoutContext = await store.shareProjectContext({ linkId: timeoutQueue.project.id,
    summary: 'QUEUE_CONTEXT_MUST_NOT_COMMIT_EARLY', sourceRole: 'dsh' });
  const timeoutContextPath = join(mailbox, 'project-context-delivery', timeoutQueue.project.id,
    'codex', `${timeoutQueue.threadId}.json`);
  await assert.rejects(readFile(timeoutContextPath), { code: 'ENOENT' });
  const beforeTimeoutQueue = (await requests()).length;
  const timedOut = await ask(timeoutQueue.client, timeoutQueue.input);
  assert.equal(timedOut.isError, true);
  const pending = JSON.parse(timedOut.content[0].text);
  assert.equal(pending.status, 'queuedPending');
  assert.equal(pending.queuedPending, true);
  assert.equal(pending.threadId, timeoutQueue.threadId);
  assert.ok(pending.taskId && pending.queueReceipt.clientUserMessageId);
  await assert.rejects(readFile(timeoutContextPath), { code: 'ENOENT' },
    'Queue acceptance or a waiting timeout must not advance the delivery cursor');
  const queuedMessagePath = join(mailbox, 'messages', `${pending.queueReceipt.messageId}.json`);
  const queuedSnapshot = JSON.parse(await readFile(queuedMessagePath, 'utf8'));
  assert.ok(queuedSnapshot.contextSnapshot, 'The pending message must persist its selected context snapshot');
  const queuedSnapshotText = queuedSnapshot.contextSnapshot;
  const pendingStatus = await status(timeoutQueue.client, pending.taskId);
  assert.equal(pendingStatus.status, 'queuedPending');
  assert.equal(pendingStatus.pendingQueueReceipt.clientUserMessageId, pending.queueReceipt.clientUserMessageId);
  const changedPending = await ask(timeoutQueue.client, { ...timeoutQueue.input, taskId: pending.taskId,
    message: 'A different request must not replace an already queued request' });
  assert.equal(changedPending.isError, true);
  const omittedPending = await ask(timeoutQueue.client, { ...timeoutQueue.input, message: 'A new task must notice the existing pending project request' });
  assert.equal(omittedPending.isError, true);
  assert.ok(omittedPending.content[0].text.includes(pending.taskId));
  assert.equal(queuedCalls((await requests()).slice(beforeTimeoutQueue)).length, 1);
  await writeFile(timeoutQueue.releasePath, 'the original queued turn completed after the caller timeout');
  const pollingClient = await connect('dsh', timeoutQueue.environment);
  const polled = parsed(await ask(pollingClient, { ...timeoutQueue.input, taskId: pending.taskId }));
  assert.equal(polled.threadId, timeoutQueue.threadId);
  assert.equal(polled.reply.body, 'QUEUED_CODEX_REPLY');
  assert.equal(polled.reply.replyTo, pending.queueReceipt.messageId);
  const timeoutContextState = JSON.parse(await readFile(timeoutContextPath, 'utf8'));
  assert.ok(timeoutContextState.seen.some(({ id }) => id === timeoutContext.id),
    'A completed queued reply commits the exact context snapshot it was sent with');
  const afterQueuedSnapshot = JSON.parse(await readFile(queuedMessagePath, 'utf8'));
  assert.equal(afterQueuedSnapshot.contextSnapshot, queuedSnapshotText,
    'Continuing a pending receipt must reuse, not rewrite, the original context snapshot');
  const timeoutNative = (await requests()).slice(beforeTimeoutQueue);
  assertNoFork(timeoutNative);
  assert.equal(queuedCalls(timeoutNative).length, 1, 'Continuing a pending receipt across bridge processes must only poll, never enqueue again');
  const settledStatus = await status(pollingClient, pending.taskId);
  assert.equal(settledStatus.status, 'completed');
  assert.ok(!settledStatus.pendingQueueReceipt);
  assert.equal(settledStatus.queueReceipt.status, 'completed');
  const timeoutMessages = (await Promise.all((await readdir(join(mailbox, 'messages'))).filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(mailbox, 'messages', name), 'utf8'))))).filter(({ taskId }) => taskId === pending.taskId);
  assert.equal(timeoutMessages.filter(({ sender }) => sender === 'dsh').length, 1);
  assert.equal(timeoutMessages.filter(({ sender }) => sender === 'codex').length, 1);

  const mismatchQueue = await queueFixture('queue-mismatch');
  await writeFile(mismatchQueue.releasePath, 'only an unrelated client ID is present');
  const beforeMismatch = (await requests()).length;
  const mismatch = await ask(mismatchQueue.client, mismatchQueue.input);
  assert.equal(mismatch.isError, true);
  assert.equal(JSON.parse(mismatch.content[0].text).status, 'queuedPending', 'Unrelated completed replies must never satisfy the receipt');
  assertNoFork((await requests()).slice(beforeMismatch));
  assert.equal(queuedCalls((await requests()).slice(beforeMismatch)).length, 1);

  const cancelledQueue = await queueFixture('queue-caller-cancel');
  const beforeCancelledQueue = (await requests()).length;
  const queueController = new AbortController();
  const cancelledCall = cancelledQueue.client.callTool({ name: 'ask_codex', arguments: cancelledQueue.input },
    undefined, { timeout: 10000, signal: queueController.signal }).catch((error) => error);
  await waitUntil(async () => {
    const captured = (await requests()).slice(beforeCancelledQueue);
    const enqueue = captured.findIndex(({ method }) => method === 'thread/queue/add');
    return enqueue >= 0 && captured.slice(enqueue + 1).some(({ method }) => method === 'thread/turns/list');
  });
  const cancellationLedgers = await Promise.all((await readdir(join(mailbox, 'tasks'))).filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(join(mailbox, 'tasks', name), 'utf8'))));
  const cancellationTask = cancellationLedgers.find(({ projectLinkId }) => projectLinkId === cancelledQueue.project.id);
  assert.ok(cancellationTask);
  queueController.abort();
  await cancelledCall;
  await waitUntil(async () => {
    const state = await status(cancelledQueue.client, cancellationTask.taskId);
    // Receipt publication already sets queuedPending before the wait ends.
    // The error is persisted only after the cancelled server handler has unwound.
    return state.status === 'queuedPending' && typeof state.error === 'string' && state.error.length > 0;
  });
  const cancelledReceipt = await status(cancelledQueue.client, cancellationTask.taskId);
  assert.ok(cancelledReceipt.pendingQueueReceipt.clientUserMessageId);
  assert.equal(queuedCalls((await requests()).slice(beforeCancelledQueue)).length, 1);
  await writeFile(cancelledQueue.releasePath, 'the desktop completed after the waiting caller cancelled');
  let recoveredCancellation;
  await waitUntil(async () => {
    const result = await ask(cancelledQueue.client, { ...cancelledQueue.input, taskId: cancellationTask.taskId });
    if (result.isError && /already running|conversation is busy/iu.test(result.content[0].text)) return false;
    recoveredCancellation = parsed(result);
    return true;
  });
  assert.equal(recoveredCancellation.reply.body, 'QUEUED_CODEX_REPLY');
  assert.equal(recoveredCancellation.threadId, cancelledQueue.threadId);
  const cancelledNative = (await requests()).slice(beforeCancelledQueue);
  assertNoFork(cancelledNative);
  assert.equal(queuedCalls(cancelledNative).length, 1, 'Cancelling the waiter must preserve one receipt and never duplicate the desktop submission');

  console.log('DSH role, project conversation reuse, justified new threads, no-fork failures, cross-process locking, active-writer queue correlation/pagination, receipt-only pending recovery, terminal failures, and DSH-led prompt: ok');
} finally {
  for (const client of liveClients) await client.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
