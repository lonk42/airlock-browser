// Downloads under a config file's downloads section: only the listed file
// extensions are saved, each optionally opened with its program, such as
// wfica for .ica (Citrix) or xfreerdp for .rdp. Everything else is cancelled.
const fs = require('fs');
const path = require('path');

function extOf(filename) {
  const base = path.basename(String(filename));
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

// A file name that stays in the download directory and is not hidden.
function safeName(filename) {
  let name = path.basename(String(filename || '')).replace(/[\x00-\x1f\x7f/\\]/g, '_').replace(/^\.+/, '');
  if (!name) name = 'download';
  return name.slice(0, 200);
}

function uniquePath(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; exists(candidate); n += 1) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

// What to do with a download, given policy.downloads:
//   { action: 'default' }            no downloads section: Electron's save dialog
//   { action: 'cancel' }             extension not listed
//   { action: 'save', argv }         save, then run argv + file unless argv is null
function decide(downloads, filename) {
  if (!downloads) return { action: 'default' };
  const ext = extOf(filename);
  if (!Object.prototype.hasOwnProperty.call(downloads.handlers, ext)) return { action: 'cancel' };
  return { action: 'save', argv: downloads.handlers[ext] };
}

module.exports = { extOf, safeName, uniquePath, decide };
