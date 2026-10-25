// Reads a Visual Studio theme (.pkgdef under Common7/IDE/CommonExtensions/Platform, e.g. Theme.Dark.pkgdef): each
// category's "Data" blob is a version, a count, then per category a GUID and its entries, each a name, a background and a
// foreground, a colour being a type byte (0 none, 1 RGBA, else 4 bytes of a system or automatic colour). Gives
// { category: { name: { bg, fg } } } with colours as #rrggbb or #rrggbbaa.
const fs = require('fs');

function readTheme(file, themeId) {
  const text = fs.readFileSync(file, 'utf8');
  const out = {};
  // themeId: one theme's categories, where a file holds several (EditorColors.pkgdef: Dark's, Light's, High Contrast's).
  for (const [, id, category, hex] of text.matchAll(/\[\$RootKey\$\\Themes\\\{([^}]+)\}\\([^\]]+)\]\r?\n"Data"=hex:([0-9a-f,\\\r\n ]+)/gi)) {
    if (themeId && id.toLowerCase() !== themeId.toLowerCase()) continue;
    const bytes = Buffer.from(hex.replace(/[\\\s]/g, '').split(',').filter(Boolean).map((h) => parseInt(h, 16)));
    let at = 0;
    const u32 = () => { const v = bytes.readUInt32LE(at); at += 4; return v; };
    const colour = () => {
      const type = bytes[at++];
      if (type === 0) return undefined;
      const [r, g, b, a] = bytes.subarray(at, at + 4);
      at += 4;
      if (type !== 1) return undefined;
      const hex = (n) => n.toString(16).padStart(2, '0');
      return `#${hex(r)}${hex(g)}${hex(b)}${a === 255 ? '' : hex(a)}`;
    };
    const entries = {};
    try {
      u32(); // size
      u32(); // version
      const categories = u32();
      for (let c = 0; c < categories; c++) {
        at += 16; // the category's GUID
        const count = u32();
        for (let i = 0; i < count; i++) {
          const n = u32();
          const name = bytes.toString('ascii', at, at + n);
          at += n;
          entries[name] = { bg: colour(), fg: colour() };
        }
      }
    } catch {
      // a blob cut short: what was read stays
    }
    out[category] = entries;
  }
  return out;
}

module.exports = { readTheme };

if (require.main === module) {
  const [file, category, filter, themeId] = process.argv.slice(2);
  const theme = readTheme(file, themeId);
  if (!category) console.log(Object.keys(theme).map((k) => `${k} (${Object.keys(theme[k]).length})`).join('\n'));
  else for (const [k, v] of Object.entries(theme[category] || {})) if (!filter || new RegExp(filter, 'i').test(k)) console.log(`${k}: bg ${v.bg || '-'} fg ${v.fg || '-'}`);
}
