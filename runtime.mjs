import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';

const ownedChildren = new Map();
const childStates = new WeakMap();
let shuttingDown = false;

function envValue(env, name, platform) {
  const keys = Object.keys(env).filter((key) => platform === 'win32'
    ? key.toLowerCase() === name.toLowerCase() : key === name);
  // Prefer the canonical uppercase spelling if the caller supplied duplicates.
  const key = keys.find((candidate) => candidate === name) || keys[0];
  return key === undefined ? undefined : env[key];
}

export function normalizeEnvironment(env = process.env, platform = process.platform) {
  const result = {};
  const seen = new Set();
  for (const key of Object.keys(env).sort()) {
    const identity = platform === 'win32' ? key.toLowerCase() : key;
    if (seen.has(identity) || env[key] === undefined) continue;
    seen.add(identity);
    result[key] = envValue(env, key, platform);
  }
  if (platform === 'win32') {
    for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key];
    const pathValue = envValue(env, 'PATH', platform);
    if (pathValue !== undefined) result.PATH = pathValue;
  }
  return result;
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function commandError(command, detail) {
  return new Error(`${detail}: ${command}. Set DSH_BIN or CODEX_BIN to a real executable or Node .js/.mjs/.cjs entry file; shell command strings are not supported.`);
}

const desktopWrapperLines = [
  '@echo off',
  'setlocal DisableDelayedExpansion',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
  'exit /b %errorlevel%',
];

function normalizedWrapper(source) {
  return source.replace(/^\uFEFF/u, '').split(/\r?\n/u)
    .map((line) => line.trim()).filter(Boolean).join('\n').toLowerCase();
}

async function dshDesktopCommand(directory) {
  const root = resolve(directory);
  const file = join(root, 'DeepSeek Harness.exe');
  const archive = join(root, 'resources', 'app.asar');
  const wrapper = join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  if (!(await isFile(file)) || !(await isFile(archive)) || !(await isFile(wrapper))) return null;
  // Recognize the official fixed Electron CLI launcher, rather than executing
  // or interpreting an arbitrary batch file. The CLI path is virtual in ASAR.
  if (normalizedWrapper(await readFile(wrapper, 'utf8')) !== normalizedWrapper(desktopWrapperLines.join('\n'))) return null;
  return {
    file,
    argsPrefix: ['--expose-internals', join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

async function discoverDshDesktop(env, cwd) {
  const configured = envValue(env, 'DSH_DESKTOP_DIR', 'win32');
  if (configured) {
    const root = resolve(cwd, configured.trim().replace(/^"(.*)"$/u, '$1'));
    const command = await dshDesktopCommand(root);
    if (!command) throw commandError(root, 'DSH_DESKTOP_DIR does not contain a supported official DSH desktop CLI layout');
    return command;
  }
  const local = envValue(env, 'LOCALAPPDATA', 'win32');
  return local ? dshDesktopCommand(resolve(cwd, local, 'Programs', 'DeepSeek Harness')) : null;
}

async function nodeShimTarget(path, platform) {
  const source = await readFile(path, 'utf8');
  const extension = extname(path).toLowerCase();
  let references = [];
  if (extension === '.cmd' || extension === '.bat') {
    if (!/(?:node(?:\.exe)?|_prog)/iu.test(source) || !/%\*/u.test(source)) return null;
    references = [...source.matchAll(/"((?:%dp0%|%~dp0)[\\/][^"\r\n]+\.(?:[cm]?js))"\s+%\*/giu)]
      .map((match) => match[1].replace(/^(?:%dp0%|%~dp0)[\\/]/iu, ''));
  } else if (extension === '.ps1') {
    if (!/\bnode(?:\$exe|\.exe)?\b/iu.test(source) || !/\$args\b/iu.test(source)) return null;
    references = [...source.matchAll(/"(\$basedir[\\/][^"\r\n]+\.(?:[cm]?js))"\s+\$args\b/giu)]
      .map((match) => match[1].replace(/^\$basedir[\\/]/iu, ''));
  }
  const targets = [...new Set(references.map((reference) => resolve(dirname(path),
    platform === 'win32' ? reference.replaceAll('/', '\\') : reference.replaceAll('\\', '/'))))];
  if (targets.length !== 1 || !(await isFile(targets[0]))) return null;
  return targets[0];
}

/** Resolve one executable or script path. No shell parsing or execution occurs. */
export async function resolveCommand(command, {
  env = process.env, platform = process.platform, cwd = process.cwd(),
} = {}) {
  if (typeof command !== 'string' || !command.trim() || /[\0\r\n]/u.test(command)) {
    throw commandError(String(command), 'Invalid command path');
  }
  let name = command.trim();
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) name = name.slice(1, -1);
  const windows = platform === 'win32';
  const pathLike = isAbsolute(name) || /[\\/]/u.test(name);
  const directories = pathLike ? [''] : String(envValue(env, 'PATH', platform) || '')
    .split(windows ? ';' : ':').filter(Boolean).map((directory) => directory.replace(/^"(.*)"$/u, '$1'));
  const extension = extname(name).toLowerCase();
  const suffixes = windows && !extension
    ? [...new Set(String(envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD')
      .split(';').filter(Boolean).map((suffix) => suffix.startsWith('.') ? suffix : `.${suffix}`)), '.ps1', '']
    : [''];
  let found;
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = resolve(cwd, directory, `${name}${suffix}`);
      if (!(await isFile(candidate))) continue;
      const candidateExtension = extname(candidate).toLowerCase();
      if (!windows && !/\.(?:[cm]?js)$/iu.test(candidateExtension)) {
        try { await access(candidate, constants.X_OK); } catch { continue; }
      }
      found = candidate;
      break;
    }
    if (found) break;
  }
  if (!found && windows && !pathLike && name.toLowerCase() === 'dsh') {
    const desktop = await discoverDshDesktop(env, cwd);
    if (desktop) return desktop;
  }
  if (!found) throw commandError(command, 'Command not found');
  const foundExtension = extname(found).toLowerCase();
  if (windows && basename(found).toLowerCase() === 'deepseek harness.exe') {
    const desktop = await dshDesktopCommand(dirname(found));
    if (!desktop) throw commandError(found, 'Unsupported DSH desktop CLI layout; refusing to launch its graphical application');
    return desktop;
  }
  if (windows && basename(found).toLowerCase() === 'dsh.cmd') {
    const root = resolve(dirname(found), '..', '..', '..', '..');
    const wrapper = join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (found.toLowerCase() === wrapper.toLowerCase()) {
      const desktop = await dshDesktopCommand(root);
      if (desktop) return desktop;
    }
  }
  if (/\.(?:[cm]?js)$/iu.test(foundExtension)) return { file: process.execPath, argsPrefix: [found] };
  if (windows && ['.cmd', '.bat', '.ps1'].includes(foundExtension)) {
    const target = await nodeShimTarget(found, platform);
    if (!target) throw commandError(command, 'Unsupported batch/PowerShell launcher (only standard npm Node shims can be resolved safely)');
    return { file: process.execPath, argsPrefix: [target] };
  }
  if (windows && !['.exe', '.com'].includes(foundExtension)) {
    throw commandError(command, 'Unsupported Windows executable type');
  }
  return { file: found, argsPrefix: [] };
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function windowsArgumentLength(value) {
  const text = String(value);
  if (text.length && !/[\s"]/u.test(text)) return text.length;
  let length = 2;
  let slashes = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') { slashes += 1; continue; }
    length += text[index] === '"' ? slashes * 2 + 2 : slashes + 1;
    slashes = 0;
  }
  return length + slashes * 2;
}

/** Spawn only an actual executable; prompts and arguments never cross cmd.exe. */
export async function spawnCommand(command, args, options = {}) {
  if (shuttingDown) throw new Error('Bridge runtime is shutting down');
  const { signal, ...spawnOptions } = options;
  if (signal?.aborted) throw abortError();
  const env = normalizeEnvironment(spawnOptions.env || process.env);
  const nodeDirectory = dirname(process.execPath);
  const pathParts = String(env.PATH || '').split(delimiter).filter(Boolean);
  if (!pathParts.some((part) => process.platform === 'win32'
    ? part.toLowerCase() === nodeDirectory.toLowerCase() : part === nodeDirectory)) pathParts.unshift(nodeDirectory);
  env.PATH = pathParts.join(delimiter);
  const resolved = await resolveCommand(command, { env, cwd: spawnOptions.cwd });
  const childEnv = normalizeEnvironment({ ...env, ...resolved.env });
  if (shuttingDown) throw new Error('Bridge runtime is shutting down');
  if (signal?.aborted) throw abortError();
  const childArgs = [...resolved.argsPrefix, ...args];
  if (process.platform === 'win32') {
    const length = windowsArgumentLength(resolved.file)
      + childArgs.reduce((count, argument) => count + 1 + windowsArgumentLength(argument), 0) + 1;
    if (length > 32767) throw new Error(`Windows command line exceeds 32767 UTF-16 characters after quoting (${length}). Put large task input in a workspace file and delegate its path instead.`);
  }
  const child = spawn(resolved.file, childArgs, {
    ...spawnOptions,
    env: childEnv,
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
    detached: process.platform !== 'win32',
  });
  const state = { pid: child.pid, closed: false, stopping: null };
  ownedChildren.set(child, state);
  childStates.set(child, state);
  // Keep an error listener installed between the spawn event and caller setup.
  child.on('error', () => {});
  const onAbort = () => {
    void stopProcessTree(child);
    child.emit('error', abortError());
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  child.once('close', () => {
    state.closed = true;
    ownedChildren.delete(child);
    signal?.removeEventListener('abort', onAbort);
  });
  await new Promise((accept, reject) => {
    const onError = (error) => { child.off('spawn', onSpawn); reject(error); };
    const onSpawn = () => { child.off('error', onError); state.pid = child.pid; accept(); };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
  return child;
}

function taskkillPath() {
  return join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
}

function liveState(child) {
  const state = childStates.get(child);
  return state && !state.closed && Number.isSafeInteger(state.pid) && state.pid > 0 ? state : null;
}

/** Only child objects created by spawnCommand are eligible for termination. */
export async function stopProcessTree(child) {
  const state = liveState(child);
  if (!state) return;
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((accept) => {
        const killer = spawn(taskkillPath(), ['/PID', String(state.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000,
        });
        killer.once('error', () => { child.kill('SIGKILL'); accept(); });
        killer.once('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); accept(); });
      });
    } else {
      try { process.kill(-state.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }
  })();
  return state.stopping;
}

export async function stopAllProcessTrees() {
  // Prevent an in-flight asynchronous command lookup from spawning after an
  // MCP disconnect or shutdown has already started.
  shuttingDown = true;
  await Promise.all([...ownedChildren.keys()].map((child) => stopProcessTree(child)));
}

// The exit event cannot await asynchronous work. Use the same exact owned PIDs.
process.once('exit', () => {
  for (const [child] of ownedChildren) {
    const state = liveState(child);
    if (!state) continue;
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      spawnSync(taskkillPath(), ['/PID', String(state.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000,
      });
    } else {
      try { process.kill(-state.pid, 'SIGKILL'); } catch {}
    }
  }
});
