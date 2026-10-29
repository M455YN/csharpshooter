// The Solution Explorer's files and folders edited as Visual Studio 2026 edits them: Rename (F2, a .cs file's class
// renamed with it when asked, as VS asks), Delete (Del), Cut, Copy and Paste (Ctrl+X, Ctrl+C, Ctrl+V; a copy beside its
// original named as VS names it) and drag and drop (a move; files dropped from outside are copied in). A file's nested
// files (Foo.cshtml.cs under Foo.cshtml) go with it. Moves and renames are workspace edits, so open editors follow.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { t } = require('./l10n');

const MIME = 'application/vnd.code.tree.csharpshooter.solution';
const editable = (item) => item?.kind === 'file' || item?.kind === 'folder';
const exists = (p) => fs.existsSync(p);

/** An item's path, then its nested files' (a folder's are inside it already). */
function withNested(item) {
  const own = item.resourceUri.fsPath;
  const out = [own];
  const walk = (entries, dir) => {
    for (const e of entries || []) {
      out.push(path.join(dir, e.name));
      walk(e.nested, dir);
    }
  };
  if (item.kind === 'file') walk(item.nested, path.dirname(own));
  return out;
}

/** Where a paste or a drop onto an item goes: a folder itself, a project's folder, a file's folder. */
function folderOf(item) {
  if (!item) return undefined;
  if (item.kind === 'project') return path.dirname(item.file);
  if (item.kind === 'folder') return item.resourceUri.fsPath;
  if (item.kind === 'file') return path.dirname(item.resourceUri.fsPath);
  return undefined;
}

/** A name for a copy beside its original, as VS gives it: "Foo - Copy.cs", then "Foo - Copy (2).cs". */
function copyName(dir, name, isFile) {
  if (!exists(path.join(dir, name))) return name;
  const ext = isFile ? path.extname(name) : '';
  const base = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const next = `${base}${n === 1 ? t(' - Copy') : t(' - Copy ({0})', n)}${ext}`;
    if (!exists(path.join(dir, next))) return next;
  }
}

/** Saves, as VS does, what an edit changed in files open in no tab that had no unsaved edits before it. */
async function saveUntabbed(apply) {
  const inTabs = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((tab) => tab.input?.uri?.toString()).filter(Boolean));
  const dirty = new Set(vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString()));
  const done = await apply();
  await Promise.all(vscode.workspace.textDocuments.filter((d) => d.isDirty && !inTabs.has(d.uri.toString()) && !dirty.has(d.uri.toString())).map((d) => d.save()));
  return done;
}

/** Where a .cs file declares a type of its own name ("class Values"): its name's position, which the C# server's rename
 *  takes; the server's symbols come flat, without it. */
async function typeNamed(uri, name) {
  const document = await vscode.workspace.openTextDocument(uri);
  const m = new RegExp(`\\b(?:class|struct|interface|enum|record)\\s+(${name})\\b`).exec(document.getText());
  return m ? document.positionAt(m.index + m[0].length - name.length) : undefined;
}

function registerItemEditing(context, getView, reveal) {
  let clipboard; // { cut, items }
  const chosen = (item, items) => {
    const list = items?.length ? items : item ? [item] : [...(getView()?.selection || [])];
    return list.filter(editable);
  };

  async function rename(item) {
    item = chosen(item)[0];
    if (!item) return false;
    const from = item.resourceUri.fsPath;
    const dir = path.dirname(from);
    const name = path.basename(from);
    const ext = item.kind === 'file' ? path.extname(name) : '';
    const typed = await vscode.window.showInputBox({
      title: t('Rename'), value: name, valueSelection: [0, name.length - ext.length],
      validateInput: (v) => (!v.trim() || /[\\/:*?"<>|]/.test(v) ? t('Not a valid file name.')
        : v.toLowerCase() !== name.toLowerCase() && exists(path.join(dir, v)) ? t('A file or folder with the name "{0}" already exists at this location on disk. Choose a different name.', v)
          : undefined),
    });
    if (!typed || typed === name) return false;
    if (item.kind === 'file' && path.extname(typed).toLowerCase() !== ext.toLowerCase()) {
      const yes = t('Yes');
      if ((await vscode.window.showWarningMessage(t('Changing a file name extension can make the file unusable. Change it?'), { modal: true }, yes)) !== yes) return false;
    }
    // Foo.cs renamed to Bar.cs, its class Foo renamed with every use when asked, as VS asks.
    const oldType = path.basename(name, '.cs');
    const newType = path.basename(typed, '.cs');
    if (item.kind === 'file' && /\.cs$/i.test(name) && /\.cs$/i.test(typed) && /^[A-Za-z_]\w*$/.test(newType) && oldType !== newType) {
      const type = await typeNamed(item.resourceUri, oldType).catch(() => undefined);
      const yes = t('Yes');
      if (type && (await vscode.window.showInformationMessage(t('You are renaming a file. Would you also like to perform a rename in this project of all references to the code element \'{0}\'?', oldType), { modal: true }, yes, t('No'))) === yes) {
        const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', item.resourceUri, type, newType);
        if (edit) await saveUntabbed(() => vscode.workspace.applyEdit(edit));
      }
    }
    // The C# server's rename may have renamed the file itself already.
    if (!exists(from)) {
      reveal(path.join(dir, typed));
      return true;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const p of withNested(item)) {
      const to = p === from ? typed : typed + path.basename(p).slice(name.length);
      if (p === from || path.basename(p).startsWith(name)) edit.renameFile(vscode.Uri.file(p), vscode.Uri.file(path.join(dir, to)));
    }
    if (!(await vscode.workspace.applyEdit(edit))) return false;
    reveal(path.join(dir, typed));
    return true;
  }

  async function remove(item, items) {
    const list = chosen(item, items);
    if (!list.length) return false;
    const ok = t('OK');
    const said = list.length === 1 ? t('"{0}" will be deleted.', path.basename(list[0].resourceUri.fsPath)) : t('The selected items will be deleted.');
    // Into the Recycle Bin, as VS Code's Explorer deletes (VS deletes for good): a slip can be taken back.
    if ((await vscode.window.showWarningMessage(said, { modal: true, detail: t('You can restore it from the Recycle Bin.') }, ok)) !== ok) return false;
    for (const i of list) {
      for (const p of withNested(i)) if (exists(p)) await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true });
    }
    return true;
  }

  /** Moves (or copies) items into a folder, each nested file with its own, as VS refuses what it refuses. */
  async function into(dir, items, copy) {
    const edit = new vscode.WorkspaceEdit();
    let last;
    for (const item of items) {
      const from = item.resourceUri.fsPath;
      const name = path.basename(from);
      if (!copy && path.dirname(from).toLowerCase() === dir.toLowerCase()) {
        vscode.window.showWarningMessage(t('Cannot move \'{0}\'. The destination folder is the same as the source folder.', name));
        continue;
      }
      if (item.kind === 'folder' && (dir.toLowerCase() + path.sep).startsWith(from.toLowerCase() + path.sep)) {
        vscode.window.showWarningMessage(t('Cannot move \'{0}\'. The destination folder is a subfolder of the source folder.', name));
        continue;
      }
      const target = copy ? copyName(dir, name, item.kind === 'file') : name;
      if (!copy && exists(path.join(dir, name))) {
        vscode.window.showWarningMessage(item.kind === 'folder' ? t('Cannot move the folder \'{0}\'. A folder with the same name already exists in the destination directory.', name)
          : t('A file or folder with the name "{0}" already exists at this location on disk. Choose a different name.', name));
        continue;
      }
      for (const p of withNested(item)) {
        const to = vscode.Uri.file(path.join(dir, p === from ? target : target + path.basename(p).slice(name.length)));
        if (copy) await vscode.workspace.fs.copy(vscode.Uri.file(p), to, { overwrite: false });
        else edit.renameFile(vscode.Uri.file(p), to);
      }
      last = path.join(dir, target);
    }
    if (!copy && !(await vscode.workspace.applyEdit(edit))) return false;
    if (last) reveal(last);
    return !!last;
  }

  async function paste(item) {
    const dir = folderOf(item || getView()?.selection[0]);
    if (!dir || !clipboard) return false;
    const { cut, items } = clipboard;
    const done = await into(dir, items.filter((i) => exists(i.resourceUri.fsPath)), !cut);
    if (cut) clipboard = undefined; // a cut is pasted once, as VS's
    return done;
  }

  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('csharpShooter.solution.rename', rename);
  register('csharpShooter.solution.delete', remove);
  register('csharpShooter.solution.cut', (item, items) => (clipboard = { cut: true, items: chosen(item, items) }));
  register('csharpShooter.solution.copy', (item, items) => (clipboard = { cut: false, items: chosen(item, items) }));
  register('csharpShooter.solution.paste', paste);

  // Dragged within the tree: a move, as VS's; files dropped from VS Code's Explorer or the system's: copied in.
  const dragAndDrop = {
    dragMimeTypes: ['text/uri-list'],
    dropMimeTypes: [MIME, 'text/uri-list'],
    handleDrag(source, data) {
      const items = source.filter(editable);
      data.set(MIME, new vscode.DataTransferItem(items));
      data.set('text/uri-list', new vscode.DataTransferItem(items.map((i) => i.resourceUri.toString()).join('\r\n')));
    },
    async handleDrop(target, data) {
      const dir = folderOf(target);
      if (!dir) return;
      const own = data.get(MIME)?.value;
      if (own?.length) return void (await into(dir, own, false));
      const list = await data.get('text/uri-list')?.asString();
      const uris = (list || '').split(/\r?\n/).filter(Boolean).map((u) => vscode.Uri.parse(u)).filter((u) => u.scheme === 'file');
      const items = uris.map((u) => ({ kind: fs.statSync(u.fsPath).isDirectory() ? 'folder' : 'file', resourceUri: u }));
      await into(dir, items, true);
    },
  };
  return { dragAndDrop, rename, remove, paste, copyName };
}

module.exports = { registerItemEditing, copyName, folderOf };
