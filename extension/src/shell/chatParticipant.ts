import * as vscode from 'vscode';
import type { RunManager } from '../run/runManager';
import type { RunStateMsg, UiStreamEvent } from '../types';

/** The chat surface observes the same run that owns the editor's staged diff. */
export function registerAssistant(context: vscode.ExtensionContext, runs: RunManager) {
  if (!vscode.chat?.createChatParticipant) return;
  context.subscriptions.push(vscode.chat.createChatParticipant('contexo.assistant', async (request, _history, stream, token) => {
    const prompt = request.prompt.trim();
    if (!prompt || token.isCancellationRequested) return;
    if (runs.active && ['streaming', 'awaiting-review'].includes(runs.active.state)) {
      stream.markdown('A Contexo run is active. Finish its review or stop it in the Contexo panel.');
      return;
    }
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const events = (batch: UiStreamEvent[]) => {
      for (const event of batch) {
        if (event.kind === 'text-delta') stream.markdown(event.text);
        else if (event.kind === 'tool-call') stream.progress('Using ' + event.name);
        else if (event.kind === 'turn-done' && event.error) stream.markdown('\n' + event.error);
      }
    };
    const state = (message: RunStateMsg) => {
      if (message.banner) stream.progress(message.banner);
      if (message.state === 'awaiting-review') stream.progress('Review the proposed hunks in the editor and apply or reject them.');
      if (['failed', 'cancelled', 'done'].includes(message.state)) finish();
    };
    runs.on('stream', events);
    runs.on('state', state);
    const cancel = token.onCancellationRequested(() => { void runs.stop(); });
    try {
      await runs.start('agent', prompt);
      await completed;
    } finally {
      cancel.dispose();
      runs.off('stream', events);
      runs.off('state', state);
    }
  }));
}
