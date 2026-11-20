import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { RunJournal } from '../run/journal';
import { readReplay } from '../replay/records';
import type { Proposal } from '../types';

type Requirement = { id: string; text: string };

export function registerEvidence(
  context: vscode.ExtensionContext,
  journal: RunJournal,
  currentProposal: () => Proposal | undefined,
) {
  context.subscriptions.push(vscode.commands.registerCommand('contexo.linkRequirement', async () => {
    const proposal = currentProposal();
    if (!proposal) throw new Error('Open a proposal before linking a requirement.');
    await journal.flush();
    const { records } = readReplay(await journal.read(proposal.runId));
    const requirements = new Map<string, Requirement>();
    for (const { evidence } of records) {
      const id = evidence.requirementId;
      const text = evidence.requirementText;
      if (evidence.kind === 'requirement-link' && typeof id === 'string' && typeof text === 'string') {
        requirements.set(id, { id, text });
      }
    }
    const choice = await vscode.window.showQuickPick([
      { label: 'Create a requirement', requirement: undefined },
      ...[...requirements.values()].map(requirement => ({ label: requirement.text, requirement })),
    ], { placeHolder: 'Choose a requirement for this change' });
    if (!choice) return;
    let requirement = choice.requirement;
    if (!requirement) {
      const text = (await vscode.window.showInputBox({ prompt: 'Enter one requirement this change addresses' }))?.trim();
      if (!text) return;
      requirement = { id: randomUUID(), text };
    }
    const hunks = await vscode.window.showQuickPick(proposal.hunks.map(hunk => ({
      label: hunk.path + ':' + hunk.newStart, description: hunk.decision, id: hunk.id,
    })), { canPickMany: true, placeHolder: 'Select the hunks that address this requirement' });
    if (!hunks?.length) return;
    if (proposal !== currentProposal()) throw new Error('The proposal changed while choosing evidence.');
    const checks = records.filter(record => record.evidence.kind === 'check').map(record => {
      const name = typeof record.evidence.name === 'string' ? record.evidence.name : 'Check';
      return { label: name, description: String(record.evidence.status ?? ''), sequence: record.sequence };
    });
    const selected = checks.length
      ? await vscode.window.showQuickPick(checks, { canPickMany: true, placeHolder: 'Choose related checks. Press Enter to skip.' })
      : [];
    if (!selected) return;
    if (proposal !== currentProposal()) throw new Error('The proposal changed while choosing evidence.');
    journal.record(proposal.runId, {
      kind: 'requirement-link', requirementId: requirement.id, requirementText: requirement.text, proposalKey: proposal.key,
      hunkIds: hunks.map(hunk => hunk.id), checkSequences: selected.map(check => check.sequence),
      source: 'manual',
    });
    await journal.flush();
    void vscode.window.showInformationMessage('Linked requirement evidence in the run record.');
  }));
}
