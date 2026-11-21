import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ExternalAgentTools } from '../mcp/tools';
import type { ReviewEngine } from '../review/diffView';
import type { RecordEvidence } from '../run/journal';
import type { RunManager } from '../run/runManager';
import type { Proposal, ProposeArgs, Run } from '../types';
import { assertNativeWorkspacePath } from '../mcp/server';
import { proposalKey, sha256 } from '../review/proposal';
import { captureSelection } from './inlineEdit';

const REVIEW_KEY = 'contexo.externalReview.v1';
type SavedReview = { run: Run; proposal: Proposal };

export class EditorAgentBridge implements ExternalAgentTools {
  private readonly boundRoot = this.singleRoot();

  constructor(
    private readonly storage: vscode.Memento,
    private readonly review: ReviewEngine,
    private readonly runs: RunManager,
    private readonly record?: RecordEvidence,
  ) {}

  get workspaceId() {
    return this.boundRoot?.uri.toString();
  }

  private singleRoot() {
    const roots = vscode.workspace.workspaceFolders;
    return roots?.length === 1 && roots[0].uri.scheme === 'file' ? roots[0] : undefined;
  }

  workspace(): string {
    const root = this.singleRoot();
    if (!vscode.workspace.isTrusted || !root || root.uri.toString() !== this.workspaceId) {
      throw new Error('Open a trusted single-folder workspace and reload VS Code to connect an editor agent.');
    }
    return root.uri.fsPath;
  }

  selection() {
    this.workspace();
    const editor = vscode.window.activeTextEditor;
    const root = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!editor || editor.selection.isEmpty || root?.uri.toString() !== this.workspaceId) return undefined;
    return captureSelection(editor);
  }

  async stage(args: ProposeArgs, requestId?: string): Promise<unknown> {
    const root = this.workspace();
    const edits = args.edits.map(edit => ({ ...edit, path: edit.path.replace(/\\/g, '/') }));
    const request = { ...args, edits };
    const runId = requestId ? sha256(this.workspaceId + ':' + requestId).slice(0, 32) : randomUUID();
    const reviewId = sha256(runId + proposalKey(request));
    const tracked = this.status(reviewId);
    if (tracked) return tracked;
    const previous = this.storage.get<SavedReview>(REVIEW_KEY);
    if (previous?.proposal.status === 'reviewing' && this.review.pending?.key !== previous.proposal.key) {
      throw new Error('Restore or reject the outstanding editor-agent review before staging another.');
    }
    if (this.review.pending || ['streaming', 'awaiting-review'].includes(this.runs.active?.state ?? '')) {
      throw new Error('Finish the current Contexo run or review before staging another.');
    }
    if (previous?.run.id === runId) throw new Error('Use a new requestId for changed proposal content.');
    for (const edit of edits) await assertNativeWorkspacePath(root, edit.path);
    this.workspace();
    const run: Run = {
      id: runId, mode: 'agent', origin: 'external', workspaceUri: this.workspaceId,
      request: args.summary, sessionId: '', sealedSessions: [], agent: 'contexo', state: 'awaiting-review',
    };
    this.record?.(run.id, { kind: 'request', mode: 'agent', text: args.summary });
    const result = await this.review.beginProposal(run, run.id, '', request);
    if (result !== 'reviewing') throw new Error(result.deny);
    return { ...this.status(reviewId), message: 'Review the proposal in the source editor, then apply or reject it.' };
  }

  status(reviewId: string) {
    const active = this.review.externalStatus(reviewId);
    if (active) return active;
    const saved = this.storage.get<SavedReview>(REVIEW_KEY);
    if (!saved || saved.run.workspaceUri !== this.workspaceId || saved.proposal.key !== reviewId) return;
    return {
      reviewId,
      status: saved.proposal.status,
      files: saved.proposal.files.map(file => file.path),
      applied: saved.proposal.result?.applied,
      rejected: saved.proposal.result?.rejected,
    };
  }

  persist(proposal: Proposal, run: Run) {
    this.workspace();
    if (run.workspaceUri !== this.workspaceId) throw new Error('The review belongs to a different workspace.');
    return this.storage.update(REVIEW_KEY, { run, proposal: structuredClone(proposal) } satisfies SavedReview);
  }

  finish(proposal: Proposal): void {
    const saved = this.storage.get<SavedReview>(REVIEW_KEY);
    if (saved?.proposal.key === proposal.key && proposal.status !== 'reviewing') {
      void this.storage.update(REVIEW_KEY, { ...saved, proposal: structuredClone(proposal) }).then(undefined, () => {
        void vscode.window.showErrorMessage('Contexo could not persist the editor-agent review outcome.');
      });
    }
  }

  async validate(proposal: Proposal): Promise<boolean> {
    const saved = this.storage.get<SavedReview>(REVIEW_KEY);
    if (saved?.proposal.key !== proposal.key) return false;
    const root = this.workspace();
    if (saved.run.workspaceUri !== this.workspaceId) throw new Error('The review belongs to a different workspace.');
    for (const file of proposal.files) await assertNativeWorkspacePath(root, file.path);
    return true;
  }

  async restore(): Promise<boolean> {
    const saved = this.storage.get<SavedReview>(REVIEW_KEY);
    if (saved?.proposal.status !== 'reviewing') return false;
    if (this.storage.get('review.apply.v1')) throw new Error('Recover the interrupted file apply first.');
    await this.validate(saved.proposal);
    await this.review.attachProposal(saved.run, structuredClone(saved.proposal));
    return true;
  }
}

/** Keep older VS Code builds usable through explicit MCP configuration. */
export function registerCopilotBridge(context: vscode.ExtensionContext, url: string, token: string) {
  type Definition = { label: string };
  const api = vscode as typeof vscode & {
    McpHttpServerDefinition?: new (label: string, uri: vscode.Uri, headers: Record<string, string>) => Definition;
    lm?: { registerMcpServerDefinitionProvider?: (id: string, provider: {
      provideMcpServerDefinitions: () => Definition[];
    }) => vscode.Disposable };
  };
  const HttpDefinition = api.McpHttpServerDefinition;
  if (HttpDefinition && api.lm?.registerMcpServerDefinitionProvider) {
    context.subscriptions.push(api.lm.registerMcpServerDefinitionProvider('contexo.workspace', {
      provideMcpServerDefinitions: () => vscode.workspace.isTrusted
        ? [new HttpDefinition('contexo', vscode.Uri.parse(url), { 'X-Contexo-Token': token })] : [],
    }));
  }

  context.subscriptions.push(vscode.commands.registerCommand('contexo.installClaudeSkill', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || vscode.workspace.workspaceFolders?.length !== 1 || !vscode.workspace.isTrusted) {
      throw new Error('Open one trusted workspace folder to install the Claude Code skill.');
    }
    const path = '.claude/skills/contexo-review/SKILL.md';
    await assertNativeWorkspacePath(root.fsPath, path);
    const target = vscode.Uri.joinPath(root, path);
    const source = vscode.Uri.joinPath(context.extensionUri, 'skills', 'contexo-review', 'SKILL.md');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.claude', 'skills', 'contexo-review'));
    try {
      await vscode.workspace.fs.copy(source, target, { overwrite: false });
    } catch (error) {
      if ((error as vscode.FileSystemError).code !== 'FileExists') throw error;
    }
    await vscode.window.showTextDocument(target);
  }));

  const targets = ['Copilot', 'Claude Code', 'Agent token'] as const;
  context.subscriptions.push(vscode.commands.registerCommand('contexo.copyAgentConnection', async (choice?: typeof targets[number]) => {
    const target = choice && targets.includes(choice) ? choice : await vscode.window.showQuickPick(targets, {
      placeHolder: 'Copy connection information for this workspace',
    });
    if (!target) return;
    const config = { type: 'http', url, headers: { 'X-Contexo-Token': '${CONTEXO_AGENT_TOKEN}' } };
    const text = target === 'Agent token' ? token : JSON.stringify({
      mcpServers: { contexo: target === 'Copilot' ? { ...config, tools: ['*'] } : config },
    }, null, 2);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('Contexo connection information copied.');
  }));
}
