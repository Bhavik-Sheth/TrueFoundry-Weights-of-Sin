import type * as vscode from 'vscode';

let selected: string | undefined;

export function workspaceRoot() {
  const { workspace } = require('vscode') as typeof vscode;
  const folders = workspace.workspaceFolders;
  return folders?.find(folder => folder.uri.toString() === selected) ?? folders?.[0];
}

export function selectWorkspaceRoot(uri: vscode.Uri) {
  selected = uri.toString();
}

export function hasNativeFiles(uri: vscode.Uri) {
  const { env } = require('vscode') as typeof vscode;
  return uri.scheme === 'file' || (uri.scheme === 'vscode-remote' && !!env.remoteName);
}
