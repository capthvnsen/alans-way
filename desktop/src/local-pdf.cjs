const fs = require('node:fs');
const path = require('node:path');

// Chromium chooses the local MIME type by extension. Require both the real
// path's .pdf extension and magic bytes; never load sender-controlled markup.
function pdfFile(file) {
  let fd;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.pdf$/i.test(file)) return '';
    const real = fs.realpathSync(file);
    if (!/\.pdf$/i.test(real) || !fs.statSync(real).isFile()) return '';
    fd = fs.openSync(real, 'r');
    const magic = Buffer.alloc(5);
    return fs.readSync(fd, magic, 0, 5, 0) === 5 && magic.toString('ascii') === '%PDF-' ? real : '';
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { pdfFile };
