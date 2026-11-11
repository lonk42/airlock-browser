const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scratchDir = require('./scratch');
const policy = require('../app/policy');
const storage = require('../app/storage');
const config = require('../app/config');

function scratch() {
  const home = scratchDir('airlock-browser-policy-');
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_RUNTIME_DIR: path.join(home, 'run') };
}

const parse = (text) => policy.parse(text);
const fails = (text, re) => assert.throws(() => parse(text), (err) => err instanceof policy.PolicyError && re.test(err.message));

test('--config is read from argv in both spellings', () => {
  assert.equal(policy.configArg(['/usr/bin/airlock-browser']), null);
  assert.equal(policy.configArg(['airlock-browser', '--config', 'a.yaml']), 'a.yaml');
  assert.equal(policy.configArg(['electron', '.', '--config=/etc/k.yaml']), '/etc/k.yaml');
  assert.throws(() => policy.configArg(['airlock-browser', '--config']), /needs a file path/);
  assert.throws(() => policy.configArg(['airlock-browser', '--config', '--no-sandbox']), /needs a file path/);
  assert.throws(() => policy.configArg(['airlock-browser', '--config=']), /needs a file path/);
});

test('no --config gives the personal defaults', () => {
  const p = policy.load(['airlock-browser']);
  assert.equal(p.kiosk, false);
  assert.equal(p.file, null);
  assert.deepEqual(p.lock, []);
  assert.equal(p.settingsPage, true);
  assert.equal(p.integration, 'manage');
  assert.deepEqual(p.keys, { quit: true, reload: true, settings: true, bar: true });
  assert.equal(p.bar, 'auto');
});

test('kiosk mode locks everything and turns off the settings page', () => {
  const p = parse('version: 1\nkiosk: true\nsettings:\n  url: https://coder.example.lan\n');
  assert.equal(p.kiosk, true);
  assert.deepEqual(p.lock, policy.SETTING_KEYS);
  assert.equal(p.settingsPage, false);
  assert.equal(p.keys.settings, false);
  assert.equal(p.integration, 'report');
});

test('kiosk defaults can be overridden', () => {
  const p = parse('version: 1\nkiosk: true\nsettings: {url: "https://x.lan"}\nlock: [url]\nsettingsPage: true\nkeys: {quit: false}\n');
  assert.deepEqual(p.lock, ['url']);
  assert.equal(p.settingsPage, true);
  assert.equal(p.keys.settings, true);
  assert.equal(p.keys.quit, false);
});

test('a full personal config parses', () => {
  const p = parse(`
version: 1
profile: coder
title: Coder
settings:
  url: https://coder.example.lan
  display: DP-2
  secondDisplay: none
  windowMode: fullscreen
  captureKeys: false
lock: all
integration: report
`);
  assert.equal(p.profile, 'coder');
  assert.equal(p.title, 'Coder');
  assert.deepEqual(p.settings, { url: 'https://coder.example.lan', display: 'DP-2', secondDisplay: 'none', windowMode: 'fullscreen', captureKeys: false });
  assert.deepEqual(p.lock, policy.SETTING_KEYS);
});

test('mistakes are errors, not ignored', () => {
  fails('version: 1\nsettings:\n  secondDisplay: ""\n', /settings.secondDisplay: must be a non-empty string/);
  fails('version: 1\nsettings:\n  secondDisplay: DP 2\n', /settings.secondDisplay: must be auto, none or an output name/);
  fails('kiosk: true', /version: must be 1/);
  fails('version: 2', /version: must be 1/);
  fails('version: 1\nkoisk: true', /koisk: unknown key/);
  fails('version: 1\nsettings:\n  adress: x', /settings.adress: unknown key/);
  fails('version: 1\nkiosk: yes please', /kiosk: must be true or false/);
  fails('version: 1\nkiosk: true', /settings.url: is required when kiosk is true/);
  fails('version: 1\nsettingsPage: false', /settings.url: is required when settingsPage is false/);
  fails('version: 1\nsettings: {url: "ftp://x"}', /settings.url: Use an https/);
  fails('version: 1\nsettings: {windowMode: huge}', /windowMode: must be one of/);
  fails('version: 1\nlock: [url, colour]', /lock.1: must be one of/);
  fails('version: 1\nprofile: My Profile', /profile: use 1 to 32/);
  fails('version: 1\nkeys: {escape: true}', /keys.escape: unknown key/);
  fails('version: 1\nversion: 1', /not valid YAML/);
  fails('- a\n- b', /must be a mapping/);
  fails('version: 1\nsettings: [1]', /settings: must be a mapping/);
});

test('bar modes', () => {
  assert.equal(parse('version: 1\nbar: always\n').bar, 'always');
  const never = parse('version: 1\nbar: never\n');
  assert.equal(never.keys.bar, false);
  fails('version: 1\nbar: sometimes', /bar: must be one of auto, always, never/);
});

test('the launcher can have its own window mode', () => {
  assert.equal(parse('version: 1\n').launcher.windowMode, null);
  const p = parse('version: 1\nkiosk: true\nsettings:\n  url: https://coder.example.lan\n  windowMode: fullscreen\nlauncher:\n  windowMode: normal\n');
  assert.equal(p.launcher.windowMode, 'normal');
  assert.equal(p.settings.windowMode, 'fullscreen');
  fails('version: 1\nlauncher:\n  windowMode: windowed\n', /launcher.windowMode/);
  fails('version: 1\nlauncher:\n  mode: normal\n', /launcher.mode: unknown key/);
});

test('the toolbar security chip and full-screen switch can be turned off, Home and Back on', () => {
  assert.equal(parse('version: 1\n').toolbar.security, true);
  assert.equal(parse('version: 1\ntoolbar:\n  security: false\n').toolbar.security, false);
  assert.equal(parse('version: 1\n').toolbar.fullscreen, true);
  assert.equal(parse('version: 1\ntoolbar:\n  fullscreen: false\n').toolbar.fullscreen, false);
  assert.equal(parse('version: 1\n').toolbar.navigation, false);
  assert.equal(parse('version: 1\ntoolbar:\n  navigation: true\n').toolbar.navigation, true);
  fails('version: 1\ntoolbar:\n  navigation: yes please\n', /toolbar.navigation/);
  fails('version: 1\ntoolbar:\n  security: maybe\n', /toolbar.security/);
  fails('version: 1\ntoolbar:\n  chip: false\n', /toolbar.chip: unknown key/);
});

test('YAML tags and anchors do not run code or expand', () => {
  fails('version: 1\ntitle: !!js/function "function () {}"', /./);
  fails('version: 1\n<<: {kiosk: true}', /unknown key/);
});

test('load reports the file and resolves relative paths', () => {
  const dir = scratchDir('airlock-browser-conf-');
  fs.writeFileSync(path.join(dir, 'k.yaml'), 'version: 1\ntitle: Test\n');
  const p = policy.load(['airlock-browser', '--config', 'k.yaml'], dir);
  assert.equal(p.file, path.join(dir, 'k.yaml'));
  assert.equal(p.title, 'Test');
  assert.throws(() => policy.load(['airlock-browser', '--config', 'missing.yaml'], dir), /missing.yaml: no such file/);
  fs.writeFileSync(path.join(dir, 'bad.yaml'), 'version: 1\nnope: 1\n');
  assert.throws(() => policy.load(['airlock-browser', '--config', 'bad.yaml'], dir), /bad.yaml: nope: unknown key/);
});

test('settings: file values seed a first run, locked ones always win', () => {
  const env = scratch();
  const p = parse('version: 1\nprofile: coder\nsettings: {url: "https://coder.lan", windowMode: fullscreen}\nlock: [url]\n');
  const first = policy.settings(p, env);
  assert.equal(first.firstRun, false); // The file gives the address.
  assert.equal(first.settings.url, 'https://coder.lan');
  assert.equal(first.settings.windowMode, 'fullscreen');
  assert.equal(first.dir, path.join(config.dir(env), 'profiles', 'coder'));

  // The user saves other values; the unlocked one sticks, the locked one does not.
  config.save({ ...first.settings, url: 'https://elsewhere.lan', windowMode: 'normal' }, env, first.dir);
  const later = policy.settings(p, env);
  assert.equal(later.settings.url, 'https://coder.lan');
  assert.equal(later.settings.windowMode, 'normal');
  // The default profile's settings are untouched.
  assert.equal(fs.existsSync(path.join(config.dir(env), 'settings.json')), false);
});

test('settings: a kiosk reads nothing from the user', () => {
  const env = scratch();
  config.save({ ...config.DEFAULTS, windowMode: 'normal' }, env);
  const p = parse('version: 1\nkiosk: true\nsettings: {url: "https://coder.lan"}\n');
  const s = policy.settings(p, env);
  assert.equal(s.dir, null);
  assert.equal(s.firstRun, false);
  assert.equal(s.settings.windowMode, config.DEFAULTS.windowMode);
});

test('settings: no config uses the default directory and starts with the first-run page', () => {
  const env = scratch();
  const s = policy.settings(policy.defaults(false), env);
  assert.equal(s.firstRun, true);
  assert.equal(s.settings.url, '');
  assert.equal(s.dir, path.join(env.XDG_CONFIG_HOME, 'airlock-browser'));
});

test('a locked url needs a value', () => {
  fails('version: 1\nlock: [url]\n', /settings.url: is required when url is locked/);
});

test('unlocked() keeps locked values whatever the form sends', () => {
  const p = parse('version: 1\nsettings: {url: "https://good.lan"}\nlock: [url]\n');
  const out = policy.unlocked(p, { url: 'https://evil.lan', windowMode: 'fullscreen' }, { url: 'https://good.lan', windowMode: 'normal' });
  assert.deepEqual(out, { url: 'https://good.lan', windowMode: 'fullscreen' });
});

test('storage paths per profile and kiosk', () => {
  const env = scratch();
  const data = path.join(env.HOME, '.local', 'share', 'airlock-browser');
  assert.equal(storage.userDataDir(policy.defaults(false), env), data);
  assert.equal(storage.userDataDir(parse('version: 1\nprofile: coder\n'), env), path.join(data, 'profiles', 'coder'));
  const kiosk = parse('version: 1\nkiosk: true\nprofile: coder\nsettings: {url: "https://x.lan"}\n');
  const tmpfs = (dirs) => (d) => ({ type: dirs.includes(d) ? 0x01021994 : 0xef53 });
  assert.deepEqual(storage.kioskDir(kiosk, env, 1234, tmpfs([env.XDG_RUNTIME_DIR, '/dev/shm'])),
    { dir: path.join(env.XDG_RUNTIME_DIR, 'airlock-browser-kiosk-coder'), memory: true });
  // A runtime dir on disk (as in a container) loses to /dev/shm.
  assert.deepEqual(storage.kioskDir(kiosk, env, 1234, tmpfs(['/dev/shm'])),
    { dir: '/dev/shm/airlock-browser-kiosk-coder-1234', memory: true });
  assert.deepEqual(storage.kioskDir(kiosk, { HOME: env.HOME }, 1234, tmpfs([])),
    { dir: path.join(os.tmpdir(), 'airlock-browser-kiosk-coder-1234'), memory: false });
});

test('kiosk directory is private and emptied except the lock and path dirs', () => {
  const env = scratch();
  const dir = path.join(env.XDG_RUNTIME_DIR, 'airlock-browser-kiosk-default');
  storage.makePrivateDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(dir, 'Cookies'), 'x');
  fs.symlinkSync('/nonexistent', path.join(dir, 'SingletonLock'));
  fs.mkdirSync(path.join(dir, 'downloads'));
  fs.writeFileSync(path.join(dir, 'downloads', 'old.ica'), 'x');
  storage.emptyDir(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['SingletonLock', 'downloads']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'downloads')), []);
  storage.removeDir(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('a kiosk directory owned by someone else is refused', () => {
  const env = scratch();
  const dir = path.join(env.XDG_RUNTIME_DIR, 'k');
  assert.throws(() => storage.makePrivateDir(dir, process.getuid() + 1), /not a directory owned by this user/);
});

const downloads = require('../app/downloads');

test('downloads: only listed extensions are saved, kiosk saves none by default', () => {
  const p = parse('version: 1\ndownloads:\n  handlers: {ica: [wfica], rdp: [xfreerdp, "/cert:ignore"], csv: null}\n  quit: handler\n');
  assert.deepEqual(downloads.decide(p.downloads, 'launch.ICA'), { action: 'save', argv: ['wfica'] });
  assert.deepEqual(downloads.decide(p.downloads, 'x.rdp'), { action: 'save', argv: ['xfreerdp', '/cert:ignore'] });
  assert.deepEqual(downloads.decide(p.downloads, 'data.csv'), { action: 'save', argv: null });
  assert.deepEqual(downloads.decide(p.downloads, 'evil.sh'), { action: 'cancel' });
  assert.deepEqual(downloads.decide(p.downloads, 'ica'), { action: 'cancel' });
  assert.deepEqual(downloads.decide(policy.defaults(false).downloads, 'x.ica'), { action: 'default' });
  const kiosk = parse('version: 1\nkiosk: true\nsettings: {url: "https://x.lan"}\n');
  assert.deepEqual(downloads.decide(kiosk.downloads, 'x.ica'), { action: 'cancel' });
});

test('downloads: mistakes are errors', () => {
  fails('version: 1\ndownloads: {handlers: {".ica": [wfica]}}', /downloads.handlers..ica: use a lowercase file extension/);
  fails('version: 1\ndownloads: {handlers: {ica: []}}', /needs a program/);
  fails('version: 1\ndownloads: {quit: handler}', /no handler runs a program/);
  fails('version: 1\ndownloads: {quit: always}', /downloads.quit: must be one of/);
  fails('version: 1\nmedia: {screenpicker: true}', /media.screenpicker: unknown key/);
  assert.equal(parse('version: 1\ndownloads: {dir: ~/Downloads}').downloads.dir, path.join(os.homedir(), 'Downloads'));
});

test('download names stay in the directory and do not overwrite', () => {
  assert.equal(downloads.safeName('../../.bashrc'), 'bashrc');
  assert.equal(downloads.safeName('a/b\\c.ica'), 'b_c.ica');
  assert.equal(downloads.safeName(''), 'download');
  const taken = new Set(['/d/x.ica', '/d/x (1).ica']);
  assert.equal(downloads.uniquePath('/d', 'x.ica', (f) => taken.has(f)), '/d/x (2).ica');
});

test('kiosk environment redirects caches and gives the user theirs back', () => {
  const user = { HOME: '/home/u', XDG_DATA_HOME: '/home/u/data', PATH: '/bin' };
  const env = storage.kioskEnv('/dev/shm/k', user);
  assert.equal(env.XDG_CACHE_HOME, '/dev/shm/k/xdg-cache');
  assert.equal(env.XDG_DATA_HOME, '/dev/shm/k/xdg-data');
  assert.equal(storage.kioskEnv('/dev/shm/k', env), null);
  assert.deepEqual(storage.userEnv(env), user);
});
