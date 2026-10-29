// The refactorings that ask their options, as Visual Studio 2026 has them (Change Signature, Extract Interface, Move Type
// to File and Move to Namespace, Pull Members Up) and Passenger adds (Push Members Down): Passenger's handlers in the C#
// server (roslyn-extension/) say what is at the caret and make the change; VS Code's input boxes and lists ask what VS's
// dialogs do, and the change is one workspace edit, which Undo takes back. Ctrl+. offers them where they apply.
const vscode = require('vscode');
const { t } = require('./l10n');
const { parameterText, parseSignature } = require('./signature-text');

const HANDLER = (name) => `Passenger.Roslyn.Extension.${name}`;

/** ask(document): (handler, message) => the handler's answer about that document, or a thrown Error. */
function registerRefactorings(context, ask) {
  const at = (editor) => ({ line: editor.selection.active.line, character: editor.selection.active.character });
  const describe = (editor, name) => ask(editor.document)(name, { at: at(editor) });

  /** Applies a Refactored answer: its new files, then each file's edits in the text the server had. */
  async function apply(made, done) {
    if (made.problem) {
      vscode.window.showWarningMessage(made.problem);
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const file of made.changes) {
      const uri = vscode.Uri.file(file.path);
      // A file it makes has its whole text as the one edit: written as the file is made (an edit to a file the same
      // workspace edit makes was left out of what was saved).
      if (file.created) edit.createFile(uri, { ignoreIfExists: false, contents: Buffer.from(file.edits.map((e) => e.text).join(''), 'utf8') });
      else for (const e of file.edits) edit.replace(uri, new vscode.Range(e.start.line, e.start.character, e.end.line, e.end.character), e.text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      vscode.window.showWarningMessage(t('The change could not be applied: a file changed meanwhile.'));
      return false;
    }
    vscode.window.setStatusBarMessage(done, 5000);
    // A use the change could not reach (a method group whose delegate no longer fits) is left as it was, and said.
    if (made.left?.length) {
      const first = made.left[0];
      const open = t('Open');
      const chosen = await vscode.window.showWarningMessage(t('{0} uses were left as they were: {1}', made.left.length, first.why), open);
      if (chosen === open) {
        await vscode.window.showTextDocument(vscode.Uri.file(first.path), { selection: new vscode.Range(first.at.line, first.at.character, first.at.line, first.at.character) });
      }
    }
    return true;
  }

  const run = (name, fn) => async (editor, ...rest) => {
    // A command from a key or a menu gets no editor (or the file's Uri): the active one.
    if (!editor?.document) editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'csharp') return false;
    try {
      return await fn(editor, ...rest);
    } catch (e) {
      vscode.window.showErrorMessage(t('{0} failed: {1}', name, e.message));
      return false;
    }
  };

  const changeSignature = run(t('Change Signature'), async (editor) => {
    const signature = await describe(editor, 'DescribeSignature');
    if (signature.problem) return void vscode.window.showWarningMessage(signature.problem);
    const head = signature.kind === 'constructor' ? signature.name : `${signature.returnType} ${signature.name}`;
    const typed = await vscode.window.showInputBox({
      title: t('Change Signature'),
      prompt: t('Change Signature:') + ` ${signature.modifiers} ${signature.container}`.trimEnd(),
      value: `${head}(${signature.parameters.map(parameterText).join(', ')})`,
      validateInput: (text) => (parseSignature(text, signature.kind === 'constructor') ? undefined : t('Not a signature: write it as {0}', `${head}(int count, string name = "")`)),
    });
    if (typed === undefined) return false;
    const parsed = parseSignature(typed, signature.kind === 'constructor');
    const parameters = [];
    for (const p of parsed.parameters) {
      const from = signature.parameters.findIndex((old) => old.name === p.name);
      let callValue = '';
      if (from < 0 && !p.defaultValue) {
        callValue = await vscode.window.showInputBox({ title: t('Change Signature'), prompt: `${t('Call site value:')} ${p.type} ${p.name}`, placeHolder: t('Value to inject at call sites') });
        if (callValue === undefined) return false;
      }
      parameters.push({ from, modifier: p.modifier, type: p.type, name: p.name, defaultValue: p.defaultValue, callValue });
    }
    const made = await ask(editor.document)('ChangeSignature', { at: at(editor), name: parsed.name || signature.name, returnType: parsed.returnType ?? signature.returnType, parameters });
    return apply(made, t('Changed the signature of {0}', `${signature.container}.${parsed.name || signature.name}`));
  });

  const extractInterface = run(t('Extract Interface'), async (editor) => {
    const source = await describe(editor, 'DescribeInterface');
    if (source.problem) return void vscode.window.showWarningMessage(source.problem);
    const name = await vscode.window.showInputBox({ title: t('Extract Interface'), prompt: t('New interface name:'), value: source.name,
      validateInput: (v) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? undefined : t('Not a C# name')) });
    if (!name) return false;
    const members = await vscode.window.showQuickPick(source.members.map((m) => ({ label: m.text, description: m.kind, id: m.id, picked: true })),
      { title: t('Extract Interface'), placeHolder: t('Select members:'), canPickMany: true });
    if (!members?.length) return false;
    const fileName = name === source.name ? source.fileName : `${name}.cs`;
    const made = await ask(editor.document)('ExtractInterface', { at: at(editor), name, fileName, members: members.map((m) => m.id) });
    return apply(made, t('Extracted the interface {0} from {1} to {2}', name, source.type, fileName));
  });

  const moveType = run(t('Move'), async (editor, toFile) => {
    const type = await describe(editor, 'DescribeType');
    if (type.problem) return void vscode.window.showWarningMessage(type.problem);
    if (toFile === undefined) {
      const chosen = await vscode.window.showQuickPick([
        { label: t('Move type to {0}', type.targetFileName), toFile: true },
        { label: t('Move to namespace...'), toFile: false },
      ], { title: `${type.kind} ${type.name}` });
      if (!chosen) return false;
      toFile = chosen.toFile;
    }
    if (toFile) {
      const fileName = await vscode.window.showInputBox({ title: t('Move type to {0}', type.targetFileName), prompt: t('File Name:'), value: type.targetFileName,
        validateInput: (v) => (/\.cs$/i.test(v) && !/[\\/]/.test(v) ? undefined : t('File name must have the "{0}" extension.', '.cs')) });
      if (!fileName) return false;
      const made = await ask(editor.document)('MoveTypeToFile', { at: at(editor), fileName });
      return apply(made, t('Moved {0} {1} to {2}', type.kind, type.name, fileName));
    }
    const space = await vscode.window.showInputBox({ title: t('Move to namespace'), prompt: t('Target Namespace:'), value: type.namespace });
    if (space === undefined || space === type.namespace) return false;
    const made = await ask(editor.document)('MoveTypeToNamespace', { at: at(editor), namespace: space });
    return apply(made, t('Moved {0} {1} to namespace {2}', type.kind, type.name, space));
  });

  const moveMembers = (up) => run(up ? t('Pull Members Up') : t('Push Members Down'), async (editor) => {
    const hierarchy = await describe(editor, 'DescribeHierarchy');
    const problem = hierarchy.problem
      ?? (up && !hierarchy.bases.length ? t("'{0}' has no base type in this solution to pull members up to", hierarchy.type)
        : !up && !hierarchy.derived.length ? t("No class in this solution derives from '{0}' to push members down to", hierarchy.type)
          : !hierarchy.members.length ? t("'{0}' has no members to move", hierarchy.type) : null);
    if (problem) return void vscode.window.showWarningMessage(problem);
    const title = up ? t('Pull Members Up') : t('Push Members Down');
    let target;
    if (up) {
      const base = hierarchy.bases.length === 1 ? hierarchy.bases[0]
        : await vscode.window.showQuickPick(hierarchy.bases.map((b) => ({ label: b.text, description: b.kind, ...b })), { title, placeHolder: t('Select destination:') });
      if (!base) return false;
      target = base.id;
    } else {
      const derived = await vscode.window.showQuickPick(hierarchy.derived.map((d) => ({ label: d.text, description: d.kind, id: d.id, picked: true })),
        { title, placeHolder: t('Select destination:'), canPickMany: true });
      if (!derived?.length) return false;
      target = derived.map((d) => d.id).join('\n');
    }
    const members = await vscode.window.showQuickPick(hierarchy.members.map((m) => ({ label: m.text, description: m.kind, id: m.id })),
      { title, placeHolder: t('Select members:'), canPickMany: true });
    if (!members?.length) return false;
    // shortcut: no Make abstract choice (VS's checkbox per member); the members move whole. Upgrade with a second list.
    const made = await ask(editor.document)(up ? 'PullMembersUp' : 'PushMembersDown', { at: at(editor), target, members: members.map((m) => m.id), abstract: [] });
    return apply(made, up ? t('Pulled {0} members of {1} up', members.length, hierarchy.type) : t('Pushed {0} members of {1} down', members.length, hierarchy.type));
  });

  const pullUp = moveMembers(true);
  const pushDown = moveMembers(false);
  context.subscriptions.push(
    vscode.commands.registerCommand('csharpShooter.refactor.changeSignature', (e) => changeSignature(e)),
    vscode.commands.registerCommand('csharpShooter.refactor.extractInterface', (e) => extractInterface(e)),
    vscode.commands.registerCommand('csharpShooter.refactor.moveTypeToFile', (e) => moveType(e, true)),
    vscode.commands.registerCommand('csharpShooter.refactor.moveToNamespace', (e) => moveType(e, false)),
    vscode.commands.registerCommand('csharpShooter.refactor.pullMembersUp', (e) => pullUp(e)),
    vscode.commands.registerCommand('csharpShooter.refactor.pushMembersDown', (e) => pushDown(e)),
    // Ctrl+. (asked for, not each caret move): those that apply at the caret, as VS's Quick Actions list them.
    vscode.languages.registerCodeActionsProvider({ language: 'csharp', scheme: 'file' }, {
      async provideCodeActions(document, range, codeContext) {
        if (codeContext.triggerKind !== vscode.CodeActionTriggerKind.Invoke) return [];
        const editor = vscode.window.activeTextEditor;
        if (editor?.document !== document) return [];
        const quiet = (name) => describe(editor, name).catch(() => ({ problem: 'unavailable' }));
        const [signature, source, type, hierarchy] = await Promise.all(['DescribeSignature', 'DescribeInterface', 'DescribeType', 'DescribeHierarchy'].map(quiet));
        const action = (title, command) => Object.assign(new vscode.CodeAction(title, vscode.CodeActionKind.Refactor), { command: { title, command } });
        const out = [];
        if (!signature.problem) out.push(action(t('Change signature...'), 'csharpShooter.refactor.changeSignature'));
        if (!source.problem && source.members?.length) out.push(action(t('Extract interface...'), 'csharpShooter.refactor.extractInterface'));
        if (!type.problem) {
          if (type.typesInFile > 1) out.push(action(t('Move type to {0}', type.targetFileName), 'csharpShooter.refactor.moveTypeToFile'));
          out.push(action(t('Move to namespace...'), 'csharpShooter.refactor.moveToNamespace'));
        }
        if (!hierarchy.problem && hierarchy.members?.length) {
          if (hierarchy.bases?.length) out.push(action(t('Pull members up to base type...'), 'csharpShooter.refactor.pullMembersUp'));
          if (hierarchy.derived?.length) out.push(action(t('Push members down to derived types...'), 'csharpShooter.refactor.pushMembersDown'));
        }
        return out;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.Refactor] }));
  return { changeSignature, extractInterface, moveType, pullUp, pushDown };
}

module.exports = { registerRefactorings };
