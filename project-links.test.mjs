import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProjectStore } from './project-links.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-project-links-'));
  const cleanups = [];
  // Only this test's own temporary tree is removed.
  t.after(async () => {
    for (const cleanup of [...cleanups].reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const codexWorkspace = join(root, "Codex 中文 project's workspace");
  const dshWorkspace = join(root, 'DSH 中文 workspace');
  const otherWorkspace = join(root, 'unlinked workspace');
  await Promise.all([codexWorkspace, dshWorkspace, otherWorkspace].map((path) => mkdir(path)));
  const mailbox = join(root, 'isolated mailbox');
  const store = createProjectStore(mailbox);
  const project = await store.linkProjects({ name: 'Fixture project pair', codexWorkspace, dshWorkspace });
  return { root, codexWorkspace, dshWorkspace, otherWorkspace, mailbox, store, project, cleanups };
}

async function bytesByName(directory) {
  return new Map(await Promise.all((await readdir(directory)).map(async (name) => [
    name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex'),
  ])));
}

test('project links preserve canonical roots and reject an attempt to replace an existing pair', async (t) => {
  const f = await fixture(t);
  assert.ok(f.project.id);
  assert.equal(f.project.codexWorkspace, await realpath(f.codexWorkspace));
  assert.equal(f.project.dshWorkspace, await realpath(f.dshWorkspace));
  const original = await readFile(join(f.mailbox, 'project-links', `${f.project.id}.json`));
  const repeated = await f.store.linkProjects({
    name: 'fixture PROJECT pair', codexWorkspace: join(f.codexWorkspace, '.'), dshWorkspace: f.dshWorkspace,
  });
  assert.deepEqual(repeated, f.project);
  await assert.rejects(f.store.linkProjects({
    name: f.project.name, codexWorkspace: f.otherWorkspace, dshWorkspace: f.dshWorkspace,
  }), /different workspaces|preserved/iu);
  assert.deepEqual(await readFile(join(f.mailbox, 'project-links', `${f.project.id}.json`)), original);
  assert.deepEqual(await f.store.listProjectLinks(), [f.project]);
  await assert.rejects(f.store.linkProjects({
    name: 'Missing root', codexWorkspace: join(f.root, 'missing'), dshWorkspace: f.dshWorkspace,
  }));
});

test('context contains only explicitly shared records, with validated source and link identities', async (t) => {
  const f = await fixture(t);
  const privateMarker = 'PRIVATE_WORKSPACE_HISTORY_MUST_NOT_BE_DISCOVERED';
  const privateFiles = [];
  for (const workspace of [f.codexWorkspace, f.dshWorkspace]) {
    const directory = join(workspace, '.dsh', 'sessions');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'private-history.jsonl');
    await writeFile(path, privateMarker);
    privateFiles.push(path);
  }
  assert.deepEqual((await f.store.readProjectContext({ linkId: f.project.id })).entries, []);
  const first = await f.store.shareProjectContext({
    linkId: f.project.id, sourceRole: 'codex', summary: 'Approved Codex design decision',
    topic: 'Architecture', conversationId: 'fixture-codex-thread',
  });
  const second = await f.store.shareProjectContext({
    linkId: f.project.id, sourceRole: 'dsh', summary: 'Approved DSH inspection result',
  });
  const directory = join(f.mailbox, 'project-context', f.project.id);
  await writeFile(join(directory, '000-foreign-link.json'), JSON.stringify({
    ...first, id: 'foreign-link', linkId: 'project-000000000000000000000000', summary: 'FOREIGN_LINK_MUST_NOT_APPEAR',
  }));
  await writeFile(join(directory, '001-foreign-source.json'), JSON.stringify({
    ...first, id: 'foreign-source', sourceRole: 'outsider', summary: 'FOREIGN_SOURCE_MUST_NOT_APPEAR',
  }));
  await writeFile(join(directory, '002-incomplete.json'), '{incomplete foreign record');
  await writeFile(join(directory, '003-malformed-id.json'), JSON.stringify({
    id: '../../escape', linkId: f.project.id, summary: 'MALFORMED_ID_MUST_NOT_ESCAPE',
    sourceRole: 'dsh', createdAt: new Date().toISOString(),
  }));
  const read = await f.store.readProjectContext({ linkId: f.project.id, limit: 100 });
  assert.deepEqual(read.link, f.project);
  assert.deepEqual(new Set(read.entries.map(({ id }) => id)), new Set([first.id, second.id]));
  assert.equal(read.entries.find(({ id }) => id === first.id).sourceRole, 'codex');
  assert.equal(read.entries.find(({ id }) => id === second.id).sourceRole, 'dsh');
  assert.equal(second.topic, null);
  assert.equal(second.conversationId, null);
  assert.doesNotMatch(JSON.stringify(read), /PRIVATE_WORKSPACE_HISTORY|FOREIGN_LINK|FOREIGN_SOURCE/u);
  for (const path of privateFiles) assert.equal(await readFile(path, 'utf8'), privateMarker);
  assert.equal((await readFile(join(directory, '002-incomplete.json'), 'utf8')), '{incomplete foreign record');
  for (const bad of [
    { sourceRole: 'outsider', summary: 'Wrong source' },
    { sourceRole: 'codex', summary: ' ' },
    { sourceRole: 'dsh', summary: 'x'.repeat(8001) },
    { sourceRole: 'dsh', summary: 'Valid summary', topic: 'x'.repeat(161) },
  ]) await assert.rejects(f.store.shareProjectContext({ linkId: f.project.id, ...bad }));
});

test('safe project aliases are usable IDs while reserved or unsafe names remain safe filenames', async (t) => {
  const f = await fixture(t);
  const alias = await f.store.linkProjects({
    name: 'fixture-alias', codexWorkspace: f.codexWorkspace, dshWorkspace: f.dshWorkspace,
  });
  assert.equal(alias.id, 'fixture-alias');
  assert.deepEqual(await f.store.getProjectLink(alias.id), alias);
  for (const name of ['CON', 'NUL.json', '../outside', '中文配对']) {
    const link = await f.store.linkProjects({ name, codexWorkspace: f.codexWorkspace, dshWorkspace: f.dshWorkspace });
    assert.match(link.id, /^project-[a-f0-9]{24}$/u);
    assert.deepEqual(await f.store.getProjectLink(link.id), link);
    await assert.doesNotReject(readFile(join(f.mailbox, 'project-links', `${link.id}.json`)));
  }
});

test('invalid context addresses never escape the mailbox, and read limits are bounded', async (t) => {
  const f = await fixture(t);
  const before = await readdir(f.root);
  for (const linkId of ['../escape', '..\\escape', '/absolute', 'C:\\absolute', '', '\0']) {
    await assert.rejects(f.store.getProjectLink(linkId));
    await assert.rejects(f.store.readProjectContext({ linkId }));
    await assert.rejects(f.store.shareProjectContext({ linkId, sourceRole: 'codex', summary: 'Must reject' }));
  }
  for (const limit of [0, -1, 101, 1.5]) {
    await assert.rejects(f.store.readProjectContext({ linkId: f.project.id, limit }));
  }
  assert.deepEqual(await readdir(f.root), before);
  assert.equal((await f.store.listProjectLinks()).length, 1);
});

test('concurrent independent writers append complete unique context files without replacing old records', async (t) => {
  const f = await fixture(t);
  const first = await f.store.shareProjectContext({ linkId: f.project.id, sourceRole: 'codex', summary: 'Original immutable record' });
  const directory = join(f.mailbox, 'project-context', f.project.id);
  const originalFiles = await bytesByName(directory);
  const sameProcess = Array.from({ length: 12 }, (_, index) => f.store.shareProjectContext({
    linkId: f.project.id, sourceRole: index % 2 ? 'dsh' : 'codex', summary: `Concurrent in-process record ${index}`,
  }));
  const source = `import { createProjectStore } from ${JSON.stringify(pathToFileURL(join(here, 'project-links.mjs')).href)};\n`
    + 'const [mailbox,linkId,index]=process.argv.slice(1);\n'
    + 'await createProjectStore(mailbox).shareProjectContext({linkId,sourceRole:Number(index)%2?"codex":"dsh",summary:`Concurrent process record ${index}`});\n';
  const separateProcesses = Array.from({ length: 8 }, (_, index) => run(process.execPath, [
    '--input-type=module', '-e', source, f.mailbox, f.project.id, String(index),
  ], { windowsHide: true, timeout: 15000 }));
  const concurrentReads = Array.from({ length: 12 }, () => f.store.readProjectContext({ linkId: f.project.id, limit: 100 }));
  const snapshots = await Promise.all(concurrentReads);
  await Promise.all([...sameProcess, ...separateProcesses]);
  for (const { entries } of snapshots) {
    assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
    assert.ok(entries.every((entry) => entry.linkId === f.project.id && typeof entry.summary === 'string'
      && ['codex', 'dsh'].includes(entry.sourceRole)));
  }
  const entries = (await f.store.readProjectContext({ linkId: f.project.id, limit: 100 })).entries;
  assert.equal(entries.length, 21);
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
  assert.equal(new Set(entries.map(({ summary }) => summary)).size, entries.length);
  assert.equal(entries.find(({ id }) => id === first.id).summary, first.summary);
  const finalFiles = await bytesByName(directory);
  assert.equal(finalFiles.size, 21);
  for (const [name, hash] of originalFiles) assert.equal(finalFiles.get(name), hash);
  assert.ok([...finalFiles.keys()].every((name) => name.endsWith('.json')));
  const latest = (await f.store.readProjectContext({ linkId: f.project.id, limit: 3 })).entries;
  assert.equal(latest.length, 3);
  assert.deepEqual(latest, [...latest].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
});

test('the selected project conversation persists across stores and processes while the project roots stay unchanged', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.store.getProjectConversation(f.project.id), null);
  const linkPath = join(f.mailbox, 'project-links', `${f.project.id}.json`);
  const originalLink = await readFile(linkPath);
  const initial = await f.store.bindProjectConversation({
    linkId: f.project.id, threadId: 'fixture-existing-main-thread', reason: 'Use the selected existing project conversation',
  });
  assert.equal(initial.linkId, f.project.id);
  assert.equal(initial.threadId, 'fixture-existing-main-thread');
  assert.deepEqual(await createProjectStore(f.mailbox).getProjectConversation(f.project.id), initial);
  const source = `import { createProjectStore } from ${JSON.stringify(pathToFileURL(join(here, 'project-links.mjs')).href)};\n`
    + 'const [mailbox,linkId]=process.argv.slice(1);\n'
    + 'process.stdout.write(JSON.stringify(await createProjectStore(mailbox).getProjectConversation(linkId)));\n';
  const separate = await run(process.execPath, ['--input-type=module', '-e', source, f.mailbox, f.project.id], {
    windowsHide: true, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(separate.stdout), initial);
  const replacement = await f.store.bindProjectConversation({
    linkId: f.project.id, threadId: 'fixture-deliberate-new-thread', reason: 'The old fixture conversation is no longer suitable',
  });
  assert.equal(replacement.threadId, 'fixture-deliberate-new-thread');
  assert.equal(replacement.reason, 'The old fixture conversation is no longer suitable');
  assert.deepEqual(await createProjectStore(f.mailbox).getProjectConversation(f.project.id), replacement);
  assert.deepEqual(await readFile(linkPath), originalLink);
});

test('conversation bindings require an owned live lease, and pre-thread failures leave no default conversation', async (t) => {
  const f = await fixture(t);
  const input = { linkId: f.project.id, threadId: 'fixture-new-thread' };
  await assert.rejects(f.store.setProjectConversation(input, { linkId: f.project.id, release: async () => {} }));
  const failedLease = await f.store.acquireProjectConversationLock(f.project.id);
  try {
    await assert.rejects((async () => { throw new Error('The fixture failed before thread/start returned an ID'); })(),
      /before thread\/start/u);
  } finally {
    await failedLease.release();
  }
  assert.equal(await f.store.getProjectConversation(f.project.id), null);
  await assert.rejects(f.store.setProjectConversation(input, failedLease));
  const lease = await f.store.acquireProjectConversationLock(f.project.id);
  try {
    await assert.rejects(createProjectStore(f.mailbox).setProjectConversation(input, lease));
    const bound = await f.store.setProjectConversation(input, lease);
    assert.equal(bound.threadId, input.threadId);
  } finally {
    await lease.release();
  }
});

test('a project conversation lock excludes another process for the complete lease lifetime', async (t) => {
  const f = await fixture(t);
  const source = `import { createProjectStore } from ${JSON.stringify(pathToFileURL(join(here, 'project-links.mjs')).href)};\n`
    + 'const [mailbox,linkId]=process.argv.slice(1);\n'
    + 'const lease=await createProjectStore(mailbox).acquireProjectConversationLock(linkId);\n'
    + 'process.stdout.write("LOCK_HELD\\n");\n'
    + 'await new Promise(resolve=>process.stdin.once("data",resolve));\n'
    + 'await lease.release();process.stdin.destroy();\n';
  const holder = spawn(process.execPath, ['--input-type=module', '-e', source, f.mailbox, f.project.id], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const closed = new Promise((accept) => holder.once('close', accept));
  f.cleanups.push(async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await closed;
  });
  let output = '';
  let stderr = '';
  holder.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  await new Promise((accept, reject) => {
    holder.once('error', reject);
    holder.once('close', (code) => reject(new Error(`Lock holder exited before readiness (${code}): ${stderr}`)));
    holder.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCK_HELD')) accept();
    });
  });
  const lockPath = join(f.mailbox, 'project-conversations', `${f.project.id}.lock`);
  const heldLock = await readFile(lockPath);
  assert.equal(JSON.parse(heldLock).pid, holder.pid);
  for (const store of [f.store, createProjectStore(f.mailbox)]) {
    await assert.rejects(store.acquireProjectConversationLock(f.project.id), /busy|locked|already|running|held/iu);
    await assert.rejects(store.bindProjectConversation({ linkId: f.project.id, threadId: 'must-not-replace-active-owner' }),
      /busy|locked|already|running|held/iu);
    assert.deepEqual(await readFile(lockPath), heldLock);
  }
  assert.equal(await f.store.getProjectConversation(f.project.id), null);
  const otherProject = await f.store.linkProjects({
    name: 'independent-lock-fixture', codexWorkspace: f.codexWorkspace, dshWorkspace: f.dshWorkspace,
  });
  const independentLease = await f.store.acquireProjectConversationLock(otherProject.id);
  await independentLease.release();
  assert.deepEqual(await readFile(lockPath), heldLock);
  assert.equal(process.kill(holder.pid, 0), true);
  holder.stdin.end('release\n');
  assert.equal(await closed, 0, stderr);
  const next = await f.store.acquireProjectConversationLock(f.project.id);
  await next.release();
});

test('stale release handles and replaced lock tokens cannot clear another owner or overwrite a binding', async (t) => {
  const f = await fixture(t);
  const first = await f.store.acquireProjectConversationLock(f.project.id);
  await first.release();
  const second = await f.store.acquireProjectConversationLock(f.project.id);
  await first.release();
  await assert.rejects(f.store.acquireProjectConversationLock(f.project.id), /busy|locked|already|running|held/iu);
  const lockPath = join(f.mailbox, 'project-conversations', `${f.project.id}.lock`);
  const original = JSON.parse(await readFile(lockPath, 'utf8'));
  const foreignLock = `${JSON.stringify({ ...original, token: 'foreign-owner-token-must-be-preserved' })}\n`;
  await writeFile(lockPath, foreignLock);
  await assert.rejects(f.store.setProjectConversation({ linkId: f.project.id, threadId: 'must-not-be-bound' }, second));
  await assert.rejects(second.release(), /ownership|foreign|changed/iu);
  assert.equal(await readFile(lockPath, 'utf8'), foreignLock);
  assert.equal(await f.store.getProjectConversation(f.project.id), null);
  await assert.rejects(createProjectStore(f.mailbox).acquireProjectConversationLock(f.project.id),
    /busy|locked|already|running|held/iu);
});

test('corrupt or incompatible conversation bindings fail clearly and are never treated as an unbound project', async (t) => {
  const f = await fixture(t);
  const directory = join(f.mailbox, 'project-conversations');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${f.project.id}.json`);
  for (const invalid of ['{truncated binding', JSON.stringify({ linkId: f.project.id, threadId: 42, updatedAt: 'invalid' })]) {
    await writeFile(path, invalid);
    await assert.rejects(f.store.getProjectConversation(f.project.id));
    await assert.rejects(f.store.bindProjectConversation({ linkId: f.project.id, threadId: 'must-not-hide-the-error' }));
    assert.equal(await readFile(path, 'utf8'), invalid);
    await assert.rejects(readFile(join(directory, `${f.project.id}.lock`)), { code: 'ENOENT' });
  }
});

function parseResult(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('project registration and workspace filtering work through the public CLI using an isolated mailbox', async (t) => {
  const f = await fixture(t);
  const cli = async (args) => JSON.parse((await run(process.execPath, [join(here, 'server.mjs'), ...args], {
    env: { ...process.env, DSH_CODEX_MAILBOX_DIR: f.mailbox }, windowsHide: true, timeout: 10000,
  })).stdout);
  const project = await cli([
    'link-projects', '--name', 'fixture-cli-pair', '--codex-workspace', f.codexWorkspace, '--dsh-workspace', f.dshWorkspace,
  ]);
  assert.equal(project.id, 'fixture-cli-pair');
  assert.equal(project.codexWorkspace, await realpath(f.codexWorkspace));
  assert.equal(project.dshWorkspace, await realpath(f.dshWorkspace));
  const registered = await cli(['project-links']);
  assert.deepEqual(new Set(registered.map(({ id }) => id)), new Set([project.id, f.project.id]));
  const nested = join(f.dshWorkspace, 'nested CLI directory');
  await mkdir(nested);
  assert.deepEqual(new Set((await cli(['project-links', '--workspace', nested])).map(({ id }) => id)),
    new Set([project.id, f.project.id]));
  assert.deepEqual(await cli(['project-links', '--workspace', f.otherWorkspace]), []);
  const binding = await cli([
    'bind-project-conversation', '--link-id', project.id, '--thread-id', 'fixture-selected-project-thread',
    '--reason', 'Use one explicit existing collaboration conversation',
  ]);
  assert.equal(binding.linkId, project.id);
  assert.equal(binding.threadId, 'fixture-selected-project-thread');
  assert.deepEqual(await createProjectStore(f.mailbox).getProjectConversation(project.id), binding);
});

test('MCP roles share attributed context and route linked tasks to the opposite project without scanning history', async (t) => {
  const f = await fixture(t);
  const fakeDsh = join(f.root, 'fake dsh.mjs');
  const fakeCodex = join(f.root, 'fake codex.mjs');
  const invocations = join(f.root, 'agent invocations.jsonl');
  await writeFile(fakeDsh, `import { appendFileSync } from 'node:fs';\n`
    + `const argv=process.argv.slice(2);\n`
    + `appendFileSync(process.env.PROJECT_LINK_TEST_INVOCATIONS, JSON.stringify({agent:'dsh',cwd:process.cwd(),args:argv})+'\\n');\n`
    + `if(argv.includes('--json')){\n`
    + `  const i=argv.indexOf('--session-id');const sessionId=i>=0?argv[i+1]:'session-project-link-fixture';\n`
    + `  process.stdout.write(JSON.stringify({type:'session',sessionId,cwd:process.cwd()})+'\\n');\n`
    + `  process.stdout.write(JSON.stringify({type:'final',text:'FAKE_DSH_PROJECT_REPLY'})+'\\n');\n`
    + `}else{process.stdout.write('FAKE_DSH_PROJECT_REPLY');}\n`);
  await writeFile(fakeCodex, `import { appendFileSync } from 'node:fs';\n`
    + `import { createInterface } from 'node:readline';\n`
    + `const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');\n`
    + `for await(const line of createInterface({input:process.stdin})){\n`
    + `const r=JSON.parse(line);appendFileSync(process.env.PROJECT_LINK_TEST_INVOCATIONS,JSON.stringify({agent:'codex',cwd:process.cwd(),...r})+'\\n');\n`
    + `const reply=result=>send({id:r.id,result});\n`
    + `if(r.method==='initialize')reply({userAgent:'project-link-fixture'});\n`
    + `if(r.method==='thread/start')reply({thread:{id:'project-link-codex-thread'}});\n`
    + `if(r.method==='thread/resume')reply({thread:{id:r.params.threadId}});\n`
    + `if(r.method==='thread/name/set')reply({});\n`
    + `if(r.method==='turn/start'){reply({turn:{id:'fixture-turn',status:'inProgress',items:[]}});send({method:'item/agentMessage/delta',params:{delta:'COMMENTARY_MUST_NOT_BE_FINAL'}});send({method:'turn/completed',params:{threadId:r.params.threadId,turn:{id:'fixture-turn',status:'completed',items:[{id:'final-project',type:'agentMessage',phase:'final_answer',text:'FAKE_CODEX_PROJECT_REPLY'}]}}});}\n`
    + `}\n`);
  const clients = [];
  f.cleanups.push(async () => { await Promise.all(clients.map((client) => client.close())); });
  async function connect(role) {
    const client = new Client({ name: 'project-link-fixture', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [join(here, 'server.mjs')], cwd: f.otherWorkspace,
      env: {
        ...process.env, DSH_BRIDGE_ROLE: role, DSH_CODEX_MAILBOX_DIR: f.mailbox,
        DSH_BIN: fakeDsh, CODEX_BIN: fakeCodex, DSH_BRIDGE_PATCH: '',
        DSH_PROFILE: '', DSH_SESSION_ID: '',
        DSH_BRIDGE_TIMEOUT_MS: '5000', DSH_CODEX_CHAT_TIMEOUT_MS: '5000',
        PROJECT_LINK_TEST_INVOCATIONS: invocations,
      }, stderr: 'pipe',
    }));
    clients.push(client);
    return client;
  }
  const codex = await connect('codex');
  const dsh = await connect('dsh');
  const call = (client, name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
  const listed = parseResult(await call(codex, 'list_project_links', {}));
  assert.ok(JSON.stringify(listed).includes(f.project.id));
  const nestedCodex = join(f.codexWorkspace, 'nested directory');
  const nestedDsh = join(f.dshWorkspace, 'nested directory');
  await Promise.all([mkdir(nestedCodex), mkdir(nestedDsh)]);
  for (const workspace of [f.codexWorkspace, f.dshWorkspace, nestedCodex, nestedDsh]) {
    const matching = parseResult(await call(codex, 'list_project_links', { workspace }));
    assert.deepEqual(matching.map(({ id }) => id), [f.project.id]);
  }
  assert.deepEqual(parseResult(await call(dsh, 'list_project_links', { workspace: f.otherWorkspace })), []);
  const similarSibling = `${f.codexWorkspace}-sibling`;
  await mkdir(similarSibling);
  assert.deepEqual(parseResult(await call(dsh, 'list_project_links', { workspace: similarSibling })), []);
  const codexShared = parseResult(await call(codex, 'share_project_context', {
    linkId: f.project.id, summary: 'CODEX_APPROVED_PROJECT_FACT', topic: 'Fixture', sourceRole: 'dsh',
  }));
  assert.equal(codexShared.sourceRole, 'codex');
  const dshShared = parseResult(await call(dsh, 'share_project_context', {
    linkId: f.project.id, summary: 'DSH_APPROVED_PROJECT_FACT', sourceRole: 'codex',
  }));
  assert.equal(dshShared.sourceRole, 'dsh');
  const read = parseResult(await call(dsh, 'read_project_context', { linkId: f.project.id }));
  assert.deepEqual(new Set(read.entries.map(({ summary }) => summary)), new Set([
    'CODEX_APPROVED_PROJECT_FACT', 'DSH_APPROVED_PROJECT_FACT',
  ]));
  const delegated = await call(codex, 'delegate_to_deepseek', {
    projectLinkId: f.project.id, task: 'Inspect the linked DSH fixture project', taskId: 'fixture-linked-delegation',
    dshSessionId: 'session-project-link-fixture',
  });
  assert.equal(delegated.isError, undefined, delegated.content?.[0]?.text);
  const asked = parseResult(await call(dsh, 'ask_codex', {
    projectLinkId: f.project.id, message: 'Review the linked Codex fixture project', progress: 'The DSH fixture inspection is complete',
  }));
  assert.equal(asked.reply.body, 'FAKE_CODEX_PROJECT_REPLY');
  const delegatedStatus = parseResult(await call(codex, 'get_bridge_task_status', { taskId: 'fixture-linked-delegation' }));
  const reverseStatus = parseResult(await call(dsh, 'get_bridge_task_status', { taskId: asked.taskId }));
  assert.equal(delegatedStatus.projectLinkId, f.project.id);
  assert.equal(reverseStatus.projectLinkId, f.project.id);
  const readInvocations = async () => (await readFile(invocations, 'utf8')).trim().split('\n').map(JSON.parse);
  const captured = await readInvocations();
  const dshRun = captured.find(({ agent }) => agent === 'dsh');
  assert.equal(dshRun.cwd, await realpath(f.dshWorkspace));
  assert.match(dshRun.args.join('\n'), /CODEX_APPROVED_PROJECT_FACT/u);
  const replyCommand = dshRun.args.join('\n').split('\n').find((line) => /\schat\s/u.test(line) && /--workspace/u.test(line));
  assert.ok(replyCommand, 'The DSH assignment must include a ready-to-use Codex reply command');
  assert.match(replyCommand, /Codex 中文 project/u);
  assert.doesNotMatch(replyCommand, /DSH 中文 workspace/u);
  const codexStart = captured.find(({ agent, method }) => agent === 'codex' && method === 'thread/start');
  assert.equal(codexStart.params.cwd, await realpath(f.codexWorkspace));
  const codexTurn = captured.find(({ agent, method }) => agent === 'codex' && method === 'turn/start');
  assert.match(JSON.stringify(codexTurn.params.input), /DSH_APPROVED_PROJECT_FACT/u);
  const otherLink = await f.store.linkProjects({
    name: 'other-fixture-pair', codexWorkspace: f.codexWorkspace, dshWorkspace: f.dshWorkspace,
  });
  const rebind = await call(dsh, 'ask_codex', {
    taskId: asked.taskId, projectLinkId: otherLink.id, message: 'Must not switch the linked project context',
    progress: 'Isolated project-binding rejection test',
  });
  assert.equal(rebind.isError, true);
  assert.match(rebind.content[0].text, /project|link|bound/iu);
  for (const [client, name, input] of [
    [codex, 'delegate_to_deepseek', { task: 'Must reject mismatched project root' }],
    [dsh, 'ask_codex', { message: 'Must reject mismatched project root', progress: 'Isolated rejection test' }],
  ]) {
    const rejected = await call(client, name, { ...input, projectLinkId: f.project.id, workspace: f.otherWorkspace });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /workspace|project|linked/iu);
  }
  assert.equal((await readInvocations()).length, captured.length);
});
