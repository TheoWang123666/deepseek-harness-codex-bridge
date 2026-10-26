/** Pure prompt and DSH JSON-stream helpers shared by the bridge and its tests. */

/** Extract a native session ID from any complete session events already emitted. */
export function dshSessionIdFromJson(stdout) {
  let sessionId = null;
  for (const line of String(stdout).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
  }
  return sessionId;
}

// DSH's account provider may print this one startup diagnostic to stdout before
// the NDJSON stream. Keep the allowlist exact; unknown non-JSON still fails.
const DSH_MODEL_LIST_DIAGNOSTIC = /^\[llm-deepseek-account\] model listing from https:\/\/api\.deepseek\.com\/models loaded \d+ model\(s\), skipped \d+ row\(s\)$/u;

function isKnownDshModelListDiagnostic(line) {
  return DSH_MODEL_LIST_DIAGNOSTIC.test(line.trim());
}

export function parseDshJson(stdout) {
  let sessionId = null;
  let answer = null;
  let error = null;
  const fail = (message) => {
    const failure = new Error(message);
    failure.sessionId = sessionId;
    throw failure;
  };
  for (const line of String(stdout).split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      if (isKnownDshModelListDiagnostic(line)) continue;
      fail('DeepSeek Harness emitted an unknown non-JSON line in --json mode');
    }
    if (event?.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (event?.type === 'error') error = typeof event.message === 'string' ? event.message : 'DeepSeek Harness reported an error';
    if (event?.type === 'final' && typeof event.text === 'string') answer = event.text;
  }
  if (error) fail(error);
  if (!sessionId) fail('DeepSeek Harness --json stream did not report a native session ID');
  if (answer === null) fail('DeepSeek Harness --json stream ended without a final answer');
  if (!answer.trim()) fail('DeepSeek Harness --json stream returned an empty final answer');
  return { sessionId, answer: answer.trim() };
}

export function codexFinalText(items = []) {
  const messages = items.filter((item) => item?.type === 'agentMessage'
    && typeof item.text === 'string' && item.text.trim());
  const finals = messages.filter((item) => item.phase === 'final_answer' || item.phase === 'final');
  const selected = finals.length ? finals : messages.filter((item) => !item.phase);
  return selected.map((item) => item.text.trim()).filter(Boolean).join('\n\n');
}

export function appServerPrompt(message, projectContext = '', bridgeLead = 'codex') {
  const coordination = bridgeLead === 'dsh'
    ? 'DSH is the project lead and owns planning, coordination, and final decisions. Codex is an auxiliary assistant for debugging, review, and recommendations. Do not delegate this request back to DSH; return concrete findings and evidence for DSH to assess.'
    : 'Codex is the lead coordinator and final decision-maker. This subtask is already owned by DSH: do not delegate it back to DSH. Respond to the supplied progress, evidence, question, result, or blocker; integrate or decide the next step.';
  const context = projectContext ? `\n\n${projectContext}` : '';
  return `${message.body}\n\n[DSH initiated collaboration — metadata only]\nRoot task: ${message.rootTaskId}\nAssigned DSH subtask: ${message.taskId}\nMessage kind: ${message.kind}\nProgress: ${message.progress || '(none)'}\nEvidence: ${message.evidence || '(none)'}\n\n${coordination}${context}`;
}

export function taskPrompt({ task, rootTaskId, taskId, parentTaskId, workspace, codexWorkspace,
  dshSessionId, codexThreadId, projectContext, mail, windows, bridgeLead = 'codex' }) {
  const quote = (value) => windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  const ids = `--root-task-id ${quote(rootTaskId)} --task-id ${quote(taskId)}`;
  const coordination = bridgeLead === 'dsh'
    ? 'DSH is the project lead and owns planning, coordination, and final decisions. Codex provides auxiliary debugging, review, and recommendations.'
    : 'Codex is the lead coordinator and final decision-maker; DSH executes the assigned auxiliary task.';
  const context = projectContext ? `\n\n${projectContext}` : '';
  return `${task}\n\n[DSH-Codex Bridge assignment — metadata only; the task above is the assigned subtask]\nrootTaskId=${rootTaskId}\ntaskId=${taskId}\nparentTaskId=${parentTaskId || '(none)'}\nworkspace=${workspace}\ndshSessionId=${dshSessionId || '(automatic; reported by the session event)'}\ncodexThreadId=${codexThreadId || '(new thread on first Codex chat)'}\n\n${coordination}\nExecute this assigned subtask yourself. Do not return or re-delegate the same subtask unchanged. You may proactively contact Codex only with progress, evidence, a result, a concrete question backed by progress/evidence, or an explicit blocker. Run the following mailbox commands in ${windows ? 'PowerShell (keep the leading & invocation operator)' : 'a POSIX shell'}; replace the ... placeholders with your own message:\n  ${mail} send ${ids} --kind milestone --body "..." --progress "..." --evidence "..."\nOr start/continue the task's bound Codex thread with the same fields using (do not override its --thread-id):\n  ${mail} chat ${ids} --kind question --body "..." --progress "..." --evidence "..." --workspace ${quote(codexWorkspace || workspace)}\nRead Codex mailbox replies with:\n  ${mail} inbox --task-id ${quote(taskId)} --mark-read${context}`;
}
