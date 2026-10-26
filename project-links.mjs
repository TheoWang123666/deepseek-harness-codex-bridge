import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const ownedConversationLocks = new Map();

process.once('exit', () => {
  for (const [path, token] of ownedConversationLocks) {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
    } catch {}
  }
});

function text(value, name, maximum, optional = false) {
  if (optional && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || value.includes('\0')) {
    throw new Error(`${name} must be a nonempty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function safeId(value) {
  if (typeof value !== 'string' || !/^[\w.:-]{1,128}$/u.test(value)) throw new Error('Invalid project link ID');
  return value;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function slugId(value) {
  return /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9_-])?$/u.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/u.test(value);
}

async function canonicalDirectory(path) {
  const requested = text(path, 'Workspace path', 32767);
  const canonical = await realpath(resolve(requested));
  if (!(await stat(canonical)).isDirectory()) throw new Error(`Workspace is not a directory: ${canonical}`);
  return canonical;
}

// Publish a complete new file without replacing any existing file. Temporary
// files are private to this call; existing links and context are never deleted.
async function publishExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
    await link(temporary, path);
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

async function files(path) {
  try { return (await readdir(path)).filter((file) => file.endsWith('.json')).sort(); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Replace a mutable singleton record without exposing a half-written file.
async function replaceFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

function validLink(value) {
  return value && typeof value.id === 'string' && slugId(value.id)
    && typeof value.name === 'string' && typeof value.codexWorkspace === 'string'
    && typeof value.dshWorkspace === 'string' && typeof value.createdAt === 'string';
}

function validEntry(value, linkId) {
  return value && value.linkId === linkId && typeof value.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)
    && typeof value.summary === 'string' && value.summary.length <= 8000
    && ['codex', 'dsh'].includes(value.sourceRole) && typeof value.createdAt === 'string';
}

export function createProjectStore(mailboxDir) {
  const linksDir = join(resolve(mailboxDir), 'project-links');
  const contextDir = join(resolve(mailboxDir), 'project-context');
  const conversationDir = join(resolve(mailboxDir), 'project-conversations');
  const leases = new WeakMap();
  const linkPath = (id) => join(linksDir, `${encodeURIComponent(safeId(id))}.json`);

  async function getProjectLink(linkId) {
    let result;
    try { result = JSON.parse(await readFile(linkPath(linkId), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Unknown project link: ${linkId}`);
      throw error;
    }
    if (!validLink(result) || result.id !== linkId) throw new Error(`Unsupported project link record: ${linkId}`);
    return result;
  }

  async function listProjectLinks() {
    const result = [];
    for (const file of await files(linksDir)) {
      try {
        const value = JSON.parse(await readFile(join(linksDir, file), 'utf8'));
        if (validLink(value) && file === `${value.id}.json`) result.push(value);
      } catch (error) {
        // Unrecognized or incomplete foreign files remain untouched.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async function linkProjects({ name, codexWorkspace, dshWorkspace }) {
    name = text(name, 'Project link name', 120).normalize('NFC');
    const [codex, dsh] = await Promise.all([canonicalDirectory(codexWorkspace), canonicalDirectory(dshWorkspace)]);
    const normalizedName = name.toLowerCase();
    const id = slugId(normalizedName) ? normalizedName
      : `project-${createHash('sha256').update(normalizedName).digest('hex').slice(0, 24)}`;
    const record = { id, name, codexWorkspace: codex, dshWorkspace: dsh, createdAt: new Date().toISOString() };
    try {
      await publishExclusive(linkPath(id), record);
      return record;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await getProjectLink(id);
      if (existing.name.toLowerCase() !== name.toLowerCase()
          || !samePath(existing.codexWorkspace, codex) || !samePath(existing.dshWorkspace, dsh)) {
        throw new Error(`Project link '${name}' already exists with different workspaces; existing data was preserved`);
      }
      return existing;
    }
  }

  async function readAllProjectContext({ linkId }) {
    const project = await getProjectLink(linkId);
    const directory = join(contextDir, project.id);
    const entries = [];
    for (const file of await files(directory)) {
      try {
        const value = JSON.parse(await readFile(join(directory, file), 'utf8'));
        if (validEntry(value, project.id)) entries.push(value);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return { link: project, entries };
  }

  async function readProjectContext({ linkId, limit = 20 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Context limit must be between 1 and 100');
    const { link, entries } = await readAllProjectContext({ linkId });
    return { link, entries: entries.slice(-limit) };
  }

  async function shareProjectContext({ linkId, summary, topic, conversationId, sourceRole }) {
    const project = await getProjectLink(linkId);
    if (!['codex', 'dsh'].includes(sourceRole)) throw new Error('sourceRole must be codex or dsh');
    const id = randomUUID();
    const record = {
      id,
      linkId: project.id,
      summary: text(summary, 'Shared summary', 8000),
      topic: text(topic, 'Topic', 160, true),
      conversationId: text(conversationId, 'Reported conversation ID', 256, true),
      sourceRole,
      createdAt: new Date().toISOString(),
    };
    const filename = `${String(Date.now()).padStart(13, '0')}-${id}.json`;
    await publishExclusive(join(contextDir, project.id, filename), record);
    return record;
  }

  async function getProjectConversation(linkId) {
    const project = await getProjectLink(linkId);
    const path = join(conversationDir, `${project.id}.json`);
    let value;
    try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Cannot read project conversation state for '${project.id}'; refusing to create another conversation: ${error.message}`);
    }
    if (value?.version !== 1 || value.linkId !== project.id || typeof value.threadId !== 'string'
        || !/^[\w.:-]{1,128}$/u.test(value.threadId) || typeof value.updatedAt !== 'string') {
      throw new Error(`Unsupported project conversation state for '${project.id}'; existing state was preserved`);
    }
    return value;
  }

  // DSH native Session identity is a sibling singleton so a Codex thread and a
  // DSH session can be established independently without inventing either one.
  async function getProjectDshSession(linkId) {
    const project = await getProjectLink(linkId);
    const path = join(conversationDir, `${project.id}.dsh.json`);
    let value;
    try { value = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`Cannot read project DSH conversation state for '${project.id}'; refusing to create another session: ${error.message}`);
    }
    if (value?.version !== 1 || value.linkId !== project.id || typeof value.dshSessionId !== 'string'
        || !/^[\w.:-]{1,128}$/u.test(value.dshSessionId) || typeof value.updatedAt !== 'string') {
      throw new Error(`Unsupported project DSH conversation state for '${project.id}'; existing state was preserved`);
    }
    return value;
  }

  async function setProjectDshSession({ linkId, dshSessionId, reason }, lease) {
    const metadata = leases.get(lease);
    if (!metadata || metadata.released || metadata.linkId !== linkId) throw new Error('An active owned project direction lock is required');
    const owner = JSON.parse(await readFile(metadata.path, 'utf8'));
    if (owner.token !== metadata.token) throw new Error('Project direction lock ownership changed; state was preserved');
    dshSessionId = safeId(dshSessionId);
    const value = { version: 1, linkId, dshSessionId,
      reason: text(reason, 'DSH session selection reason', 1000, true), updatedAt: new Date().toISOString() };
    await replaceFile(join(conversationDir, `${linkId}.dsh.json`), value);
    return value;
  }

  async function bindProjectDshSession({ linkId, dshSessionId, reason }) {
    const lease = await acquireProjectDshLock(linkId);
    try { return await setProjectDshSession({ linkId, dshSessionId, reason }, lease); } finally { await lease.release(); }
  }

  async function acquireProjectLock(linkId, suffix, label) {
    const project = await getProjectLink(linkId);
    await mkdir(conversationDir, { recursive: true, mode: 0o700 });
    const path = join(conversationDir, `${project.id}${suffix}.lock`);
    const token = randomUUID();
    let handle;
    try { handle = await open(path, 'wx', 0o600); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Project ${label} is busy for '${project.id}'. Another call or an unreleased lock owns it; no new ${label} was created. Wait for that call to finish. Existing locks are never forcibly removed.`);
      throw error;
    }
    ownedConversationLocks.set(path, token);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, linkId: project.id, kind: label, pid: process.pid, token, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    } catch (error) {
      await handle.close();
      await unlink(path).catch(() => {});
      ownedConversationLocks.delete(path);
      throw error;
    }
    await handle.close();
    const metadata = { path, token, linkId: project.id, label, released: false };
    const lease = {
      linkId: project.id,
      release: async () => {
        if (metadata.released) return;
        let owner;
        try { owner = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (owner && owner.token !== token) throw new Error(`Project ${label} lock ownership changed; the foreign lock was preserved`);
        if (owner) await unlink(path);
        metadata.released = true;
        ownedConversationLocks.delete(path);
      },
    };
    leases.set(lease, metadata);
    return lease;
  }

  async function acquireProjectConversationLock(linkId) {
    return acquireProjectLock(linkId, '', 'conversation');
  }

  async function acquireProjectDshLock(linkId) {
    return acquireProjectLock(linkId, '.dsh', 'DSH');
  }

  async function setProjectConversation({ linkId, threadId, reason }, lease) {
    const metadata = leases.get(lease);
    if (!metadata || metadata.released || metadata.linkId !== linkId) throw new Error('An active owned project conversation lock is required');
    const owner = JSON.parse(await readFile(metadata.path, 'utf8'));
    if (owner.token !== metadata.token) throw new Error('Project conversation lock ownership changed; state was preserved');
    threadId = safeId(threadId);
    const previous = await getProjectConversation(linkId);
    const value = { version: 1, linkId, threadId, reason: text(reason, 'Conversation selection reason', 1000, true), updatedAt: new Date().toISOString() };
    const path = join(conversationDir, `${linkId}.json`);
    if (!previous) {
      await publishExclusive(path, value);
    } else {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      let created = false;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        created = true;
        try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); } finally { await handle.close(); }
        await rename(temporary, path);
      } finally {
        if (created) await unlink(temporary).catch(() => {});
      }
    }
    return value;
  }

  async function bindProjectConversation({ linkId, threadId, reason }) {
    const lease = await acquireProjectConversationLock(linkId);
    try { return await setProjectConversation({ linkId, threadId, reason }, lease); } finally { await lease.release(); }
  }

  return { linkProjects, listProjectLinks, getProjectLink, readProjectContext, readAllProjectContext, shareProjectContext,
    getProjectConversation, getProjectDshSession, acquireProjectConversationLock, acquireProjectDshLock,
    setProjectConversation, setProjectDshSession, bindProjectConversation, bindProjectDshSession };
}
