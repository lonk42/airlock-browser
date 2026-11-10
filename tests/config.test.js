const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scratchDir = require('./scratch');
const config = require('../app/config');

function scratch() {
  const home = scratchDir('airlock-browser-config-');
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
}

test('first run uses defaults', () => {
  const env = scratch();
  assert.deepEqual(config.load(env), { settings: { ...config.DEFAULTS }, firstRun: true });
});

test('save round-trips and ends first run', () => {
  const env = scratch();
  config.save({ url: 'https://example.lan:3001', display: 'DP-2', secondDisplay: 'DP-3', windowMode: 'fullscreen', captureKeys: false }, env);
  const { settings, firstRun } = config.load(env);
  assert.equal(firstRun, false);
  assert.deepEqual(settings, {
    url: 'https://example.lan:3001', display: 'DP-2', secondDisplay: 'DP-3', windowMode: 'fullscreen', captureKeys: false, i3Mode: 'airlock-browser',
  });
});

test('invalid values fall back to defaults', () => {
  const s = config.normalize({ url: 'ftp://x', windowMode: 'huge', captureKeys: 'yes', i3Mode: 'a"b' });
  assert.deepEqual(s, { ...config.DEFAULTS });
});

test('validate rejects bad addresses only', () => {
  assert.deepEqual(config.validate({ url: 'https://localhost:3001' }), {});
  assert.ok(config.validate({ url: 'nope' }).url);
  assert.ok(config.validate({ url: 'file:///etc/passwd' }).url);
});

test('settings without an address count as first run', () => {
  const env = scratch();
  fs.mkdirSync(config.dir(env), { recursive: true });
  fs.writeFileSync(path.join(config.dir(env), 'settings.json'), '{"windowMode": "fullscreen"}');
  const { settings, firstRun } = config.load(env);
  assert.equal(firstRun, true);
  assert.equal(settings.windowMode, 'fullscreen');
  assert.ok(config.validate({ url: '' }).url);
});

test('unreadable settings.json counts as first run', () => {
  const env = scratch();
  fs.mkdirSync(config.dir(env), { recursive: true });
  fs.writeFileSync(path.join(config.dir(env), 'settings.json'), '{oops');
  assert.equal(config.load(env).firstRun, true);
});
