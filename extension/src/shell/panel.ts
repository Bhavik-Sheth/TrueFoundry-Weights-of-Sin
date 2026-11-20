/**
 * shell/panel.ts - C1 host side of the Contexo webview panel.
 *
 * Adapted from microsoft/vscode-extension-samples `webview-view-sample` (MIT, see
 * LICENSE.upstream and UPSTREAMS.md): the WebviewViewProvider, localResourceRoots, CSP and nonce
 * pattern. Everything else is Contexo's.
 *
 * Exports:
 *  - class ContexoPanelProvider implements WebviewViewProvider: serves dist/webview/index.js +
 *    index.css with a CSP + nonce; connect-src allows http://localhost:* and http://127.0.0.1:*.
 *  - post(msg: ToWebview): queued until the view resolves; 'stream' messages are batched (<=50ms)
 *    and flushed before any other message so ordering is preserved.
 *  - onMessage(cb): subscribe to ToHost messages from the webview.
 *
 * Rules: no agent logic. The webview sends 'ready' on mount; the queue is flushed on resolve.
 * Depends on: types, vscode. Depended on by: extension.
 */
import * as vscode from 'vscode';
import type { ToHost, ToWebview, UiStreamEvent } from '../types';

const BATCH_MS = 50;

export class ContexoPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'contexo.panel';

  private view?: vscode.WebviewView;
  private ready = false;
  private queue: ToWebview[] = [];
  private pendingStream: UiStreamEvent[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly emitter = new vscode.EventEmitter<ToHost>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const root = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    view.webview.html = this.html(view.webview, root);
    view.webview.onDidReceiveMessage((m: ToHost) => {
      if (this.view !== view) return;
      if (m.type === 'ready') { this.ready = true; this.flush(); }
      this.emitter.fire(m);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.flush();
  }

  post(msg: ToWebview): void {
    if (msg.type === 'stream') {
      this.pendingStream.push(...msg.events);
      this.timer ??= setTimeout(() => this.flush(), BATCH_MS);
      return;
    }
    this.drainStream();
    this.queue.push(msg);
    this.flush();
  }

  onMessage(cb: (m: ToHost) => void): vscode.Disposable {
    return this.emitter.event(cb);
  }

  private drainStream(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pendingStream.length) {
      this.queue.push({ type: 'stream', events: this.pendingStream });
      this.pendingStream = [];
    }
  }

  private flush(): void {
    this.drainStream();
    if (!this.view || !this.ready) return; // not resolved yet: keep queued
    const q = this.queue;
    this.queue = [];
    for (const m of q) void this.view.webview.postMessage(m);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, 'index.css'));
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      'connect-src http://localhost:* http://127.0.0.1:*',
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Contexo</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}
