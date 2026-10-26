function finalText(items = []) {
  const messages = items.filter((item) => item.type === 'agentMessage' && typeof item.text === 'string');
  const finals = messages.filter((item) => item.phase === 'final_answer' || item.phase === 'final');
  const selected = finals.length ? finals : messages.filter((item) => !item.phase).slice(-1);
  return selected.map((item) => item.text.trim()).filter(Boolean).join('\n\n');
}

function pause(milliseconds, signal) {
  return new Promise((accept, reject) => {
    if (signal.aborted) { reject(new Error('Queue reply reader stopped')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('Queue reply reader stopped')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); accept(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Read only the selected thread's recent turn summaries, correlated by the
 * official clientId metadata. Queue acceptance is never a completed answer. */
export async function waitForQueuedReply({ request, receipt, pollMs = 1000, signal, onReceipt }) {
  for (;;) {
    if (signal.aborted) throw new Error('Queue reply reader stopped');
    let cursor;
    let match;
    for (let page = 0; page < 10; page += 1) {
      const response = await request('thread/turns/list', {
        threadId: receipt.threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary',
        ...(cursor ? { cursor } : {}),
      });
      match = (response.data || []).find((turn) => (receipt.turnId && turn.id === receipt.turnId)
        || turn.items?.some((item) => item.type === 'userMessage' && item.clientId === receipt.clientUserMessageId));
      if (match || !response.nextCursor || response.nextCursor === cursor) break;
      cursor = response.nextCursor;
    }
    if (match) {
      if (receipt.turnId !== match.id) {
        receipt.turnId = match.id;
        await onReceipt?.(receipt);
      }
      // A cold reader can temporarily replay an unfinished remotely owned turn
      // as interrupted. Without a completion time or actual error, keep waiting.
      const provisionalInterruption = match.status === 'interrupted' && match.completedAt == null
        && !(typeof match.error?.message === 'string' && match.error.message.trim());
      if (match.status === 'failed' || (match.status === 'interrupted' && !provisionalInterruption)) {
        receipt.status = match.status;
        await onReceipt?.(receipt);
        const error = new Error(`Queued Codex turn ${match.status}${match.error?.message ? `: ${match.error.message}` : ''}`);
        error.queueReceipt = { ...receipt };
        throw error;
      }
      if (match.status === 'completed') {
        let answer = finalText(match.items);
        if (!answer) {
          const items = [];
          let itemCursor;
          for (let page = 0; page < 10; page += 1) {
            const response = await request('thread/items/list', {
              threadId: receipt.threadId, turnId: match.id, limit: 100, sortDirection: 'asc',
              ...(itemCursor ? { cursor: itemCursor } : {}),
            });
            for (const entry of response.data || []) {
              if (entry.item && (!entry.turnId || entry.turnId === match.id)) items.push(entry.item);
              else if (entry.type) items.push(entry);
            }
            if (!response.nextCursor || response.nextCursor === itemCursor) break;
            itemCursor = response.nextCursor;
          }
          answer = finalText(items);
        }
        if (answer) {
          receipt.status = 'completed';
          await onReceipt?.(receipt);
          return { threadId: receipt.threadId, answer, delivery: 'queued', queueReceipt: { ...receipt } };
        }
      }
    }
    await pause(pollMs, signal);
  }
}
