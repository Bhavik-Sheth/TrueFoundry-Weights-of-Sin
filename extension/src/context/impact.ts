import * as vscode from 'vscode';

export function registerImpact(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand('contexo.showSymbolImpact', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) {
      throw new Error('Place the cursor on a symbol in a workspace file.');
    }
    const { document } = editor;
    const uri = document.uri;
    const position = editor.selection.active;
    const version = document.version;
    const [definitions, references] = await Promise.all([
      vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>('vscode.executeDefinitionProvider', uri, position),
      vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position),
    ]);
    if (document.isClosed || document.version !== version) {
      void vscode.window.showInformationMessage('The document changed. Run Show Symbol Impact again.');
      return;
    }
    const locations = new Map<string, { location: vscode.Location; roles: Set<string> }>();
    function add(location: vscode.Location, role: string) {
      const start = location.range.start;
      const end = location.range.end;
      const key = JSON.stringify([location.uri.toString(), start.line, start.character, end.line, end.character]);
      const entry = locations.get(key) ?? { location, roles: new Set<string>() };
      entry.roles.add(role);
      locations.set(key, entry);
    }
    for (const definition of definitions ?? []) {
      add('targetUri' in definition
        ? new vscode.Location(definition.targetUri, definition.targetSelectionRange ?? definition.targetRange)
        : definition, 'Definition');
    }
    for (const reference of references ?? []) add(reference, 'Reference');
    if (!locations.size) {
      void vscode.window.showInformationMessage('No definitions or references returned by the language providers.');
      return;
    }
    const choice = await vscode.window.showQuickPick([...locations.values()].map(({ location, roles }) => ({
      label: vscode.workspace.asRelativePath(location.uri, true) + ':' + (location.range.start.line + 1),
      description: [...roles].join(', '),
      location,
    })), { placeHolder: 'Navigate to a definition or reference' });
    if (choice) {
      await vscode.window.showTextDocument(choice.location.uri, { selection: choice.location.range });
    }
  }));
}
