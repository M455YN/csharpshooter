// CSharpShooter's optional features, each with its switch in Settings (csharpShooter.features.<name>), on by default and
// read each time the feature would act, so turning one off or on takes effect at once, with no reload.
const vscode = require('vscode');

/** Whether the optional feature <name> is on. */
const on = (name) => vscode.workspace.getConfiguration('csharpShooter.features').get(name, true);

module.exports = { on };
