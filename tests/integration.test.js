const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scratchDir = require('./scratch');
const integration = require('../app/integration');
const { DEFAULTS } = require('../app/config');

const ICON = path.join(__dirname, '..', 'app', 'icon.svg');
const DP2 = { name: 'DP-2', bounds: { x: 2560, y: 1080, width: 2560, height: 1440 } };

// Scratch HOME plus a fake command runner that records calls.
function setup({ i3Modes = ['default'], desktop = 'KDE' } = {}) {
  const home = scratchDir('airlock-browser-int-');
  const env = { HOME: home, XDG_CURRENT_DESKTOP: desktop };
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'i3-msg' && args.join(' ') === '-t get_binding_modes') return { ok: true, stdout: JSON.stringify(i3Modes) };
    if (cmd === 'i3-msg' && args.join(' ') === '-t get_version') return { ok: desktop === 'i3', stdout: '' };
    return { ok: true, stdout: '' };
  };
  const ctx = integration.context({ env, run, exec: ['/opt/apps/airlock-browser-1.0.0-x86_64.AppImage'], iconSource: ICON });
  return { ctx, home, calls };
}

const state = async (ctx, opts, id) => (await integration.items(ctx, opts)).find((i) => i.id === id);

test('detects KDE and i3', async () => {
  assert.equal(await integration.detectWm(setup({ desktop: 'KDE' }).ctx), 'kde');
  assert.equal(await integration.detectWm(setup({ desktop: 'i3' }).ctx), 'i3');
  assert.equal(await integration.detectWm(setup({ desktop: 'GNOME' }).ctx), null);
});

test('KWin rule is added alongside existing rules and removed cleanly', async () => {
  const { ctx, calls } = setup();
  const file = integration.kwinFile(ctx);
  const existing = '[9ab1]\nDescription=wl-clipboard support\nwmclass=wl-(copy|paste)\nwmclassmatch=3\n\n[General]\ncount=1\nrules=9ab1\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing);
  const opts = { wm: 'kde', settings: { ...DEFAULTS, display: 'DP-2' }, display: DP2 };

  assert.equal((await state(ctx, opts, 'kwin')).state, 'missing');
  await integration.perform(ctx, 'kwin', 'apply', opts);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^rules=9ab1,airlock-browser$/m);
  assert.match(text, /^count=2$/m);
  assert.match(text, /\[airlock-browser\]\n(.*\n)*disableglobalshortcuts=true\ndisableglobalshortcutsrule=2\nposition=2560,1080\npositionrule=3\n/);
  assert.ok(text.startsWith('[9ab1]\nDescription=wl-clipboard support\n'));
  assert.ok(calls.some((c) => c.includes('org.kde.KWin.reconfigure')));
  assert.equal((await state(ctx, opts, 'kwin')).state, 'ok');

  // A settings change makes it out of date, and refresh() follows it.
  const changed = { ...opts, settings: { ...opts.settings, captureKeys: false } };
  assert.equal((await state(ctx, changed, 'kwin')).state, 'outdated');
  await integration.refresh(ctx, changed);
  assert.equal((await state(ctx, changed, 'kwin')).state, 'ok');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /disableglobalshortcuts/);

  await integration.perform(ctx, 'kwin', 'remove', opts);
  assert.equal(fs.readFileSync(file, 'utf8'), existing);
});

test('KWin rule works from an empty rules file', async () => {
  const { ctx } = setup();
  const file = integration.kwinFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[General]\nrules=\n');
  const opts = { wm: 'kde', settings: { ...DEFAULTS }, display: null };
  await integration.perform(ctx, 'kwin', 'apply', opts);
  assert.match(fs.readFileSync(file, 'utf8'), /^rules=airlock-browser$/m);
  assert.equal((await state(ctx, opts, 'kwin')).state, 'ok');
});

test('refresh leaves a missing KWin rule alone', async () => {
  const { ctx } = setup();
  await integration.refresh(ctx, { wm: 'kde', settings: { ...DEFAULTS }, display: null });
  assert.equal(fs.existsSync(integration.kwinFile(ctx)), false);
});

test('i3 mode: include, loaded check, removal', async () => {
  const { ctx, calls } = setup({ desktop: 'i3', i3Modes: ['default', 'airlock-browser'] });
  const p = integration.i3Paths(ctx);
  fs.mkdirSync(path.dirname(p.config), { recursive: true });
  fs.writeFileSync(p.config, 'set $mod Mod1\nbindsym $mod+Return exec alacritty\n');
  const opts = { wm: 'i3', settings: { ...DEFAULTS }, display: null };

  assert.equal((await state(ctx, opts, 'i3')).state, 'missing');
  await integration.perform(ctx, 'i3', 'apply', opts);
  assert.equal(fs.readFileSync(p.snippet, 'utf8'), integration.i3Snippet('airlock-browser'));
  assert.match(fs.readFileSync(p.config, 'utf8'), new RegExp(`\ninclude ${p.snippet}\n$`));
  assert.ok(calls.includes('i3-msg reload'));
  assert.equal((await state(ctx, opts, 'i3')).state, 'ok');

  await integration.perform(ctx, 'i3', 'remove', opts);
  assert.equal(fs.readFileSync(p.config, 'utf8'), 'set $mod Mod1\nbindsym $mod+Return exec alacritty\n');
  assert.equal(fs.existsSync(p.snippet), false);
});

test('i3 mode not loaded by the running i3 is out of date', async () => {
  const { ctx } = setup({ desktop: 'i3', i3Modes: ['default'] });
  const p = integration.i3Paths(ctx);
  fs.mkdirSync(path.dirname(p.config), { recursive: true });
  fs.writeFileSync(p.config, '');
  const opts = { wm: 'i3', settings: { ...DEFAULTS }, display: null };
  await integration.perform(ctx, 'i3', 'apply', opts);
  assert.equal((await state(ctx, opts, 'i3')).state, 'outdated');
});

test('i3 mode defined inline is a conflict and is not touched', async () => {
  const { ctx } = setup({ desktop: 'i3' });
  const p = integration.i3Paths(ctx);
  fs.mkdirSync(path.dirname(p.config), { recursive: true });
  const conf = 'mode "airlock-browser" {\n  bindsym Escape mode "default"\n}\n';
  fs.writeFileSync(p.config, conf);
  const opts = { wm: 'i3', settings: { ...DEFAULTS }, display: null };
  assert.equal((await state(ctx, opts, 'i3')).state, 'conflict');
  await assert.rejects(integration.perform(ctx, 'i3', 'apply', opts), /defines mode "airlock-browser" itself/);
  assert.equal(fs.readFileSync(p.config, 'utf8'), conf);
});

test('no i3 config is unavailable', async () => {
  const { ctx } = setup({ desktop: 'i3' });
  assert.equal((await state(ctx, { wm: 'i3', settings: { ...DEFAULTS } }, 'i3')).state, 'unavailable');
});

test('menu entry and autostart point at this copy', async () => {
  const { ctx } = setup();
  const p = integration.entryPaths(ctx);
  const opts = { wm: null, settings: { ...DEFAULTS } };
  for (const id of ['menu', 'autostart']) {
    assert.equal((await state(ctx, opts, id)).state, 'missing');
    await integration.perform(ctx, id, 'apply', opts);
    assert.equal((await state(ctx, opts, id)).state, 'ok');
    assert.match(fs.readFileSync(p[id], 'utf8'), /^Exec=\/opt\/apps\/airlock-browser-1.0.0-x86_64.AppImage$/m);
  }
  assert.ok(fs.existsSync(p.icon));

  // The same entry from another copy is out of date.
  const moved = integration.context({ env: ctx.env, run: ctx.run, exec: ['/home/me/My Apps/airlock-browser.AppImage'] });
  const menu = await state(moved, opts, 'menu');
  assert.equal(menu.state, 'outdated');
  assert.match(menu.detail, /airlock-browser-1.0.0-x86_64.AppImage/);
  await integration.perform(moved, 'menu', 'apply', opts);
  assert.match(fs.readFileSync(p.menu, 'utf8'), /^Exec="\/home\/me\/My Apps\/airlock-browser.AppImage"$/m);

  await integration.perform(ctx, 'menu', 'remove', opts);
  assert.equal(fs.existsSync(p.menu), false);
  assert.equal(fs.existsSync(p.icon), false);
});

test('KWin rule keeps its position while the chosen monitor is disconnected', async () => {
  const { ctx } = setup();
  const settings = { ...DEFAULTS, display: 'DP-2' };
  await integration.perform(ctx, 'kwin', 'apply', { wm: 'kde', settings, display: DP2 });
  const unplugged = { wm: 'kde', settings, display: null };
  const item = await state(ctx, unplugged, 'kwin');
  assert.equal(item.state, 'ok');
  assert.match(item.detail, /2560,1080, where DP-2 was/);
  await integration.refresh(ctx, { ...unplugged, settings: { ...settings, captureKeys: false } });
  assert.match(fs.readFileSync(integration.kwinFile(ctx), 'utf8'), /^position=2560,1080$/m);
});
