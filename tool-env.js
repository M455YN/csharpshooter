// The environment of the .NET tools CSharpShooter runs for a folder's code (builds, restores, msbuild's questions,
// dotnet new, dev-certs, NuGet's lists, test runs): each tool's telemetry off, unless the user set the variable
// themself, as Passenger 0.4.3 runs them (#2159). The user's own programs and terminals keep their environment as it is.

/** The telemetry opt-outs of the tools: the .NET CLI's, Microsoft.Testing.Platform's, Avalonia's build, dotnet-svcutil's,
 *  Azure Functions Core Tools' and Aspire's CLI's. */
const TELEMETRY_OPT_OUTS = [
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'TESTINGPLATFORM_TELEMETRY_OPTOUT',
  'AVALONIA_TELEMETRY_OPTOUT',
  'DOTNET_SVCUTIL_TELEMETRY_OPTOUT',
  'FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT',
  'ASPIRE_CLI_TELEMETRY_OPTOUT',
];

/** The opt-outs the inherited environment does not set: what a task's ShellExecution adds to its shell's. */
function telemetryOff(inherited = process.env) {
  const has = new Set(Object.keys(inherited).map((k) => k.toUpperCase()));
  return Object.fromEntries(TELEMETRY_OPT_OUTS.filter((v) => !has.has(v)).map((v) => [v, '1']));
}

/** A tool's whole environment: this process's, with the opt-outs it lacks (for execFile and spawn). */
const toolEnv = (extra) => ({ ...process.env, ...telemetryOff(), ...(extra || {}) });

module.exports = { TELEMETRY_OPT_OUTS, telemetryOff, toolEnv };
