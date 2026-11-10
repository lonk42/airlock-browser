// Scratch directories for tests, removed when the test file finishes.
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

module.exports = function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
};
