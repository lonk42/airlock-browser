// The --config file: a YAML policy that turns the personal app into a managed
// or kiosk one. Without --config every value here is the built-in default and
// the app behaves as it always has.
//
// Validation is strict: an unknown key or a wrong type is an error, and an
// error stops the app (see main.js), so a typo in a kiosk config cannot
// quietly leave a kiosk unlocked.
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const config = require('./config');
const origins = require('./origins');

const SETTING_KEYS = Object.keys(config.DEFAULTS).filter((k) => k !== 'i3Mode');
const KEY_NAMES = ['quit', 'reload', 'settings', 'bar'];

class PolicyError extends Error {}

// The value of --config in argv, as `--config path` or `--config=path`.
// Chromium ignores switches it does not know, so the flag is safe to pass through.
function configArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new PolicyError('--config needs a file path.');
      return argv[i + 1];
    }
    if (a.startsWith('--config=')) {
      if (a.length === '--config='.length) throw new PolicyError('--config needs a file path.');
      return a.slice('--config='.length);
    }
  }
  return null;
}

// --- Checks ------------------------------------------------------------------

function where(at) { return at.length ? at.join('.') : 'the file'; }

function fail(at, text) { throw new PolicyError(`${where(at)}: ${text}`); }

function isMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function map(v, at, keys) {
  if (!isMap(v)) fail(at, 'must be a mapping.');
  for (const k of Object.keys(v)) {
    if (!keys.includes(k)) fail([...at, k], `unknown key. Known keys: ${keys.join(', ')}.`);
  }
  return v;
}

function bool(v, at) {
  if (typeof v !== 'boolean') fail(at, 'must be true or false.');
  return v;
}

function str(v, at, re, hint) {
  if (typeof v !== 'string' || !v.trim()) fail(at, 'must be a non-empty string.');
  if (re && !re.test(v)) fail(at, hint);
  return v.trim();
}

function oneOf(v, at, values) {
  if (!values.includes(v)) fail(at, `must be one of ${values.join(', ')}.`);
  return v;
}

function list(v, at, each) {
  if (!Array.isArray(v)) fail(at, 'must be a list.');
  return v.map((x, i) => each(x, [...at, String(i)]));
}

// --- Defaults ------------------------------------------------------------------

// What the app does with no --config. Kiosk mode changes several of these,
// and the file can override any of them except where noted in docs/config.md.
function defaults(kiosk) {
  return {
    file: null,
    kiosk,
    profile: null,
    title: 'Airlock Browser',
    settings: {},
    lock: kiosk ? [...SETTING_KEYS] : [],
    settingsPage: !kiosk,
    integration: kiosk ? 'report' : 'manage',
    keys: { quit: true, reload: true, settings: !kiosk, bar: true }, // settings follows settingsPage unless set
    bar: 'auto',
    downloads: null, // null: Electron's own (a save dialog); kiosk: none
    media: { screenPicker: false, hardwareVideo: false },
    launcher: { windowMode: null }, // null: settings.windowMode
    toolbar: { security: true, fullscreen: true, navigation: false }, // the kiosk toolbar's security chip, full-screen switch, and Home and Back on a desktop
    navigation: {
      allow: [],
      auth: [],
      desktops: null, // null: the origin of settings.url
      offsite: kiosk ? 'block' : 'browser',
    },
    tls: {
      pin: null, // null: the host of settings.url
      ca: [], // { file, pem } per certificate
      insecure: [],
    },
  };
}

function patterns(v, at, parser = origins.parse) {
  return list(v, at, (x, a) => {
    if (typeof x !== 'string') fail(a, 'must be a string.');
    try { return parser(x); } catch (err) {
      if (err instanceof origins.PatternError) fail(a, err.message);
      throw err;
    }
  });
}

// PEM certificates in a CA file, relative paths from the config file's directory.
function readCa(file, at, base) {
  const full = path.resolve(base, file);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (err) {
    fail(at, `cannot read ${full}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
  }
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!pems.length) fail(at, `${full} has no PEM certificate.`);
  return pems.map((pem) => ({ file: full, pem }));
}

// --- Parse ---------------------------------------------------------------------

function parse(text, file = null, base = file ? path.dirname(file) : process.cwd()) {
  // Plain YAML only: an unknown tag (such as !!js/function) is an error rather
  // than a warning, and << is an ordinary key, so it is reported as unknown.
  const parsed = YAML.parseDocument(text, { prettyErrors: true, uniqueKeys: true, merge: false });
  const problem = parsed.errors[0] || parsed.warnings[0];
  if (problem) throw new PolicyError(`not valid YAML: ${problem.message}`);
  const doc = parsed.toJS();
  map(doc, [], ['version', 'kiosk', 'profile', 'title', 'settings', 'lock', 'settingsPage', 'integration', 'keys', 'navigation', 'tls', 'bar', 'downloads', 'media', 'launcher', 'toolbar']);
  if (doc.version !== 1) fail(['version'], 'must be 1.');

  const kiosk = doc.kiosk === undefined ? false : bool(doc.kiosk, ['kiosk']);
  const p = defaults(kiosk);
  p.file = file;

  if (doc.profile !== undefined) {
    p.profile = str(doc.profile, ['profile'], /^[a-z0-9][a-z0-9-]{0,31}$/,
      'use 1 to 32 lowercase letters, digits and dashes, starting with a letter or digit.');
  }
  if (doc.title !== undefined) p.title = str(doc.title, ['title']);

  if (doc.settings !== undefined) {
    const s = map(doc.settings, ['settings'], SETTING_KEYS);
    if (s.url !== undefined) {
      const url = str(s.url, ['settings', 'url']);
      const err = config.validate({ url }).url;
      if (err) fail(['settings', 'url'], err);
      p.settings.url = url;
    }
    if (s.display !== undefined) {
      if (typeof s.display !== 'string') fail(['settings', 'display'], 'must be an output name such as DP-2, or "".');
      p.settings.display = s.display;
    }
    if (s.secondDisplay !== undefined) {
      p.settings.secondDisplay = str(s.secondDisplay, ['settings', 'secondDisplay'], /^\S+$/,
        'must be auto, none or an output name such as DP-2.');
    }
    if (s.windowMode !== undefined) p.settings.windowMode = oneOf(s.windowMode, ['settings', 'windowMode'], config.WINDOW_MODES);
    if (s.captureKeys !== undefined) p.settings.captureKeys = bool(s.captureKeys, ['settings', 'captureKeys']);
  }

  if (doc.lock !== undefined) {
    if (doc.lock === 'all') p.lock = [...SETTING_KEYS];
    else if (doc.lock === 'none') p.lock = [];
    else p.lock = list(doc.lock, ['lock'], (k, at) => oneOf(k, at, SETTING_KEYS));
  }
  if (doc.settingsPage !== undefined) p.settingsPage = bool(doc.settingsPage, ['settingsPage']);
  if (doc.integration !== undefined) p.integration = oneOf(doc.integration, ['integration'], ['manage', 'report']);

  p.keys.settings = p.settingsPage;
  if (doc.keys !== undefined) {
    const k = map(doc.keys, ['keys'], KEY_NAMES);
    for (const name of KEY_NAMES) if (k[name] !== undefined) p.keys[name] = bool(k[name], ['keys', name]);
  }

  if (doc.bar !== undefined) p.bar = oneOf(doc.bar, ['bar'], ['auto', 'always', 'never']);
  if (doc.bar === 'never' && (doc.keys || {}).bar === undefined) p.keys.bar = false;

  if (doc.downloads !== undefined) {
    const d = map(doc.downloads, ['downloads'], ['handlers', 'dir', 'quit']);
    const out = { handlers: {}, dir: null, quit: 'never' };
    if (d.handlers !== undefined) {
      for (const [ext, argv] of Object.entries(map(d.handlers, ['downloads', 'handlers'], Object.keys(d.handlers)))) {
        const at = ['downloads', 'handlers', ext];
        if (!/^[a-z0-9]{1,16}$/.test(ext)) fail(at, 'use a lowercase file extension without the dot.');
        out.handlers[ext] = argv === null ? null : list(argv, at, (a, i) => str(a, i));
        if (out.handlers[ext] && !out.handlers[ext].length) fail(at, 'needs a program, or null to save the file only.');
      }
    }
    if (d.dir !== undefined) {
      const dir = str(d.dir, ['downloads', 'dir']);
      out.dir = dir === '~' || dir.startsWith('~/') ? path.join(require('os').homedir(), dir.slice(1)) : path.resolve(base, dir);
    }
    if (d.quit !== undefined) out.quit = oneOf(d.quit, ['downloads', 'quit'], ['never', 'download', 'handler']);
    if (out.quit === 'handler' && !Object.values(out.handlers).some(Boolean)) {
      fail(['downloads', 'quit'], 'is handler, but no handler runs a program.');
    }
    p.downloads = out;
  } else if (kiosk) {
    p.downloads = { handlers: {}, dir: null, quit: 'never' };
  }

  if (doc.media !== undefined) {
    const m = map(doc.media, ['media'], ['screenPicker', 'hardwareVideo']);
    for (const k of ['screenPicker', 'hardwareVideo']) if (m[k] !== undefined) p.media[k] = bool(m[k], ['media', k]);
  }

  if (doc.launcher !== undefined) {
    const l = map(doc.launcher, ['launcher'], ['windowMode']);
    if (l.windowMode !== undefined) p.launcher.windowMode = oneOf(l.windowMode, ['launcher', 'windowMode'], config.WINDOW_MODES);
  }

  if (doc.toolbar !== undefined) {
    const t = map(doc.toolbar, ['toolbar'], ['security', 'fullscreen', 'navigation']);
    for (const k of ['security', 'fullscreen', 'navigation']) if (t[k] !== undefined) p.toolbar[k] = bool(t[k], ['toolbar', k]);
  }

  if (doc.navigation !== undefined) {
    const n = map(doc.navigation, ['navigation'], ['allow', 'auth', 'desktops', 'offsite']);
    for (const k of ['allow', 'auth', 'desktops']) {
      if (n[k] !== undefined) p.navigation[k] = patterns(n[k], ['navigation', k]);
    }
    if (n.offsite !== undefined) p.navigation.offsite = oneOf(n.offsite, ['navigation', 'offsite'], ['browser', 'block']);
  }

  if (doc.tls !== undefined) {
    const t = map(doc.tls, ['tls'], ['pin', 'ca', 'insecure']);
    if (t.pin !== undefined) p.tls.pin = patterns(t.pin, ['tls', 'pin'], origins.parseHostPattern);
    if (t.insecure !== undefined) p.tls.insecure = patterns(t.insecure, ['tls', 'insecure'], origins.parseHostPattern);
    if (t.ca !== undefined) {
      p.tls.ca = list(t.ca, ['tls', 'ca'], (f, at) => readCa(str(f, at), at, base)).flat();
    }
  }

  // Without the settings page nothing can ask for the address.
  if (!p.settings.url && (kiosk || doc.settingsPage === false || p.lock.includes('url'))) {
    const why = kiosk ? 'kiosk is true' : doc.settingsPage === false ? 'settingsPage is false' : 'url is locked';
    fail(['settings', 'url'], `is required when ${why}.`);
  }
  if (!p.settingsPage) p.keys.settings = false;
  return p;
}

// Loads the --config named in argv, or the defaults when there is none.
// Throws PolicyError with a message fit to show the user.
function load(argv, cwd = process.cwd()) {
  const arg = configArg(argv);
  if (arg === null) return defaults(false);
  const file = path.resolve(cwd, arg);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new PolicyError(`cannot read ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
  }
  try {
    return parse(text, file);
  } catch (err) {
    if (err instanceof PolicyError) throw new PolicyError(`${file}: ${err.message}`);
    throw err;
  }
}

// --- Settings ----------------------------------------------------------------

// The settings for this run: the file's values, then the user's saved ones for
// anything not locked. A kiosk reads nothing from the user's dot files.
function settings(policy, env = process.env) {
  const dir = settingsDir(policy, env);
  const fromFile = policy.settings;
  if (policy.kiosk) {
    return { settings: config.normalize({ ...config.DEFAULTS, ...fromFile }), firstRun: false, dir: null };
  }
  const saved = config.load(env, dir);
  const merged = { ...saved.settings };
  for (const [k, v] of Object.entries(fromFile)) {
    if (saved.firstRun || policy.lock.includes(k)) merged[k] = v;
  }
  for (const k of policy.lock) if (fromFile[k] === undefined) merged[k] = config.DEFAULTS[k];
  // An address from the file is enough to connect without the first-run page.
  return { settings: config.normalize(merged), firstRun: saved.firstRun && !fromFile.url, dir };
}

// Where the user's settings.json lives: the usual place for the default
// profile, a subdirectory for a named one.
function settingsDir(policy, env = process.env) {
  if (policy.kiosk) return null;
  const base = config.dir(env);
  return policy.profile ? path.join(base, 'profiles', policy.profile) : base;
}

// Drops locked keys from a settings form, so the user cannot change them
// whatever the page sends.
function unlocked(policy, input, current) {
  const out = { ...input };
  for (const k of policy.lock) out[k] = current[k];
  return out;
}

module.exports = {
  PolicyError, SETTING_KEYS, KEY_NAMES, configArg, parse, load, defaults, settings, settingsDir, unlocked,
};
