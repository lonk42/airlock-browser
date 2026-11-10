// Where Electron keeps its data for this run.
//
// - No profile: ~/.local/share/airlock-browser.
// - A named profile: ~/.local/share/airlock-browser/profiles/<profile>, so a
//   second profile has its own cookies, site data and single-instance lock.
// The app's own settings are in ~/.config/airlock-browser (config.js).
// - Kiosk: a private directory on the per-user tmpfs, emptied at start and
//   removed at quit. Every path Electron and Chromium write to is pointed into
//   it, so nothing reaches the disk.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'airlock-browser';

function dataHome(env) {
  return env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share');
}

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

function inMemory(dir, statfs = fs.statfsSync) {
  try {
    const { type } = statfs(dir);
    return type === TMPFS_MAGIC || type === RAMFS_MAGIC;
  } catch { return false; }
}

// The kiosk directory is fixed per profile rather than random, so Electron's
// single-instance lock (which lives in it) still finds a running copy.
// XDG_RUNTIME_DIR is normally a per-user tmpfs, but not always (a container
// may put it on disk), so the filesystem is checked and /dev/shm used instead.
// The shared /dev/shm and /tmp get the uid in the name.
function kioskDir(policy, env = process.env, uid = process.getuid(), statfs = fs.statfsSync) {
  const name = `${APP_NAME}-kiosk-${policy.profile || 'default'}`;
  if (env.XDG_RUNTIME_DIR && inMemory(env.XDG_RUNTIME_DIR, statfs)) return { dir: path.join(env.XDG_RUNTIME_DIR, name), memory: true };
  if (inMemory('/dev/shm', statfs)) return { dir: path.join('/dev/shm', `${name}-${uid}`), memory: true };
  return { dir: path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), env.XDG_RUNTIME_DIR ? name : `${name}-${uid}`), memory: false };
}

function userDataDir(policy, env = process.env) {
  if (policy.kiosk) return kioskDir(policy, env).dir;
  const base = path.join(dataHome(env), APP_NAME);
  return policy.profile ? path.join(base, 'profiles', policy.profile) : base;
}

// Creates the kiosk directory, refusing one that another user could have
// planted (a shared /tmp): it must be a real directory owned by us, mode 0700.
function makePrivateDir(dir, uid = process.getuid()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== uid) throw new Error(`${dir} is not a directory owned by this user.`);
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

// Subdirectories set as Electron paths; they must exist when setPath is called.
const SUBDIRS = { crashDumps: 'Crashpad', logs: 'logs', downloads: 'downloads', cache: 'xdg-cache', data: 'xdg-data' };

// Variables pointed into the kiosk directory for the whole process tree.
// Chromium hands its child processes the environment it started with, so
// these only reach the GPU process (shader caches), fontconfig and NSS (its
// certificate database in XDG_DATA_HOME/pki) if they are set before Electron
// starts: kioskEnv() says what to re-exec with.
const REDIRECTED = { XDG_CACHE_HOME: 'cache', XDG_DATA_HOME: 'data' };
const MARK = 'AIRLOCK_BROWSER_KIOSK_DIR';
const ORIGINAL = 'AIRLOCK_BROWSER_KIOSK_ORIGINAL_ENV';

// The environment to re-exec with, or null when this process already has it.
function kioskEnv(dir, env = process.env) {
  if (env[MARK] === dir) return null;
  const original = {};
  for (const k of Object.keys(REDIRECTED)) original[k] = env[k] === undefined ? null : env[k];
  const out = { ...env, [MARK]: dir, [ORIGINAL]: JSON.stringify(original) };
  for (const [k, sub] of Object.entries(REDIRECTED)) out[k] = path.join(dir, SUBDIRS[sub]);
  return out;
}

// The user's own environment, for anything that reads their files (the
// integration status) or runs their programs (download handlers).
function userEnv(env = process.env) {
  if (!env[ORIGINAL]) return env;
  const out = { ...env };
  let original = {};
  try { original = JSON.parse(env[ORIGINAL]); } catch { /* leave as is */ }
  for (const [k, v] of Object.entries(original)) {
    if (v === null) delete out[k]; else out[k] = v;
  }
  delete out[MARK];
  delete out[ORIGINAL];
  return out;
}

// Empties what an earlier run left when it could not clean up (SIGKILL,
// crash). Called once this run holds the single-instance lock, whose
// Singleton* files stay; the path subdirectories are emptied but kept.
function emptyDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const keep = new Set(Object.values(SUBDIRS));
  for (const name of names) {
    if (name.startsWith('Singleton')) continue;
    if (keep.has(name)) emptyDir(path.join(dir, name));
    else fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
}

// Chromium's network service still writes (its cache index, Network
// Persistent State) after the app's last event, and SIGKILL or a crash skips
// the events altogether. A detached shell waits for this PID to end and then
// removes the directory, unless a new instance has taken it over: the
// SingletonLock symlink names host-pid of the instance holding it.
const CLEANUP = `tail --pid="$1" -f /dev/null; sleep 2
lock=$(readlink "$2/SingletonLock" 2>/dev/null)
case "$lock" in ""|*-"$1") rm -rf -- "$2" ;; esac`;

function startCleanupWatcher(dir, spawn = require('child_process').spawn) {
  spawn('sh', ['-c', CLEANUP, `${APP_NAME}-kiosk-cleanup`, String(process.pid), dir], { detached: true, stdio: 'ignore' }).unref();
}

// Must run before app 'ready' and before requestSingleInstanceLock.
// Returns the kiosk directory, or null when the run keeps data as usual.
function apply(app, policy, env = process.env) {
  const dir = userDataDir(policy, env);
  if (!dir) return null;
  if (!policy.kiosk) {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
    return null;
  }
  if (!kioskDir(policy, env).memory) {
    console.error(`${APP_NAME}: no tmpfs found for kiosk data; using ${dir}, which is on disk. It is removed at quit.`);
  }
  makePrivateDir(dir);
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);
  for (const sub of Object.values(SUBDIRS)) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
  for (const name of ['crashDumps', 'logs', 'downloads']) app.setPath(name, path.join(dir, SUBDIRS[name]));
  app.commandLine.appendSwitch('disk-cache-dir', path.join(dir, 'cache'));
  return dir;
}

module.exports = { CLEANUP, startCleanupWatcher, inMemory, kioskDir, kioskEnv, userEnv, userDataDir, makePrivateDir, emptyDir, removeDir, apply };
