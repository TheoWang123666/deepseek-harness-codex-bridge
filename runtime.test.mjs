import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCommand, spawnCommand, stopProcessTree } from './runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '中文 command with spaces');
  await mkdir(directory);
  const script = join(directory, 'argv fixture.mjs');
  await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  return { root, directory, script };
}

async function capture(command, args, options = {}) {
  const child = await spawnCommand(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((accept, reject) => {
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? accept(stdout) : reject(new Error(`Exit ${code}: ${stderr}`)));
  });
}

async function desktopFixture(t, { omit, unknownWrapper = false, nodeExecutable = false } = {}) {
  const { root, directory } = await fixture(t);
  const localAppData = join(directory, 'Local AppData');
  const installDirectory = join(localAppData, 'Programs', 'DeepSeek Harness');
  const bin = join(installDirectory, 'resources', 'runtime', 'cli', 'bin');
  const executable = join(installDirectory, 'DeepSeek Harness.exe');
  const archive = join(installDirectory, 'resources', 'app.asar');
  const wrapper = join(bin, 'dsh.cmd');
  const cli = join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  await mkdir(bin, { recursive: true });
  if (omit !== 'executable') {
    if (nodeExecutable) {
      // This is the current trusted Node executable, renamed inside a test-only layout.
      // The preload below exits before the dummy ASAR entry can run; no GUI is involved.
      try { await link(process.execPath, executable); }
      catch { await copyFile(process.execPath, executable); }
    } else await writeFile(executable, 'test placeholder, never executed');
  }
  if (omit !== 'archive') await writeFile(archive, 'test placeholder, never opened as an archive');
  if (omit !== 'wrapper') await writeFile(wrapper, [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'set "ELECTRON_RUN_AS_NODE=1"',
    '"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*',
    'exit /b %errorlevel%',
    ...(unknownWrapper ? ['echo UNEXPECTED WRAPPER CONTENT'] : []),
  ].join('\r\n'));
  const emptyPath = join(root, 'empty PATH');
  await mkdir(emptyPath);
  const env = {
    ...process.env, PATH: emptyPath, Path: emptyPath,
    PATHEXT: '.COM;.EXE;.BAT;.CMD', LOCALAPPDATA: localAppData,
    DSH_DESKTOP_DIR: installDirectory,
  };
  const expected = { file: executable, argsPrefix: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { root, directory, localAppData, installDirectory, executable, archive, wrapper, cli, env, expected };
}

test('native executable and Node entry preserve Unicode, spaces, metacharacters, and long arguments', async (t) => {
  const { script, directory } = await fixture(t);
  const marker = join(directory, 'must not exist.txt');
  const args = [`中文 'single' "double"\n&|<>^%PATH% & echo INJECTION > "${marker}"`, 'large-'.repeat(1900)];
  assert.ok(args[1].length > 8191);
  const resolved = await resolveCommand(script);
  assert.equal(resolved.file, process.execPath);
  assert.deepEqual(resolved.argsPrefix, [script]);
  assert.deepEqual(JSON.parse(await capture(script, args, { cwd: directory })), args);
  assert.deepEqual(JSON.parse(await capture(process.execPath, [script, ...args], { cwd: directory })), args);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('missing commands and shell command strings reject without crashing', async (t) => {
  const { directory } = await fixture(t);
  await assert.rejects(resolveCommand(join(directory, 'missing-command')));
  await assert.rejects(spawnCommand(join(directory, 'missing-command'), []));
  await assert.rejects(resolveCommand('node -e "process.exit(0)"'));
});

test('Windows npm cmd and PowerShell shims execute their real JS entry without a shell', { skip: process.platform !== 'win32' }, async (t) => {
  const { directory } = await fixture(t);
  const packageDirectory = join(directory, 'node_modules', 'fixture-cli');
  await mkdir(packageDirectory, { recursive: true });
  const entry = join(packageDirectory, 'cli.mjs');
  await writeFile(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const cmd = join(directory, 'fixture-cli.cmd');
  await writeFile(cmd, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\fixture-cli\\cli.mjs" %*\r\n`);
  const ps1 = join(directory, 'fixture-cli.ps1');
  await writeFile(ps1, `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n$exe=""\nif ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }\n$ret=0\nif (Test-Path "$basedir/node$exe") {\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "$basedir/node$exe" "$basedir/node_modules/fixture-cli/cli.mjs" $args\n  } else {\n    & "$basedir/node$exe" "$basedir/node_modules/fixture-cli/cli.mjs" $args\n  }\n  $ret=$LASTEXITCODE\n} else {\n  if ($MyInvocation.ExpectingInput) {\n    $input | & "node$exe" "$basedir/node_modules/fixture-cli/cli.mjs" $args\n  } else {\n    & "node$exe" "$basedir/node_modules/fixture-cli/cli.mjs" $args\n  }\n  $ret=$LASTEXITCODE\n}\nexit $ret\n`);
  const args = ['中文 "quote"\n&|<>^%PATH%', 'argument-'.repeat(1200)];
  for (const shim of [cmd, ps1]) {
    const resolved = await resolveCommand(shim);
    assert.equal(resolved.file, process.execPath);
    assert.deepEqual(resolved.argsPrefix, [entry]);
    assert.deepEqual(JSON.parse(await capture(shim, args)), args);
  }
  const env = { ...process.env, PATH: directory, Path: join(directory, 'wrong directory'), PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.deepEqual(await resolveCommand('fixture-cli', { env }), { file: process.execPath, argsPrefix: [entry] });
  const environmentEntry = join(directory, 'environment.mjs');
  await writeFile(environmentEntry, 'process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([key]) => key.toLowerCase() === "path")));\n');
  const paths = JSON.parse(await capture(environmentEntry, [], { env }));
  assert.equal(paths.length, 1);
  assert.ok(paths[0][1].split(';').includes(directory));
  assert.ok(!paths[0][1].includes('wrong directory'));
});

test('Windows reports oversized native command lines before launch, including quote expansion', { skip: process.platform !== 'win32' }, async (t) => {
  const { script } = await fixture(t);
  for (const oversized of ['x'.repeat(33000), '"'.repeat(17000)]) {
    await assert.rejects(spawnCommand(script, [oversized]), /32767 UTF-16 characters after quoting/);
  }
});

test('Windows arbitrary batch and PowerShell scripts are rejected instead of shell executed', { skip: process.platform !== 'win32' }, async (t) => {
  const { directory } = await fixture(t);
  const marker = join(directory, 'unsafe marker.txt');
  for (const extension of ['cmd', 'bat', 'ps1']) {
    const script = join(directory, `unsafe.${extension}`);
    await writeFile(script, `echo INJECTED > "${marker}"\n`);
    await assert.rejects(spawnCommand(script, []));
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('Windows discovers a complete official desktop layout without PATH and resolves explicit wrapper/executable paths', { skip: process.platform !== 'win32' }, async (t) => {
  const desktop = await desktopFixture(t);
  assert.deepEqual(await resolveCommand('dsh', { env: desktop.env }), desktop.expected);
  const defaultLocationEnv = { ...desktop.env };
  delete defaultLocationEnv.DSH_DESKTOP_DIR;
  assert.deepEqual(await resolveCommand('dsh', { env: defaultLocationEnv }), desktop.expected);
  for (const command of [desktop.wrapper, desktop.executable]) {
    assert.deepEqual(await resolveCommand(command, { env: desktop.env }), desktop.expected);
  }
});

test('Windows desktop launch merges Electron headless environment without executing a GUI', { skip: process.platform !== 'win32' }, async (t) => {
  const desktop = await desktopFixture(t, { nodeExecutable: true });
  const preloader = 'process.stdout.write(JSON.stringify({ mode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(1) })); process.exit(0);';
  const env = {
    ...desktop.env, ELECTRON_RUN_AS_NODE: '0',
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preloader)}`,
  };
  const result = JSON.parse(await capture('dsh', ['--version'], { env }));
  assert.equal(result.mode, '1');
  assert.deepEqual(result.args, [desktop.cli, '--version']);
});

test('Windows PATH and explicit command selection take priority over desktop fallback', { skip: process.platform !== 'win32' }, async (t) => {
  const desktop = await desktopFixture(t);
  const pathDirectory = join(desktop.directory, 'preferred PATH CLI');
  await mkdir(pathDirectory);
  const entry = join(pathDirectory, 'path-dsh.mjs');
  await writeFile(entry, 'process.stdout.write("PATH CLI");\n');
  await writeFile(join(pathDirectory, 'dsh.cmd'), '@echo off\r\nnode "%~dp0\\path-dsh.mjs" %*\r\n');
  const env = { ...desktop.env, PATH: pathDirectory, Path: pathDirectory };
  assert.deepEqual(await resolveCommand('dsh', { env }), { file: process.execPath, argsPrefix: [entry] });
  // DSH_BIN is selected by the caller; an explicit bad value must remain an error.
  env.DSH_BIN = join(pathDirectory, 'explicit missing dsh.cmd');
  await assert.rejects(resolveCommand(env.DSH_BIN, { env }));
  await assert.rejects(resolveCommand('missing-custom-dsh', { env }));
});

test('Windows incomplete desktop layouts and unknown wrappers reject before any executable can run', { skip: process.platform !== 'win32' }, async (t) => {
  for (const omit of ['executable', 'archive', 'wrapper']) {
    const desktop = await desktopFixture(t, { omit });
    await assert.rejects(resolveCommand('dsh', { env: desktop.env }));
    await assert.rejects(resolveCommand(desktop.executable, { env: desktop.env }));
    await assert.rejects(resolveCommand(desktop.wrapper, { env: desktop.env }));
  }
  const unknown = await desktopFixture(t, { unknownWrapper: true });
  for (const command of ['dsh', unknown.wrapper, unknown.executable]) {
    await assert.rejects(resolveCommand(command, { env: unknown.env }));
  }
  const moved = await desktopFixture(t);
  const wrongBin = join(moved.installDirectory, 'resources', 'other-runtime', 'cli', 'bin');
  await mkdir(wrongBin, { recursive: true });
  const wrongWrapper = join(wrongBin, 'dsh.cmd');
  await copyFile(moved.wrapper, wrongWrapper);
  await assert.rejects(resolveCommand(wrongWrapper, { env: moved.env }));
});

test('tree termination refuses a process not created by this runtime', async () => {
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  await new Promise((accept, reject) => { foreign.once('spawn', accept); foreign.once('error', reject); });
  try {
    await stopProcessTree(foreign);
    assert.equal(process.kill(foreign.pid, 0), true);
  } finally {
    const closed = new Promise((accept) => foreign.once('close', accept));
    foreign.kill();
    await closed;
  }
});
