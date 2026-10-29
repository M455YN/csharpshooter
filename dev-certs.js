// The ASP.NET Core HTTPS development certificate before F5 of a profile with an https URL, as Visual Studio 2026 has it
// (Web Tools' AspNetSSLCertificateSvc): installed when there is none, then trusted once the person says yes; the check
// runs once a window session. No VS Code API here, so test/dev-certs.js runs it on its own.
const { execFile } = require('child_process');

/** dotnet dev-certs https <args>: its exit code (0 done, -1 when dotnet could not run). */
const devCerts = (args) => new Promise((resolve) => {
  execFile('dotnet', ['dev-certs', 'https', ...args], { windowsHide: true, timeout: 120000 },
    (e) => resolve(!e ? 0 : typeof e.code === 'number' ? e.code : -1));
});

// dotnet dev-certs' exit codes (aspnetcore's src/Tools/dotnet-dev-certs), as VS words them.
const NO_CERTIFICATE = 6;
const NOT_TRUSTED = 7;
const CANCELLED = 5;

let checked = false;

/** ask(): 'yes', 'no' or 'never' (the person's answer to VS's question); fail(code): an error to tell. Resolves once done,
 *  whatever came of it: the start goes on either way, the browser then warning of the certificate. */
async function ensureTrusted({ ask, fail, dotnet = devCerts }) {
  if (checked) return 'checked';
  checked = true;
  let code = await dotnet(['--trust', '--check']);
  if (code === 0) return 'trusted';
  if (code === NO_CERTIFICATE) {
    code = await dotnet([]);
    if (code !== 0) return fail(code), 'failed';
  } else if (code !== NOT_TRUSTED) {
    return fail(code), 'failed';
  }
  const answer = await ask();
  if (answer !== 'yes') return answer;
  // Windows asks itself before a certificate goes into the user's trusted roots.
  code = await dotnet(['--trust']);
  if (code !== 0 && code !== CANCELLED) fail(code);
  return code === 0 ? 'trusted' : 'failed';
}

module.exports = { ensureTrusted, reset: () => (checked = false), NO_CERTIFICATE, NOT_TRUSTED };
