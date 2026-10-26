import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectContextDelivery } from './project-context-delivery.mjs';

const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const entry = (value, extra = {}) => ({
  id: id(value), linkId: 'fixture-project', summary: `summary-${value}`,
  topic: `topic-${value}`, sourceRole: 'dsh',
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, value)).toISOString(), ...extra,
});

test('context is initialized once, then only new complete records are delivered', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-context-test-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivery = createProjectContextDelivery({ mailboxDir: join(root, 'mailbox') });
  const entries = Array.from({ length: 10 }, (_, index) => entry(index));
  const first = await delivery.build({ linkId: 'fixture-project', direction: 'codex',
    sessionId: 'session-a', entries, workspace });
  assert.equal(first.entryHashes.length, 8, 'the first delivery is a bounded latest-entry summary');
  assert.equal(first.indexed.length, 2, 'older history is explicitly indexed, not marked delivered');
  assert.ok(first.indexPath && first.block.includes(first.indexPath));
  const indexRecord = JSON.parse(await readFile(first.indexPath, 'utf8'));
  assert.deepEqual(indexRecord.entries.map(({ id: value }) => value), [id(0), id(1)]);
  assert.equal(first.initial, true);
  await delivery.commit({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-a',
    entryHashes: first.entryHashes, indexed: first.indexed });
  const second = await delivery.build({ linkId: 'fixture-project', direction: 'codex',
    sessionId: 'session-a', entries, workspace });
  assert.equal(second.block, '');
  assert.equal(second.entryHashes.length, 0);

  entries.push(entry(10));
  entries.push(entry(11));
  const third = await delivery.build({ linkId: 'fixture-project', direction: 'codex',
    sessionId: 'session-a', entries, workspace });
  assert.equal(third.entryHashes.length, 2);
  assert.ok(third.block.includes('summary-10'));
  assert.ok(third.block.includes('summary-11'));
  assert.equal(third.indexed.length, 0);
});

test('budget-skipped initial records remain pending and are delivered on later requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-context-budget-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivery = createProjectContextDelivery({ mailboxDir: join(root, 'mailbox') });
  const entries = Array.from({ length: 8 }, (_, index) => entry(index, { summary: `${index}:` + 'X'.repeat(2_000) }));
  const first = await delivery.build({ linkId: 'fixture-project', direction: 'codex',
    sessionId: 'session-budget', entries, workspace });
  assert.ok(first.entryHashes.length > 0 && first.entryHashes.length < 8,
    'the byte budget must not fit all eight large records');
  assert.ok(first.pending > 0, 'budget-skipped records must remain pending');
  assert.equal(first.indexed.length, 0, 'no explicit older-history cutoff exists here');
  const deliveredIds = new Set(first.entryHashes.map(({ id: value }) => value));
  await delivery.commit({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-budget',
    entryHashes: first.entryHashes, indexed: first.indexed });

  for (let round = 0; round < 8 && deliveredIds.size < entries.length; round += 1) {
    const next = await delivery.build({ linkId: 'fixture-project', direction: 'codex',
      sessionId: 'session-budget', entries, workspace });
    assert.ok(next.entryHashes.length > 0, `round ${round + 1} must deliver pending records`);
    for (const item of next.entryHashes) {
      assert.ok(!deliveredIds.has(item.id), 'a pending record must not be marked delivered twice');
      deliveredIds.add(item.id);
    }
    await delivery.commit({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-budget',
      entryHashes: next.entryHashes, indexed: next.indexed });
  }
  assert.equal(deliveredIds.size, entries.length, 'all records must eventually be delivered, none silently dropped');
});

test('a long record is referenced through a complete workspace snapshot, never truncated JSON', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-context-long-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivery = createProjectContextDelivery({ mailboxDir: join(root, 'mailbox') });
  const long = entry(1, { summary: 'X'.repeat(5_000) });
  const built = await delivery.build({ linkId: 'fixture-project', direction: 'dsh',
    sessionId: 'session-c', entries: [long], workspace });
  assert.equal(built.entryHashes.length, 1);
  assert.match(built.block, /"snapshot":/);
  assert.doesNotMatch(built.block, /"summary":"X{100}/);
  const snapshot = JSON.parse(await readFile(join(workspace, '.dsh-codex-bridge', 'context-snapshots', `${long.id}.json`), 'utf8'));
  assert.deepEqual(snapshot, long);
});

test('delivery state is isolated by direction and native session and pending IDs cannot commit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-context-isolation-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const delivery = createProjectContextDelivery({ mailboxDir: join(root, 'mailbox') });
  const entries = [entry(1)];
  const codexA = await delivery.build({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-a', entries, workspace });
  await delivery.commit({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-a',
    entryHashes: codexA.entryHashes, indexed: codexA.indexed });
  const codexB = await delivery.build({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-b', entries, workspace });
  assert.equal(codexB.entryHashes.length, 1, 'a different native session gets its own initial summary');
  const dshA = await delivery.build({ linkId: 'fixture-project', direction: 'dsh', sessionId: 'session-a', entries, workspace });
  assert.equal(dshA.entryHashes.length, 1, 'the other direction has an independent cursor');
  await assert.rejects(delivery.commit({ linkId: 'fixture-project', direction: 'codex',
    sessionId: 'pending-task', entryHashes: codexA.entryHashes }), /native session ID/);
  await assert.rejects(delivery.build({ linkId: 'fixture-project', direction: 'codex', sessionId: 'session-evil',
    entries: [{ ...entry(2), id: '../../escape' }], workspace }), /UUID/);
});
