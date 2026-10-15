const fs = require('node:fs');
const path = require('node:path');

const filesUnder = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
});

function scanProfile(profile, inspect) {
  // Chromium commits state with temp-file + rename. A vanished path invalidates
  // the entire pass: skipping it could miss the bytes at their new destination.
  for (let pass = 0; pass < 5; pass++) {
    try {
      for (const file of filesUnder(profile)) inspect(fs.readFileSync(file), file);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT' || pass === 4) throw error;
    }
  }
}

module.exports = { scanProfile };
