import * as vscode from 'vscode';

type ProviderLocation = vscode.Location | vscode.LocationLink;

function normalize(location: ProviderLocation): vscode.Location {
  return 'targetUri' in location
    ? new vscode.Location(location.targetUri, location.targetSelectionRange ?? location.targetRange)
    : location;
}

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
    const stale = () => document.isClosed || document.version !== version;
    const result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Contexo: Finding symbol impact', cancellable: true,
    }, async (_progress, token) => {
      const queries = [
        ['Definition', 'vscode.executeDefinitionProvider'],
        ['Reference', 'vscode.executeReferenceProvider'],
        ['Implementation', 'vscode.executeImplementationProvider'],
      ] as const;
      const [direct, hierarchy] = await Promise.all([
        Promise.allSettled(queries.map(([, command]) =>
          vscode.commands.executeCommand<ProviderLocation[]>(command, uri, position))),
        Promise.resolve(vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
          'vscode.prepareCallHierarchy', uri, position,
        )).catch(() => undefined),
      ]);
      if (token.isCancellationRequested || stale()) return;
      const locations = new Map<string, { location: vscode.Location; roles: Set<string> }>();
      const failures: string[] = [];
      const add = (location: vscode.Location, role: string) => {
        const start = location.range.start;
        const end = location.range.end;
        const key = JSON.stringify([location.uri.toString(), start.line, start.character, end.line, end.character]);
        const entry = locations.get(key) ?? { location, roles: new Set<string>() };
        entry.roles.add(role);
        locations.set(key, entry);
      };
      for (const [i, value] of direct.entries()) {
        if (value.status === 'fulfilled') {
          for (const location of value.value ?? []) add(normalize(location), queries[i][0]);
        } else failures.push(queries[i][0]);
      }
      if (hierarchy?.length) {
        const [incoming, outgoing] = await Promise.allSettled([
          vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', hierarchy[0]),
          vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', hierarchy[0]),
        ]);
        if (incoming.status === 'fulfilled') {
          for (const call of incoming.value ?? []) add(new vscode.Location(call.from.uri, call.from.selectionRange), 'Caller');
        } else failures.push('Caller');
        if (outgoing.status === 'fulfilled') {
          for (const call of outgoing.value ?? []) add(new vscode.Location(call.to.uri, call.to.selectionRange), 'Callee');
        } else failures.push('Callee');
      }
      if (token.isCancellationRequested || stale()) return;
      return { locations, failures };
    });
    if (stale()) {
      void vscode.window.showInformationMessage('The document changed. Run Show Symbol Impact again.');
      return;
    }
    if (!result) return;
    const { locations, failures } = result;
    if (!locations.size) {
      void vscode.window.showInformationMessage(failures.length
        ? 'Symbol impact lookup could not complete for these providers: ' + failures.join(', ')
        : 'The installed language providers returned no symbol locations.');
      return;
    }
    const limit = 250;
    const choice = await vscode.window.showQuickPick([...locations.values()].slice(0, limit).map(({ location, roles }) => ({
      label: vscode.workspace.asRelativePath(location.uri, true) + ':' + (location.range.start.line + 1),
      description: [...roles].join(', '),
      location,
    })), {
      placeHolder: `Navigate to a language-provider result${locations.size > limit ? ` (first ${limit} of ${locations.size})` : ''}`,
    });
    if (choice && !stale()) {
      await vscode.window.showTextDocument(choice.location.uri, { selection: choice.location.range });
    }
  }));
}
