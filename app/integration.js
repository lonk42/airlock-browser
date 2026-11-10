// Window-manager and desktop integration, set up from the settings overlay.
// Each item reports a state (ok, missing, outdated, conflict, unavailable,
// present) and is applied or removed only when the user asks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WM_CLASS = 'airlock-browser';
const KWIN_RULE = 'airlock-browser';
const MANAGED = 'managed by the Airlock Browser settings';

function context({ env = process.env, run, exec, iconSource }) {
  const home = env.HOME || os.homedir();
  return {
    env,
    exec, // argv that starts this copy of the app, for desktop entries.
    iconSource,
    run: run || ((cmd, args) => new Promise((resolve) => {
      execFile(cmd, args, { env, timeout: 5000 }, (err, stdout) =>
        resolve({ ok: !err, stdout: String(stdout || '') }));
    })),
    home,
    configHome: env.XDG_CONFIG_HOME || path.join(home, '.config'),
    dataHome: env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
  };
}

async function detectWm(ctx) {
  if ((await ctx.run('i3-msg', ['-t', 'get_version'])).ok) return 'i3';
  if (/(^|:)KDE(:|$)/.test(ctx.env.XDG_CURRENT_DESKTOP || '')) return 'kde';
  return null;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

// --- KWin ------------------------------------------------------------------
// KConfig ini, edited line by line so other rules keep their exact bytes.

function parseIni(text) {
  const sections = [{ name: null, lines: [] }];
  for (const line of text.split('\n')) {
    const m = /^\[(.*)\]\s*$/.exec(line);
    if (m) sections.push({ name: m[1], lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

function serializeIni(sections) {
  const lines = [];
  for (const s of sections) {
    if (s.name !== null) lines.push(`[${s.name}]`);
    lines.push(...s.lines);
  }
  return lines.join('\n');
}

function iniValues(section) {
  const values = {};
  for (const line of section ? section.lines : []) {
    const m = /^([^#=\s][^=]*?)\s*=(.*)$/.exec(line);
    if (m) values[m[1]] = m[2];
  }
  return values;
}

function setIniValue(section, key, value) {
  const i = section.lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) section.lines[i] = `${key}=${value}`;
  else section.lines.unshift(`${key}=${value}`);
}

function kwinFile(ctx) {
  return path.join(ctx.configHome, 'kwinrulesrc');
}

// Rule values KWin expects; see rules.kcfg. 1 = exact match, 2 = force,
// 3 = apply initially, types 1 = normal windows.
// A chosen monitor that is not connected keeps the position already in the rule.
function kwinRule(settings, display, have = {}) {
  const rule = { Description: `Airlock Browser, ${MANAGED}`, wmclass: WM_CLASS, wmclassmatch: '1', types: '1' };
  if (settings.captureKeys) Object.assign(rule, { disableglobalshortcuts: 'true', disableglobalshortcutsrule: '2' });
  if (display) Object.assign(rule, { position: `${display.bounds.x},${display.bounds.y}`, positionrule: '3' });
  else if (settings.display && have.position) Object.assign(rule, { position: have.position, positionrule: '3' });
  return rule;
}

function kwinRead(ctx) {
  const sections = parseIni(read(kwinFile(ctx)) || '');
  const general = sections.find((s) => s.name === 'General');
  const ids = (iniValues(general).rules || '').split(',').filter(Boolean);
  return { sections, general, ids, rule: sections.find((s) => s.name === KWIN_RULE) };
}

function kwinState(ctx, { settings, display }) {
  const { ids, rule } = kwinRead(ctx);
  if (!rule && !ids.includes(KWIN_RULE)) {
    return { state: 'missing', detail: 'KDE keeps its global shortcuts (Alt+Tab, Meta, …) while Airlock Browser has focus, and KWin picks the monitor.' };
  }
  const have = iniValues(rule);
  const want = kwinRule(settings, display, have);
  const same = rule && ids.includes(KWIN_RULE)
    && Object.keys(want).length === Object.keys(have).length
    && Object.entries(want).every(([k, v]) => have[k] === v);
  if (!same) return { state: 'outdated', detail: 'The rule does not match these settings.' };
  const does = [];
  if (settings.captureKeys) does.push('turns off KDE global shortcuts while Airlock Browser has focus');
  if (display) does.push(`opens Airlock Browser on ${display.name}`);
  else if (want.position) does.push(`opens Airlock Browser at ${want.position}, where ${settings.display} was`);
  return { state: 'ok', detail: does.length ? `In place: ${does.join(', ')}.` : 'In place, with nothing to do for these settings.' };
}

async function kwinReload(ctx) {
  await ctx.run('dbus-send', ['--session', '--type=method_call', '--dest=org.kde.KWin', '/KWin', 'org.kde.KWin.reconfigure']);
}

async function kwinApply(ctx, { settings, display }) {
  const { sections, general, ids } = kwinRead(ctx);
  let rule = sections.find((s) => s.name === KWIN_RULE);
  const lines = Object.entries(kwinRule(settings, display, iniValues(rule))).map(([k, v]) => `${k}=${v}`);
  if (rule) {
    rule.lines = [...lines, ''];
  } else {
    const last = sections[sections.length - 1];
    if (last.lines.length && last.lines[last.lines.length - 1] !== '') last.lines.push('');
    rule = { name: KWIN_RULE, lines: [...lines, ''] };
    sections.push(rule);
  }
  let gen = general;
  if (!gen) {
    gen = { name: 'General', lines: [''] };
    sections.push(gen);
  }
  if (!ids.includes(KWIN_RULE)) ids.push(KWIN_RULE);
  setIniValue(gen, 'rules', ids.join(','));
  setIniValue(gen, 'count', String(ids.length));
  write(kwinFile(ctx), serializeIni(sections));
  await kwinReload(ctx);
}

async function kwinRemove(ctx) {
  const { sections, general, ids } = kwinRead(ctx);
  const rest = ids.filter((id) => id !== KWIN_RULE);
  if (general) {
    setIniValue(general, 'rules', rest.join(','));
    setIniValue(general, 'count', String(rest.length));
  }
  write(kwinFile(ctx), serializeIni(sections.filter((s) => s.name !== KWIN_RULE)));
  await kwinReload(ctx);
}

// --- i3 --------------------------------------------------------------------

const I3_INCLUDE = /^[ \t]*include[ \t].*airlock-browser\.conf[ \t]*$/;
const I3_COMMENT = /^[ \t]*# Airlock Browser mode/;

function i3Paths(ctx) {
  const dir = path.join(ctx.configHome, 'i3');
  return { config: path.join(dir, 'config'), snippet: path.join(dir, 'airlock-browser.conf') };
}

function i3Snippet(mode) {
  return `# Written by the Airlock Browser settings; set it up again there instead of editing this file.
# In this mode i3 releases every binding except the escape hatch, so Alt+Tab,
# Alt+1..0 and friends reach the remote desktop. The Airlock Browser window enters the
# mode on focus and leaves it on blur; the binding is the manual way out.
mode "${mode}" {
        bindsym Ctrl+Mod1+Shift+Escape mode "default"
}

for_window [class="^${WM_CLASS}$"] border none
`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function i3State(ctx, { settings }) {
  const p = i3Paths(ctx);
  const conf = read(p.config);
  if (conf === null) return { state: 'unavailable', detail: `No i3 config at ${p.config}.` };
  const mode = settings.i3Mode;
  if (new RegExp(`^[ \\t]*mode[ \\t]+"${escapeRegExp(mode)}"`, 'm').test(conf)) {
    return { state: 'conflict', detail: `${p.config} defines mode "${mode}" itself. Remove that block and its for_window line, then set this up here.` };
  }
  const snippet = read(p.snippet);
  const included = conf.split('\n').some((l) => I3_INCLUDE.test(l));
  if (snippet === null && !included) {
    return { state: 'missing', detail: 'i3 keeps its Alt bindings while Airlock Browser has focus.' };
  }
  if (snippet !== i3Snippet(mode) || !included) return { state: 'outdated', detail: 'The i3 snippet does not match these settings.' };
  const modes = await ctx.run('i3-msg', ['-t', 'get_binding_modes']);
  if (!modes.ok || !modes.stdout.includes(`"${mode}"`)) {
    return { state: 'outdated', detail: 'Written, but the running i3 has not loaded it.' };
  }
  return { state: 'ok', detail: `In place: mode "${mode}" releases i3's bindings while Airlock Browser has focus. Ctrl+Alt+Shift+Escape leaves it.` };
}

async function i3Apply(ctx, opts) {
  const { state, detail } = await i3State(ctx, opts);
  if (state === 'conflict' || state === 'unavailable') throw new Error(detail);
  const p = i3Paths(ctx);
  write(p.snippet, i3Snippet(opts.settings.i3Mode));
  const conf = read(p.config);
  if (!conf.split('\n').some((l) => I3_INCLUDE.test(l))) {
    const sep = conf.endsWith('\n') ? '' : '\n';
    write(p.config, `${conf}${sep}\n# Airlock Browser mode, ${MANAGED}\ninclude ${p.snippet}\n`);
  }
  await ctx.run('i3-msg', ['reload']);
}

async function i3Remove(ctx) {
  const p = i3Paths(ctx);
  const conf = read(p.config);
  if (conf !== null) {
    const lines = conf.split('\n');
    const keep = lines.filter((l, i) => !I3_INCLUDE.test(l)
      && !(I3_COMMENT.test(l) && I3_INCLUDE.test(lines[i + 1] || '')));
    write(p.config, keep.join('\n').replace(/\n+$/, '\n'));
  }
  fs.rmSync(p.snippet, { force: true });
  await ctx.run('i3-msg', ['reload']);
}

// --- Desktop entries -------------------------------------------------------

// Desktop Entry Exec quoting.
function execArg(arg) {
  const a = arg.replace(/%/g, '%%');
  if (/^[\w/.,:+=@-]+$/.test(a)) return a;
  return `"${a.replace(/(["`$\\])/g, '\\$1')}"`;
}

function desktopEntry(exec) {
  return `[Desktop Entry]
Type=Application
Name=Airlock Browser
Comment=Locked-down browser window for one site or remote desktop
Exec=${exec.map(execArg).join(' ')}
Icon=airlock-browser
Terminal=false
Categories=Network;RemoteAccess;
StartupWMClass=${WM_CLASS}
`;
}

function entryPaths(ctx) {
  return {
    menu: path.join(ctx.dataHome, 'applications', 'airlock-browser.desktop'),
    autostart: path.join(ctx.configHome, 'autostart', 'airlock-browser.desktop'),
    icon: path.join(ctx.dataHome, 'icons', 'hicolor', 'scalable', 'apps', 'airlock-browser.svg'),
  };
}

const ENTRY_TEXT = {
  menu: { missing: 'Airlock Browser is not in the application menu.', ok: 'In the application menu' },
  autostart: { missing: 'Airlock Browser does not start at login.', ok: 'Starts at login' },
};

function entryState(ctx, which) {
  const have = read(entryPaths(ctx)[which]);
  if (have === null) return { state: 'missing', detail: ENTRY_TEXT[which].missing };
  if (have === desktopEntry(ctx.exec)) return { state: 'ok', detail: `${ENTRY_TEXT[which].ok}, running ${ctx.exec.join(' ')}.` };
  const exec = /^Exec=(.*)$/m.exec(have);
  return { state: 'outdated', detail: `Runs ${exec ? exec[1] : 'something else'}, not this copy.` };
}

function entryApply(ctx, which) {
  const p = entryPaths(ctx);
  write(p[which], desktopEntry(ctx.exec));
  if (which === 'menu' && ctx.iconSource) write(p.icon, fs.readFileSync(ctx.iconSource, 'utf8'));
}

function entryRemove(ctx, which) {
  const p = entryPaths(ctx);
  fs.rmSync(p[which], { force: true });
  if (which === 'menu') fs.rmSync(p.icon, { force: true });
}

// --- Items -----------------------------------------------------------------

async function items(ctx, opts) {
  const list = [];
  if (opts.wm === 'kde') list.push({ id: 'kwin', label: 'KWin window rule', ...kwinState(ctx, opts) });
  if (opts.wm === 'i3') list.push({ id: 'i3', label: 'i3 mode', ...(await i3State(ctx, opts)) });
  list.push({ id: 'menu', label: 'Application menu', ...entryState(ctx, 'menu') });
  list.push({ id: 'autostart', label: 'Start at login', ...entryState(ctx, 'autostart') });
  return list;
}

async function perform(ctx, id, action, opts) {
  const apply = action === 'apply';
  if (action !== 'apply' && action !== 'remove') throw new Error(`unknown action ${action}`);
  if (id === 'kwin') return apply ? kwinApply(ctx, opts) : kwinRemove(ctx);
  if (id === 'i3') return apply ? i3Apply(ctx, opts) : i3Remove(ctx);
  if (id === 'menu' || id === 'autostart') return apply ? entryApply(ctx, id) : entryRemove(ctx, id);
  throw new Error(`cannot ${action} ${id}`);
}

// After a settings change, rewrite the window-manager items the user already set up.
async function refresh(ctx, opts) {
  for (const item of await items(ctx, opts)) {
    if ((item.id === 'kwin' || item.id === 'i3') && item.state === 'outdated') await perform(ctx, item.id, 'apply', opts);
  }
}

module.exports = {
  WM_CLASS, KWIN_RULE, context, detectWm, items, perform, refresh,
  // For tests.
  kwinRule, i3Snippet, desktopEntry, parseIni, serializeIni, entryPaths, i3Paths, kwinFile,
};
