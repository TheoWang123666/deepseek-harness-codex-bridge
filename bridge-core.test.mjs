import assert from 'node:assert/strict';
import test from 'node:test';
import { appServerPrompt, codexFinalText, dshSessionIdFromJson, parseDshJson, taskPrompt } from './bridge-core.mjs';

test('DSH --json parsing takes only the official session and final events', () => {
  const parsed = parseDshJson([
    JSON.stringify({ type: 'session', sessionId: 'session-official', cwd: 'C:/work' }),
    JSON.stringify({ type: 'text', text: 'intermediate' }),
    JSON.stringify({ type: 'final', text: 'final answer\n' }),
  ].join('\n'));
  assert.deepEqual(parsed, { sessionId: 'session-official', answer: 'final answer' });
  assert.throws(() => parseDshJson('not-json'), /non-JSON/);
  assert.throws(() => parseDshJson(JSON.stringify({ type: 'final', text: 'no session' })), /session ID/);
  assert.throws(() => parseDshJson(JSON.stringify({ type: 'session', sessionId: 'session-x' })), /final answer/);
  assert.throws(() => parseDshJson([
    JSON.stringify({ type: 'session', sessionId: 'session-x' }),
    JSON.stringify({ type: 'final', text: '  ' }),
  ].join('\n')), /empty final answer/);
  assert.throws(() => parseDshJson([
    JSON.stringify({ type: 'session', sessionId: 'session-x' }),
    JSON.stringify({ type: 'error', message: 'fixture error' }),
    JSON.stringify({ type: 'final', text: 'late answer' }),
  ].join('\n')), /fixture error/);
});

test('Codex final text ignores commentary and requires a nonempty final item', () => {
  assert.equal(codexFinalText([
    { type: 'agentMessage', phase: 'commentary', text: 'intermediate commentary' },
    { type: 'agentMessage', phase: 'final_answer', text: 'FINAL ANSWER' },
  ]), 'FINAL ANSWER');
  assert.equal(codexFinalText([{ type: 'agentMessage', phase: 'commentary', text: 'only commentary' }]), '');
  assert.equal(codexFinalText([]), '');
});

test('known DSH account model-list diagnostic is ignored without weakening JSON validation', () => {
  const diagnostic = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)';
  const parsed = parseDshJson([
    diagnostic,
    JSON.stringify({ type: 'session', sessionId: 'session-with-diagnostic' }),
    JSON.stringify({ type: 'final', text: 'answer after diagnostic' }),
  ].join('\n'));
  assert.deepEqual(parsed, { sessionId: 'session-with-diagnostic', answer: 'answer after diagnostic' });
  assert.throws(() => parseDshJson([
    diagnostic.replace('2 model(s)', 'unknown diagnostic'),
    JSON.stringify({ type: 'session', sessionId: 'session-x' }),
  ].join('\n')), /non-JSON/);
});

test('a session event is recoverable even when the final event is missing or malformed', () => {
  const stdout = [
    JSON.stringify({ type: 'session', sessionId: 'session-before-failure' }),
    'not-json after the session',
    'diagnostic line from a previous process',
  ].join('\n');
  assert.equal(dshSessionIdFromJson(stdout), 'session-before-failure');
  assert.throws(() => parseDshJson(stdout), (error) => error.sessionId === 'session-before-failure');
});

test('the current question is the first line and background context is last', () => {
  const message = { rootTaskId: 'root-1', taskId: 'task-1', kind: 'question',
    body: 'CURRENT QUESTION', progress: 'progress', evidence: 'evidence' };
  const prompt = appServerPrompt(message, '[Background project context]\nENTRY', 'dsh');
  assert.equal(prompt.split('\n')[0], 'CURRENT QUESTION');
  assert.ok(prompt.includes('[DSH initiated collaboration'));
  assert.ok(prompt.endsWith('[Background project context]\nENTRY'));
  assert.ok(prompt.indexOf('ENTRY') > prompt.indexOf('CURRENT QUESTION'));
});

test('the assigned task is first and bridge metadata/context follow without a duplicated task block', () => {
  const prompt = taskPrompt({ task: 'DO THE TASK', rootTaskId: 'root-1', taskId: 'task-1',
    parentTaskId: null, workspace: 'C:/dsh', codexWorkspace: 'C:/codex', dshSessionId: null,
    codexThreadId: null, projectContext: '[Background project context]\nENTRY',
    mail: 'node server.mjs', windows: true, bridgeLead: 'dsh' });
  assert.equal(prompt.split('\n')[0], 'DO THE TASK');
  assert.ok(prompt.includes('dshSessionId=(automatic; reported by the session event)'));
  assert.ok(prompt.endsWith('[Background project context]\nENTRY'));
  assert.equal(prompt.split('DO THE TASK').length, 2, 'The task must not be duplicated at the end');
});
