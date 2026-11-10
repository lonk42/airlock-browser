// Settings in ~/.config/airlock-browser/settings.json, written by the settings
// page. Electron's own data (cookies, site data) is in ~/.local/share/airlock-browser;
// see storage.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'airlock-browser';

const DEFAULTS = Object.freeze({
  url: '', // Empty until the first-run settings page or a config file sets it.
  display: '', // Output name, e.g. DP-2. Empty leaves placement to the window manager.
  // A selkies desktop's second monitor: 'auto', 'none' or an output name. X11 only.
  secondDisplay: 'auto',
  windowMode: 'normal',
  captureKeys: true,
  i3Mode: APP_NAME,
});
const WINDOW_MODES = ['normal', 'maximized', 'fullscreen'];

function dir(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, APP_NAME);
}

function urlError(url) {
  if (!url) return 'Enter an address.';
  let parsed;
  try { parsed = new URL(url); } catch { return 'Not a valid address.'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'Use an https:// or http:// address.';
  return null;
}

function normalize(input) {
  const s = { ...DEFAULTS };
  if (!input || typeof input !== 'object') return s;
  if (typeof input.url === 'string' && !urlError(input.url.trim())) s.url = input.url.trim();
  if (typeof input.display === 'string') s.display = input.display;
  if (typeof input.secondDisplay === 'string' && input.secondDisplay) s.secondDisplay = input.secondDisplay;
  if (WINDOW_MODES.includes(input.windowMode)) s.windowMode = input.windowMode;
  if (typeof input.captureKeys === 'boolean') s.captureKeys = input.captureKeys;
  // The name goes into the i3 config between double quotes.
  if (typeof input.i3Mode === 'string' && /^[^"\\\n]+$/.test(input.i3Mode.trim())) s.i3Mode = input.i3Mode.trim();
  return s;
}

// Field name to message, empty when the input can be saved.
function validate(input) {
  const errors = {};
  const url = input && typeof input.url === 'string' ? input.url.trim() : '';
  const err = urlError(url);
  if (err) errors.url = err;
  return errors;
}

// firstRun is true until settings.json exists, or while it has no address.
// A named profile passes its own directory.
function load(env = process.env, from = dir(env)) {
  try {
    const settings = normalize(JSON.parse(fs.readFileSync(path.join(from, 'settings.json'), 'utf8')));
    return { settings, firstRun: !settings.url };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`${APP_NAME}: ignoring unreadable settings.json: ${err.message}`);
    return { settings: { ...DEFAULTS }, firstRun: true };
  }
}

// Unknown or invalid fields fall back to defaults; call validate() first to report them.
function save(input, env = process.env, to = dir(env)) {
  const settings = normalize(input);
  const file = path.join(to, 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
  return settings;
}

module.exports = { APP_NAME, DEFAULTS, WINDOW_MODES, dir, load, save, validate, normalize };
