import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectStore } from './project-links.mjs';

test('Codex thread and DSH native session bindings persist independently and coexist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-dsh-binding-'));
  const mailbox = join(root, 'mailbox');
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createProjectStore(mailbox);
  const project = await store.linkProjects({ name: 'dsh-binding-fixture',
    codexWorkspace: root, dshWorkspace: root });
  assert.equal(await store.getProjectDshSession(project.id), null);
  const dsh = await store.bindProjectDshSession({ linkId: project.id,
    dshSessionId: 'session-headless-fixture', reason: 'Initial explicit binding' });
  assert.equal(dsh.dshSessionId, 'session-headless-fixture');
  assert.equal(await store.getProjectConversation(project.id), null, 'binding DSH must not invent a Codex thread');
  const thread = await store.bindProjectConversation({ linkId: project.id,
    threadId: 'thread-codex-fixture', reason: 'Initial Codex binding' });
  assert.equal(thread.threadId, 'thread-codex-fixture');
  assert.equal((await store.getProjectDshSession(project.id)).dshSessionId, 'session-headless-fixture');
  const replacement = await store.bindProjectConversation({ linkId: project.id,
    threadId: 'thread-codex-new', reason: 'Deliberate replacement' });
  assert.equal(replacement.threadId, 'thread-codex-new');
  assert.equal((await store.getProjectDshSession(project.id)).dshSessionId, 'session-headless-fixture');
  assert.equal((await createProjectStore(mailbox).getProjectDshSession(project.id)).dshSessionId,
    'session-headless-fixture', 'a second store/process sees the same DSH binding');

  const dshLock = await store.acquireProjectDshLock(project.id);
  await assert.rejects(store.acquireProjectDshLock(project.id), /busy|lock/iu);
  const conversationLock = await store.acquireProjectConversationLock(project.id);
  await conversationLock.release();
  await dshLock.release();
});
