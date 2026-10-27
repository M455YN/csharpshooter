// The bottom panel's tool windows as tabs while it is closed, after Visual Studio's auto-hide channel (an AutoHideChannel
// docked Bottom, one AutoHideTabItem per window, a click shows it): Error List, Output, Task Runner Explorer, Test Explorer.
const vscode = require('vscode');
const { n_, t } = require('./l10n');

const TABS = [
  [n_('Error List'), 'workbench.actions.view.problems'],
  [n_('Output'), 'workbench.action.output.toggleOutput'],
  [n_('Task Runner Explorer'), 'csharpShooter.taskRunner.focus'],
  [n_('Test Explorer'), 'csharpShooter.testExplorer.focus'],
];

/** Shows the tabs while none of the panel's trees shows (the panel closed); trees are the views whose visibility an extension sees. */
function registerPanelStrip(context, trees) {
  const items = TABS.map(([name, command], i) => {
    const item = vscode.window.createStatusBarItem(`csharpShooter.panelTab${i}`, vscode.StatusBarAlignment.Left, 10000 - i);
    const text = t(name);
    // shortcut: VS cuts a tab to its width in pixels; 40 characters is what its Polish Task Runner tab shows.
    item.text = text.length > 40 ? `${text.slice(0, 39)}...` : text;
    item.name = item.tooltip = text;
    item.command = command;
    return item;
  });
  const strip = { items, shown: false }; // shown: what the tests read
  const update = () => {
    strip.shown = !trees.some((v) => v.visible);
    items.forEach((item) => (strip.shown ? item.show() : item.hide()));
  };
  context.subscriptions.push(...items, ...trees.map((v) => v.onDidChangeVisibility(update)));
  update();
  return strip;
}

module.exports = { registerPanelStrip };
