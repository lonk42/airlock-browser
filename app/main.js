// Airlock Browser: a locked-down browser window for one site or remote desktop,
// such as a selkies desktop (dailytop, webtop), a Coder dashboard or a Citrix portal.
// Chromium engine, no browser chrome, no accelerators: every key sequence the
// window manager lets through is delivered straight to the page.
// Settings, and the window-manager integration, live in an overlay opened with
// Ctrl+Alt+Shift+S, shown by itself on first run.
const path = require('path');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const {
  app, BrowserWindow, WebContentsView, Menu, Notification, desktopCapturer, dialog, ipcMain, screen, session, shell,
  webContents: allContents,
} = require('electron');
const config = require('./config');
const integration = require('./integration');
const policyFile = require('./policy');
const storage = require('./storage');
const origins = require('./origins');
const tls = require('./tls');
const downloads = require('./downloads');

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30000;
// The app's mark on its own pages: the arched door from icon.svg, drawn even-odd so the seam is a gap.
const MARK_PATH = 'M5 20.5v-10a7 7 0 0 1 14 0v10zM11.3 6v14.5h1.4V6z';
const TOOLBAR_HEIGHT = 38; // Must match #root.toolbar #panel in bar.css.

app.setName('airlock-browser'); // Window class and app ID; storage.js sets the data dir.
Menu.setApplicationMenu(null);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// The --config policy. A bad file stops the app with an error window and keeps
// no data, as a kiosk would, since nothing says this run is allowed more.
let policy;
let policyError = null;
try {
  policy = policyFile.load(process.argv);
} catch (err) {
  if (!(err instanceof policyFile.PolicyError)) throw err;
  policyError = err.message;
  // A kiosk directory of its own, so quitting cannot remove a running kiosk's.
  policy = { ...policyFile.defaults(true), profile: `error-${process.pid}` };
}

let { settings, firstRun, dir: settingsDir } = policyError
  ? { settings: { ...config.DEFAULTS }, firstRun: false, dir: null }
  : policyFile.settings(policy);
// AIRLOCK_BROWSER_URL overrides the saved address for this run only, unless the policy locks it.
const envUrl = (process.env.AIRLOCK_BROWSER_URL || '').trim();
const urlOverride = envUrl && !policy.lock.includes('url') && !config.validate({ url: envUrl }).url ? envUrl : '';
const target = () => urlOverride || settings.url;

// Where pages may go. The origin of the address is always allowed, and is the
// desktop unless navigation.desktops names others. Desktops get the
// permissions selkies needs; login providers (navigation.auth) and the other
// allowed origins only navigate.
function nav() {
  // No address yet on a first run: nothing is allowed until the settings set one.
  const start = target() ? origins.fromUrl(target()) : null;
  const n = policy.navigation;
  const desktops = n.desktops || (start ? [start] : []);
  const all = [...(start ? [start] : []), ...desktops, ...n.allow, ...n.auth];
  return {
    desktop: (url) => origins.matchesAny(desktops, url),
    auth: (url) => origins.matchesAny(n.auth, url),
    allowed: (url) => origins.matchesAny(all, url),
  };
}

// An address no rule allows: the default browser, or nowhere in a kiosk.
// Only web addresses are handed out; a page cannot open file: or smb: links this way.
function offsite(url) {
  if (policy.navigation.offsite === 'browser' && origins.isWeb(url)) {
    shell.openExternal(url);
  } else {
    console.error(`airlock-browser: blocked ${url}`);
  }
}

// The argv that starts this copy, for the desktop entries, with the same --config.
function launchCommand() {
  const conf = policy.file ? ['--config', policy.file] : [];
  if (process.env.APPIMAGE) return [process.env.APPIMAGE, ...conf];
  if (app.isPackaged) return [process.execPath, ...conf];
  return [process.execPath, app.getAppPath(), ...conf];
}

const ctx = integration.context({ env: storage.userEnv(), exec: launchCommand(), iconSource: path.join(__dirname, 'icon.svg') });
let wm = null; // 'kde', 'i3' or null, detected once at startup.
const wayland = () => app.commandLine.getSwitchValue('ozone-platform') === 'wayland'
  || (!process.env.DISPLAY && !!process.env.WAYLAND_DISPLAY);

let overlay = null;
let overlayHost = null; // The window the settings overlay is open in.
let started = false; // The desktop is not loaded until first-run settings are closed.
let quitting = false;

// --- TLS -------------------------------------------------------------------
// The container's certificate is self-signed and regenerated on rebuild, so it
// cannot be pinned ahead of time. By default the first certificate the
// address's host shows in this run is pinned; Ctrl+Alt+Shift+R accepts a
// replacement. tls.ca and tls.insecure add other ways in; see tls.js.

let certs = null;

function tlsPolicy() {
  const t = policy.tls;
  const pin = t.pin || (target() ? [origins.parseHostPattern(new URL(target()).hostname)] : []);
  return { ...t, pin };
}

// Setting the proc again also drops Chromium's cached verifications.
function repin() {
  certs = tls.verifier(tlsPolicy());
  session.defaultSession.setCertificateVerifyProc(certs.verify);
}

// --- i3 --------------------------------------------------------------------
// The mode is toggled while the window holds focus, so $mod (Alt) combos reach
// the desktop. Only used once the settings report the mode as in place.

let i3Capture = false;
let i3Current = null;
let i3Watchdog = false;

function setI3Mode(mode) {
  if (i3Current === mode || (!i3Capture && mode !== 'default')) return;
  i3Current = mode;
  execFile('i3-msg', ['mode', mode], () => {});
}

// If this process dies without resetting the mode (SIGKILL, crash), i3 is left
// with only the escape binding. A detached shell outlives us and resets it.
function startI3Watchdog() {
  if (i3Watchdog) return;
  i3Watchdog = true;
  const script = 'tail --pid="$1" -f /dev/null; i3-msg -t get_binding_state | grep -qF "\\"$2\\"" && i3-msg mode default';
  spawn('sh', ['-c', script, 'airlock-browser-i3-watchdog', String(process.pid), settings.i3Mode],
    { detached: true, stdio: 'ignore' }).unref();
}

// --- Placement -------------------------------------------------------------

async function listDisplays() {
  if (wm === 'i3') {
    const r = await ctx.run('i3-msg', ['-t', 'get_outputs']);
    try {
      return JSON.parse(r.stdout).filter((o) => o.active)
        .map((o) => ({ name: o.name, bounds: { x: o.rect.x, y: o.rect.y, width: o.rect.width, height: o.rect.height } }));
    } catch { return []; }
  }
  // On Wayland the label is the output name KDE shows, e.g. DP-2.
  return screen.getAllDisplays().map((d) => ({ name: d.label || String(d.id), bounds: d.bounds }));
}

async function chosenDisplay() {
  return settings.display ? (await listDisplays()).find((d) => d.name === settings.display) || null : null;
}

// Monitor choice: the KWin rule under KDE, i3-msg under i3, setBounds on other
// X11 window managers. Other Wayland compositors give apps no say.
async function placeWindow(rec) {
  const display = await chosenDisplay();
  if (!display) return;
  if (wm === 'i3') {
    await ctx.run('i3-msg', [`[class="^${integration.WM_CLASS}$"] move container to output ${display.name}, focus`]);
  } else if (wm !== 'kde' && !wayland()) {
    rec.win.setBounds(display.bounds);
  }
}

// --- Integration state -----------------------------------------------------

async function integrationItems() {
  return integration.items(ctx, { wm, settings, display: await chosenDisplay() });
}

async function refreshCapture() {
  const items = await integrationItems();
  const ok = (id) => items.some((i) => i.id === id && i.state === 'ok');
  const wasI3 = i3Capture;
  i3Capture = wm === 'i3' && settings.captureKeys && ok('i3');
  if (i3Capture) {
    startI3Watchdog();
    if (BrowserWindow.getFocusedWindow()) setI3Mode(settings.i3Mode);
  } else if (wasI3) {
    setI3Mode('default');
  }
  return items;
}

function warn(text) {
  console.error(`airlock-browser: ${text}`);
  if (Notification.isSupported()) new Notification({ title: 'Airlock Browser', body: text }).show();
}

// --- Window ----------------------------------------------------------------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// The escape keys this run allows, for status pages.
function keyHints() {
  const hints = [];
  if (policy.keys.reload) hints.push('Ctrl+Alt+Shift+R retries now');
  if (policy.keys.settings) hints.push('Ctrl+Alt+Shift+S opens settings');
  if (policy.keys.quit) hints.push('Ctrl+Alt+Shift+Q quits');
  return hints.length ? `${hints.join(', ')}.` : '';
}

function statusPage(text, hints = keyHints()) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><title>${escapeHtml(policy.title)}</title>`
    + '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;'
    + 'background:#17191c;color:#d7dade;font:15px/1.5 \'Segoe UI\',\'Noto Sans\',system-ui,sans-serif">'
    + '<div style="max-width:40em;background:#202326;border-radius:12px;padding:22px 26px;display:flex;gap:16px;align-items:flex-start;'
    + 'box-shadow:0 16px 48px rgba(0,0,0,.5)">'
    + `<svg viewBox="0 0 24 24" style="width:28px;height:28px;flex:none;fill:#1f86d6" aria-hidden="true"><path fill-rule="evenodd" d="${MARK_PATH}"/></svg>`
    + `<p style="margin:2px 0 0;white-space:pre-wrap">${escapeHtml(text)}`
    + `${hints ? `<br><br><span style="color:#8b939c;font-size:13px">${escapeHtml(hints)}</span>` : ''}</p></div></body>`);
}

// --- Windows -----------------------------------------------------------------
// The launcher loads the address. Each desktop origin other than the
// launcher's own gets a window of its own the first time a page opens it, and
// is brought to the front after that. A window keeps navigation to its own
// origin in place, so a login round trip through another allowed origin
// (Coder's app sign-in goes through the dashboard) stays in that window.

const windows = new Set(); // { win, page, home, launcher, toolbar, url, retryDelay, retryTimer }
let launcher = null;
let lastFocused = null;

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function desktopWindows() {
  return [...windows].filter((r) => !r.launcher);
}

function recordOf(contents) {
  for (const r of windows) if (r.page === contents) return r;
  return null;
}

function show(rec) {
  if (rec.win.isMinimized()) rec.win.restore();
  if (!rec.win.isVisible()) rec.win.show();
  rec.win.focus();
}

function load(rec, url = rec.home) {
  clearTimeout(rec.retryTimer);
  rec.url = url;
  started = true;
  rec.page.loadURL(url).catch(() => {}); // Failures are handled in did-fail-load.
}

// Where a link or window.open from a page goes, other than a login popup.
function openUrl(rec, url) {
  const rules = nav();
  if (!rules.allowed(url)) { offsite(url); return; }
  const origin = originOf(url);
  if (origin === originOf(rec.home)) { load(rec, url); return; }
  if (rules.desktop(url)) { openDesktop(url); return; }
  // Any other allowed page belongs to the launcher.
  show(launcher);
  load(launcher, url);
}

function openDesktop(url) {
  const origin = originOf(url);
  if (launcher && originOf(launcher.home) === origin) { show(launcher); return; }
  const existing = desktopWindows().find((r) => originOf(r.home) === origin);
  if (existing) { show(existing); return; }
  const rec = createWindow(url, false);
  load(rec, url);
}

// The escape keys act on the window they were pressed in.
function handleKeys(event, input) {
  if (input.type !== 'keyDown' || !input.control || !input.alt || !input.shift) return;
  const key = input.key.toLowerCase();
  const rec = recordOf(event.sender) || lastFocused || launcher;
  if (key === 'q' && policy.keys.quit) {
    event.preventDefault();
    app.quit();
  } else if (key === 'r' && policy.keys.reload && !policyError && rec) {
    event.preventDefault();
    rec.retryDelay = RETRY_MIN_MS;
    repin();
    load(rec, rec.url || rec.home);
  } else if (key === 's' && policy.keys.settings && rec) {
    event.preventDefault();
    if (overlay) closeSettings(); else openSettings(rec);
  } else if (key === 'b' && policy.keys.bar && rec && rec.bar && rec.bar.getVisible()) {
    event.preventDefault();
    rec.bar.webContents.focus();
    rec.bar.webContents.send('bar:toggle');
  }
}

// --- Bar -----------------------------------------------------------------------
// A drop-down bar at the top centre of each window: a handle until hovered or
// opened with Ctrl+Alt+Shift+B, then the window actions. bar: auto shows it
// on windows without decorations (fullscreen, maximised, or under i3 only in
// fullscreen), so a window can always be left without knowing the keys.
//
// In kiosk mode every window has no decorations. Not full screen, it has the
// same bar as a fixed toolbar above the page instead, so no window-manager
// title bar shows; full screen, the drop-down. The bar switches a window
// between the two (toolbar.fullscreen).

function toolbarFor() {
  return policy.kiosk && policy.bar !== 'never';
}

const toolbarShown = (rec) => rec.toolbar && !rec.win.isFullScreen();

function barWanted(rec) {
  if (policy.bar === 'never') return false;
  if (policy.bar === 'always' || toolbarShown(rec)) return true;
  return rec.win.isFullScreen() || (!rec.frame && wm !== 'i3');
}

// Lays out the bar and, in a toolbar window, the page below it. The bar's
// view grows over the page only while its Windows menu is open.
function positionBar(rec) {
  const [w, h] = rec.win.getContentSize();
  if (rec.pageView) {
    const top = toolbarShown(rec) ? TOOLBAR_HEIGHT : 0;
    rec.pageView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
  }
  if (!rec.bar) return;
  if (toolbarShown(rec)) {
    rec.bar.setBounds({ x: 0, y: 0, width: w, height: Math.max(TOOLBAR_HEIGHT, Math.min(rec.barSize.height, h)) });
    return;
  }
  const width = Math.min(rec.barSize.width, w);
  rec.bar.setBounds({ x: Math.round((w - width) / 2), y: 0, width, height: rec.barSize.height });
}

function updateBar(rec) {
  if (!rec.bar) return;
  rec.bar.setVisible(barWanted(rec));
  positionBar(rec);
  pushBars();
}

function createBar(rec) {
  if (policy.bar === 'never') return;
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'bar-preload.js'), spellcheck: false },
  });
  view.setBackgroundColor('#00000000');
  rec.bar = view;
  rec.barSize = rec.toolbar ? { width: 0, height: TOOLBAR_HEIGHT } : { width: 72, height: 14 };
  rec.win.contentView.addChildView(view);
  view.webContents.on('before-input-event', handleKeys);
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.loadFile(path.join(__dirname, 'bar.html'));
  updateBar(rec);
}

let barIds = 0;

// The toolbar's security chip for the page in a window: green when the
// certificate is trusted (verified, or pinned and unchanged), amber for plain
// http, a tls.insecure host or a pinned certificate that changed. Nothing for
// a status page or before the host has connected.
function securityOf(rec) {
  if (!toolbarShown(rec) || !policy.toolbar.security) return null;
  let url;
  try { url = new URL(rec.page.getURL()); } catch { return null; }
  if (url.protocol === 'http:') return { level: 'warn', label: 'Not secure', hint: 'The connection is not encrypted (http).' };
  if (url.protocol !== 'https:' || !certs) return null;
  if (certs.changed(url.hostname)) {
    return { level: 'warn', label: 'Certificate changed', hint: `The certificate of ${url.hostname} changed since this window connected.` };
  }
  switch (certs.trust(url.hostname)) {
    case 'verified': return { level: 'ok', label: 'Secure', hint: `Verified certificate for ${url.hostname}.` };
    case 'pinned': return { level: 'ok', label: 'Secure', hint: `Certificate of ${url.hostname} trusted on first connection in this session.` };
    case 'insecure': return { level: 'warn', label: 'Not verified', hint: `The certificate of ${url.hostname} is not checked (tls.insecure).` };
    default: return null;
  }
}

function barState(rec) {
  const { win } = rec;
  const homeIsDesktop = nav().desktop(rec.home);
  const fullscreenLocked = policy.lock.includes('windowMode');
  return {
    toolbar: toolbarShown(rec),
    brand: policy.title,
    security: securityOf(rec),
    title: win.getTitle(),
    // From a desktop window, the launcher; in the launcher, its own address.
    home: !rec.launcher && launcher
      ? { label: policy.title, hint: `Show ${launcher.win.getTitle()}`, leaves: true }
      : rec.launcher && !homeIsDesktop ? { label: 'Home', hint: rec.home } : null,
    // null: no Back here; false: nothing to go back to (the toolbar greys it out).
    back: rec.launcher && !homeIsDesktop ? rec.page.navigationHistory.canGoBack() : null,
    windows: [...windows].filter((r) => r.win.isVisible() || r === launcher).map((r) => ({
      id: r.id, title: r.win.getTitle(), url: r.url || r.home, current: r === rec,
    })),
    reload: policy.keys.reload,
    // A kiosk window switches between full screen and the toolbar for this run
    // only, so a locked windowMode does not stop it.
    fullscreen: rec.toolbar && policy.toolbar.fullscreen ? (win.isFullScreen() ? 'leave' : 'enter')
      : win.isFullScreen() ? (fullscreenLocked && windowModeOf(rec.launcher) === 'fullscreen' ? null : 'leave')
        : (fullscreenLocked ? null : 'enter'),
    settings: policy.settingsPage,
    // A toolbar window has no decorations, so the toolbar maximises it.
    maximize: toolbarShown(rec) ? (win.isMaximized() ? 'restore' : 'maximize') : null,
    close: !rec.launcher,
    quit: policy.keys.quit,
  };
}

function pushBars() {
  for (const r of windows) {
    if (r.bar && !r.bar.webContents.isDestroyed()) r.bar.webContents.send('bar:state', barState(r));
  }
}

function barAct(rec, action, arg) {
  const { win, page } = rec;
  const focusPage = () => page.focus();
  switch (action) {
    case 'home':
      if (!rec.launcher && launcher) show(launcher);
      else if (rec.launcher) { load(rec); focusPage(); }
      break;
    case 'back':
      if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
      focusPage();
      break;
    case 'switch': {
      const target = [...windows].find((r) => r.id === arg);
      if (target) show(target);
      break;
    }
    case 'reload':
      if (!policy.keys.reload) break;
      rec.retryDelay = RETRY_MIN_MS;
      repin();
      load(rec, rec.url || rec.home);
      focusPage();
      break;
    case 'fullscreen': {
      const s = barState(rec).fullscreen;
      if (s === 'leave') win.setFullScreen(false);
      else if (s === 'enter') win.setFullScreen(true);
      focusPage();
      break;
    }
    case 'settings':
      if (policy.settingsPage) openSettings(rec);
      break;
    case 'maximize':
      if (!toolbarShown(rec)) break;
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
      focusPage();
      break;
    case 'close':
      if (!rec.launcher) win.close();
      break;
    case 'quit':
      if (policy.keys.quit) app.quit();
      break;
    case 'focus-page':
      if (!overlay || overlayHost !== rec) focusPage();
      break;
    default:
  }
}

// Top-level navigation, from a link or a server redirect, to an origin no
// rule allows is stopped and handed to offsite(). A link to another desktop
// opens that desktop's window.
function guardNavigation(contents, rec = null) {
  const check = (details) => {
    if (!details.isMainFrame) return;
    const rules = nav();
    if (!rules.allowed(details.url)) {
      details.preventDefault();
      offsite(details.url);
    } else if (rec && rules.desktop(details.url)
      && originOf(details.url) !== originOf(rec.home)) {
      details.preventDefault();
      openDesktop(details.url);
    }
  };
  contents.on('will-navigate', check);
  contents.on('will-redirect', (details) => {
    if (details.isMainFrame && !nav().allowed(details.url)) {
      details.preventDefault();
      offsite(details.url);
    }
  });
}

// A blank popup closes at its first web navigation, which is handled like a
// window.open of that address; a login provider's page shows the popup instead.
function guardBlankPopup(rec, child) {
  let decided = false;
  const decide = (details) => {
    const { url } = details;
    if (decided || !details.isMainFrame || !origins.isWeb(url)) return;
    decided = true;
    if (nav().auth(url)) {
      guardPopup(child);
      child.show();
      return;
    }
    details.preventDefault();
    child.destroy();
    openUrl(rec, url);
  };
  child.webContents.on('will-navigate', decide);
  child.webContents.on('did-start-navigation', decide);
  // A popup that never navigates (a page that opened it and then failed) goes away.
  setTimeout(() => { if (!decided && !child.isDestroyed()) child.destroy(); }, 10000);
}

function popupOptions(rec) {
  return { parent: rec.win, width: 520, height: 680, autoHideMenuBar: true, webPreferences: { spellcheck: false } };
}

// A login popup gets the same navigation rules, and may open nothing further.
function guardPopup(child) {
  child.setMenuBarVisibility(false);
  guardNavigation(child.webContents);
  child.webContents.on('before-input-event', handleKeys);
  child.webContents.setWindowOpenHandler(({ url }) => { offsite(url); return { action: 'deny' }; });
}

// The launcher can have its own mode (launcher.windowMode), such as a normal
// window for the Coder login while desktops are fullscreen.
function windowModeOf(isLauncher) {
  return isLauncher && policy.launcher.windowMode ? policy.launcher.windowMode : settings.windowMode;
}

function applyWindowMode(rec) {
  const { win } = rec;
  const mode = windowModeOf(rec.launcher);
  win.setFullScreen(mode === 'fullscreen');
  if (mode === 'maximized') win.maximize();
  else if (mode === 'normal' && win.isMaximized()) win.unmaximize();
}

function createWindow(home, isLauncher) {
  const toolbar = toolbarFor();
  const frame = !toolbar && windowModeOf(isLauncher) === 'normal' && wm !== 'i3';
  const win = new BrowserWindow({
    title: policy.title,
    width: 1600,
    height: 900,
    // A normal window keeps its decorations except under i3, which tiles it.
    frame,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { backgroundThrottling: false, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  // A toolbar window's page is a view below the toolbar; the window's own
  // contents stay blank underneath. Other windows' page is the window's own.
  let pageView = null;
  if (toolbar) {
    pageView = new WebContentsView({ webPreferences: { backgroundThrottling: false, spellcheck: false } });
    pageView.setBackgroundColor('#000000');
    win.contentView.addChildView(pageView);
    // A page without a <title> fires no title event; Chromium then uses its address.
    const syncTitle = () => { win.setTitle(pageView.webContents.getTitle() || policy.title); pushBars(); };
    pageView.webContents.on('page-title-updated', syncTitle);
    pageView.webContents.on('did-finish-load', syncTitle);
    // Page full screen fills the window, as it does in a window without a
    // toolbar. Leaving it restores the window only if the page made it full
    // screen, so a selkies page leaving its own full screen keeps a full-screen
    // kiosk window as it was.
    let fullscreenFromPage = false;
    pageView.webContents.on('enter-html-full-screen', () => {
      if (win.isFullScreen()) return;
      fullscreenFromPage = true;
      win.setFullScreen(true);
    });
    pageView.webContents.on('leave-html-full-screen', () => {
      if (!fullscreenFromPage) return;
      fullscreenFromPage = false;
      win.setFullScreen(false);
    });
  }
  const page = pageView ? pageView.webContents : win.webContents;
  barIds += 1;
  const rec = {
    id: barIds, win, page, pageView, home, launcher: isLauncher, toolbar, url: null, retryDelay: RETRY_MIN_MS, retryTimer: null,
    frame, bar: null, barSize: null,
  };
  windows.add(rec);
  if (isLauncher) launcher = rec;
  createBar(rec);

  page.on('before-input-event', handleKeys);
  win.on('focus', () => { lastFocused = rec; setI3Mode(settings.i3Mode); });
  win.on('blur', () => setI3Mode('default'));
  win.on('resize', () => { fitOverlay(rec); positionBar(rec); });
  if (pageView) win.on('focus', () => { if (!overlay && !picker) page.focus(); });
  win.on('enter-full-screen', () => updateBar(rec));
  win.on('leave-full-screen', () => updateBar(rec));
  win.on('enter-html-full-screen', () => updateBar(rec));
  win.on('leave-html-full-screen', () => updateBar(rec));
  win.on('show', pushBars);
  win.on('maximize', pushBars);
  win.on('unmaximize', pushBars);
  win.on('hide', pushBars);
  win.on('page-title-updated', () => setImmediate(pushBars));

  // With desktops open, closing the launcher hides it; closing the last
  // desktop brings it back.
  win.on('close', (event) => {
    if (rec.launcher && desktopWindows().length && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    clearTimeout(rec.retryTimer);
    // A WebContentsView's page outlives its window unless closed.
    if (rec.bar && !rec.bar.webContents.isDestroyed()) rec.bar.webContents.close();
    if (pageView && !page.isDestroyed()) page.close();
    if (overlayHost === rec && overlay && !overlay.webContents.isDestroyed()) overlay.webContents.close();
    if (picker && picker.rec === rec) closePicker(null);
    windows.delete(rec);
    if (lastFocused === rec) lastFocused = null;
    if (overlayHost === rec) { overlay = null; overlayHost = null; }
    if (rec.launcher) launcher = null;
    if (!windows.size) setI3Mode('default');
    else if (launcher && !desktopWindows().length && !launcher.win.isVisible()) show(launcher);
    pushBars();
  });

  // Pages stay on the allowed origins; anything else goes to offsite().
  // A login provider may open a popup (MSAL's loginPopup), which stays a child
  // of this window so the page can read its result.
  page.setWindowOpenHandler(({ url }) => {
    // Coder opens apps with window.open() and then sets the popup's location,
    // so a blank popup is created hidden and decided on at its first navigation.
    if (url === 'about:blank' || url === '') {
      return { action: 'allow', overrideBrowserWindowOptions: { ...popupOptions(rec), show: false } };
    }
    if (nav().auth(url)) return { action: 'allow', overrideBrowserWindowOptions: popupOptions(rec) };
    openUrl(rec, url);
    return { action: 'deny' };
  });
  page.on('did-create-window', (child, { url }) => {
    if (url === 'about:blank' || url === '') guardBlankPopup(rec, child); else guardPopup(child);
  });
  guardNavigation(page, rec);

  // Reconnect with backoff: the container may outlive or predate this window.
  page.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 is ERR_ABORTED, a superseded load.
    const retry = nav().allowed(url) ? url : rec.home;
    const seconds = Math.round(rec.retryDelay / 1000);
    const host = origins.isWeb(retry) ? new URL(retry).hostname : '';
    const text = certs && certs.changed(host)
      ? `The certificate of ${host} changed since this window connected, as it does when the container is rebuilt.`
        + `${policy.keys.reload ? ' Ctrl+Alt+Shift+R trusts the new one.' : ''}`
      : `Cannot reach ${retry} (${description}). Retrying in ${seconds}s.`;
    page.loadURL(statusPage(text)).catch(() => {});
    rec.retryTimer = setTimeout(() => load(rec, retry), rec.retryDelay);
    rec.retryDelay = Math.min(rec.retryDelay * 2, RETRY_MAX_MS);
  });
  page.on('did-finish-load', () => {
    const url = page.getURL();
    if (nav().allowed(url)) { rec.retryDelay = RETRY_MIN_MS; rec.url = url; }
    pushBars();
  });

  win.show();
  placeWindow(rec).finally(() => applyWindowMode(rec));
  return rec;
}

// --- Downloads -------------------------------------------------------------------
// With a downloads section, only the listed extensions are saved, then opened
// with their program. A kiosk without one saves nothing.

function handleDownload(event, item) {
  const d = policy.downloads;
  const name = item.getFilename();
  const what = downloads.decide(d, name);
  if (what.action === 'default') return;
  if (what.action === 'cancel') {
    item.cancel();
    console.error(`airlock-browser: cancelled download of ${name}: .${downloads.extOf(name) || '(none)'} is not in downloads.handlers`);
    return;
  }
  const dir = d.dir || app.getPath('downloads');
  fs.mkdirSync(dir, { recursive: true });
  const file = downloads.uniquePath(dir, downloads.safeName(name));
  item.setSavePath(file);
  item.once('done', (e, state) => {
    if (state !== 'completed') {
      dialog.showMessageBox({ type: 'error', title: policy.title, message: `Could not download ${name} (${state}).` });
      return;
    }
    if (d.quit === 'download') { app.quit(); return; }
    if (what.argv) runHandler(what.argv, file);
  });
}

// The program gets the user's own environment, not the kiosk's redirected one.
function runHandler(argv, file) {
  const child = spawn(argv[0], [...argv.slice(1), file], { env: storage.userEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (err) => warn(`Could not run ${argv[0]} for ${path.basename(file)}: ${err.message}`));
  child.on('exit', (code) => {
    if (policy.kiosk) fs.rm(file, { force: true }, () => {});
    if (code === 0 && policy.downloads.quit === 'handler') app.quit();
    else if (code !== 0 && code !== null) console.error(`airlock-browser: ${argv[0]} exited with ${code}`);
  });
}

// --- Screen-share picker ------------------------------------------------------------
// getDisplayMedia from a desktop origin shows a picker over the window that
// asked. Where the system offers one source (a Wayland portal has already
// asked the user), it is used directly.

let picker = null; // { view, rec, callback, origin, sources }

function closePicker(choice) {
  if (!picker) return;
  const { view, rec, callback, sources } = picker;
  picker = null;
  const source = sources.find((x) => x.id === choice);
  callback(source ? { video: source } : {});
  if (!rec.win.isDestroyed()) {
    rec.win.contentView.removeChildView(view);
    rec.page.focus();
  }
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

async function handleDisplayMedia(request, callback) {
  const contents = request.frame ? allContents.fromFrame(request.frame) : null;
  const rec = contents ? recordOf(contents) : null;
  if (picker || !rec || !nav().desktop(request.securityOrigin)) { callback({}); return; }
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  } catch (err) {
    console.error(`airlock-browser: no screen sources: ${err.message}`);
    callback({});
    return;
  }
  if (sources.length <= 1) { callback(sources.length ? { video: sources[0] } : {}); return; }
  const view = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), spellcheck: false },
  });
  view.setBackgroundColor('#00000000');
  picker = { view, rec, callback, origin: request.securityOrigin, sources };
  const [width, height] = rec.win.getContentSize();
  view.setBounds({ x: 0, y: 0, width, height });
  rec.win.contentView.addChildView(view);
  view.webContents.on('will-navigate', (event) => event.preventDefault());
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('before-input-event', handleKeys);
  view.webContents.loadFile(path.join(__dirname, 'picker.html'));
  view.webContents.once('did-finish-load', () => view.webContents.focus());
}

// --- Settings overlay ------------------------------------------------------
// A view over the desktop rather than a second window: the KWin rule matches
// by window class, which a second window would share, and the remote session
// stays connected underneath.

function fitOverlay(rec) {
  if (!overlay || overlayHost !== rec) return;
  const [width, height] = rec.win.getContentSize();
  overlay.setBounds({ x: 0, y: 0, width, height });
}

function openSettings(rec) {
  if (overlay || !policy.settingsPage) return;
  overlayHost = rec;
  overlay = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), spellcheck: false },
  });
  overlay.setBackgroundColor('#101317');
  rec.win.contentView.addChildView(overlay);
  fitOverlay(rec);
  overlay.webContents.on('before-input-event', handleKeys);
  overlay.webContents.on('will-navigate', (event) => event.preventDefault());
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.loadFile(path.join(__dirname, 'settings.html'));
  overlay.webContents.once('did-finish-load', () => overlay && overlay.webContents.focus());
}

function closeSettings() {
  if (!overlay) return;
  const rec = overlayHost;
  rec.win.contentView.removeChildView(overlay);
  overlay.webContents.close();
  overlay = null;
  overlayHost = null;
  rec.page.focus();
  if (!started) load(rec);
}

async function overlayState() {
  return {
    settings,
    firstRun,
    urlOverride,
    locked: policy.lock,
    integration: policy.integration,
    kiosk: policy.kiosk,
    wm,
    wayland: wayland(),
    displays: await listDisplays(),
    items: await refreshCapture(),
  };
}

// Saves the form, follows it with any rules already set up, and applies what
// can change live. Monitor changes apply at the next launch.
// A kiosk keeps changes for this run only. Locked settings keep their values
// whatever the page sends.
async function commit(input) {
  const prev = settings;
  const next = policyFile.unlocked(policy, { ...settings, ...input }, settings);
  settings = policy.kiosk ? config.normalize(next) : config.save(next, process.env, settingsDir);
  firstRun = false;
  if (policy.integration === 'manage') await integration.refresh(ctx, { wm, settings, display: await chosenDisplay() });
  if (settings.windowMode !== prev.windowMode) for (const rec of windows) applyWindowMode(rec);
  if (launcher && !urlOverride && settings.url !== prev.url) {
    repin();
    launcher.home = target();
    if (started) load(launcher);
  }
}

function registerIpc() {
  const fromOverlay = (event) => !!overlay && event.sender === overlay.webContents;
  ipcMain.handle('airlock-browser:state', (event) => (fromOverlay(event) ? overlayState() : null));
  ipcMain.handle('airlock-browser:save', async (event, input) => {
    if (!fromOverlay(event)) return null;
    const errors = config.validate(input);
    if (Object.keys(errors).length) return { errors };
    await commit(input);
    return { state: await overlayState() };
  });
  ipcMain.handle('airlock-browser:run', async (event, input, id, action) => {
    if (!fromOverlay(event) || policy.integration !== 'manage') return null;
    const errors = config.validate(input);
    if (Object.keys(errors).length) return { errors };
    await commit(input);
    try {
      await integration.perform(ctx, id, action, { wm, settings, display: await chosenDisplay() });
    } catch (err) {
      return { error: err.message, state: await overlayState() };
    }
    return { state: await overlayState() };
  });
  ipcMain.on('airlock-browser:close', (event) => { if (fromOverlay(event)) closeSettings(); });

  const fromPicker = (event) => !!picker && event.sender === picker.view.webContents;
  ipcMain.handle('picker:sources', (event) => (fromPicker(event) ? {
    origin: picker.origin,
    sources: picker.sources.map((x) => ({ id: x.id, name: x.name, thumbnail: x.thumbnail.toDataURL() })),
  } : null));
  ipcMain.on('picker:choose', (event, id) => { if (fromPicker(event)) closePicker(id); });

  const fromBar = (event) => [...windows].find((r) => r.bar && event.sender === r.bar.webContents) || null;
  ipcMain.handle('bar:state', (event) => { const r = fromBar(event); return r ? barState(r) : null; });
  ipcMain.on('bar:act', (event, action, arg) => { const r = fromBar(event); if (r) barAct(r, action, arg); });
  ipcMain.on('bar:size', (event, width, height) => {
    const r = fromBar(event);
    if (!r || !Number.isFinite(width) || !Number.isFinite(height)) return;
    r.barSize = { width: Math.max(1, Math.min(width, 4000)), height: Math.max(1, Math.min(height, 2000)) };
    positionBar(r);
  });
}

// --- Startup ---------------------------------------------------------------

// A config that does not load gets a window saying why, and nothing else.
function showPolicyError() {
  console.error(`airlock-browser: ${policyError}`);
  app.whenReady().then(() => {
    const win = new BrowserWindow({ title: 'Airlock Browser', width: 900, height: 500, backgroundColor: '#000000', autoHideMenuBar: true });
    win.webContents.on('before-input-event', handleKeys);
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadURL(statusPage(`Airlock Browser did not start because of its --config file.\n\n${policyError}`,
      'Ctrl+Alt+Shift+Q or closing this window quits.')).catch(() => {});
  });
  app.on('window-all-closed', () => app.quit());
}

function main() {
  // A kiosk re-execs itself once with its caches pointed into the kiosk
  // directory (see storage.kioskEnv). execve keeps the PID, so an AppImage
  // stays mounted.
  if (policy.kiosk) {
    const dir = storage.userDataDir(policy);
    const env = storage.kioskEnv(dir);
    if (env) {
      process.execve(process.execPath, process.argv, env);
      return;
    }
  }
  // VA-API video decode and encode. Both the older and the current Chromium
  // feature names are given; unknown names are ignored.
  if (policy.media.hardwareVideo) {
    app.commandLine.appendSwitch('enable-features', [
      'VaapiVideoDecoder', 'VaapiVideoEncoder', 'VaapiVideoDecodeLinuxGL',
      'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL', 'AcceleratedVideoEncoder',
    ].join(','));
  }
  // Electron exits on these signals without its quit events, which would leave
  // a kiosk directory behind.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => app.quit());

  let kioskDir;
  try {
    kioskDir = storage.apply(app, policy);
  } catch (err) {
    console.error(`airlock-browser: ${err.message}`);
    app.exit(1);
    return;
  }
  if (policyError) {
    storage.startCleanupWatcher(kioskDir);
    showPolicyError();
  } else {
    run(kioskDir);
  }
  if (kioskDir) {
    app.on('quit', () => storage.removeDir(kioskDir));
    process.on('exit', () => storage.removeDir(kioskDir));
  }
}

function run(kioskDir) {
  // A second launch brings this one's last used window to the front.
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  if (kioskDir) {
    storage.emptyDir(kioskDir);
    storage.startCleanupWatcher(kioskDir);
  }
  app.on('second-instance', () => {
    const rec = lastFocused || launcher || [...windows][0];
    if (rec) show(rec);
  });

  app.whenReady().then(async () => {
    const s = session.defaultSession;
    repin();
    const allowed = new Set([
      'pointerLock', 'fullscreen', 'keyboardLock', 'clipboard-read',
      'clipboard-sanitized-write', 'media', 'display-capture', 'hid', 'midi', 'midiSysex',
    ]);
    // Only desktop origins get these, not the dashboard or a login provider.
    const desktop = (url) => !!url && nav().desktop(url);
    s.setPermissionRequestHandler((wc, permission, cb, details) =>
      cb(allowed.has(permission) && desktop(details.requestingUrl || wc.getURL())));
    s.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
      allowed.has(permission) && desktop(requestingOrigin));
    s.on('will-download', handleDownload);
    if (policy.media.screenPicker) s.setDisplayMediaRequestHandler(handleDisplayMedia);

    wm = await integration.detectWm(ctx);
    registerIpc();
    const items = await refreshCapture();
    const rec = createWindow(target(), true);

    if (firstRun && policy.settingsPage) {
      openSettings(rec);
      return;
    }
    const capture = items.find((i) => i.id === 'kwin' || i.id === 'i3');
    if (settings.captureKeys && capture && capture.state !== 'ok') {
      warn(`${capture.label}: ${capture.detail}${policy.keys.settings ? ' Ctrl+Alt+Shift+S opens the settings.' : ''}`);
    }
    load(rec);
  });

  app.on('before-quit', () => { quitting = true; setI3Mode('default'); });
  app.on('window-all-closed', () => app.quit());
}

main();
