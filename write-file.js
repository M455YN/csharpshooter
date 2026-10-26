// Writes a project or solution file the C# server or MSBuild may be holding a moment (EBUSY / EPERM on Windows): tried
// again for up to five seconds before the error is given.
const fs = require('fs');

const pause = new Int32Array(new SharedArrayBuffer(4));

function writeFileWhenFree(file, data, tries = 50) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (e) {
      if (!/^(EBUSY|EPERM)$/.test(e.code) || attempt >= tries) throw e;
      Atomics.wait(pause, 0, 0, 100);
    }
  }
}

module.exports = { writeFileWhenFree };
