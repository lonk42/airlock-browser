// The drop-down bar at the top of a window. Collapsed it is a small handle;
// hovering the handle, or Ctrl+Alt+Shift+B, opens it. It reports its size so
// the main process can fit the view to it. Talks to the main process through
// window.airlockBrowserBar (bar-preload.js).
// In a kiosk window that is not full screen (state.toolbar) it is a fixed
// toolbar instead: always open, full width, and the title moves the window.
const $ = (id) => document.getElementById(id);
const bar = window.airlockBrowserBar;
const root = $('root');
const panel = $('panel');
const menu = $('menu');
const button = (act) => panel.querySelector(`[data-act="${act}"]`);

const CLOSE_DELAY_MS = 700;
let state = null;
let open = false;
let pinned = false;
let closeTimer = null;

function report() {
  const r = root.getBoundingClientRect();
  bar.size(Math.ceil(r.width), Math.ceil(r.height));
}

const toolbar = () => !!(state && state.toolbar);
const setLabel = (b, text) => { b.querySelector('.label').textContent = text; };

function render() {
  if (!state) return;
  if (toolbar() !== root.classList.contains('toolbar')) {
    root.classList.toggle('toolbar', toolbar());
    open = toolbar();
    panel.hidden = !open;
    root.classList.toggle('open', open);
    root.classList.toggle('closed', !open);
    if (!open) closeMenu();
  }
  $('title').textContent = state.title;
  $('brand-name').textContent = state.brand;
  const sec = $('security');
  sec.hidden = !state.security;
  if (state.security) {
    sec.textContent = state.security.label;
    sec.title = state.security.hint;
    sec.dataset.level = state.security.level;
  }
  const home = button('home');
  home.hidden = !state.home;
  if (state.home) {
    setLabel(home, state.home.label);
    home.title = state.home.hint;
  }
  // The toolbar keeps kiosk-browser's layout: Back is always there, greyed out
  // with no history. The drop-down shows it only when it does something.
  const back = button('back');
  back.hidden = toolbar() ? state.back === null : !state.back;
  back.disabled = !state.back;
  button('windows').hidden = state.windows.length < 2;
  button('reload').hidden = !state.reload;
  const fs = button('fullscreen');
  fs.hidden = !state.fullscreen;
  if (state.fullscreen) setLabel(fs, state.fullscreen === 'leave' ? 'Leave full screen' : 'Full screen');
  fs.dataset.state = state.fullscreen === 'leave' ? 'leave' : 'enter';
  button('settings').hidden = !state.settings;
  button('maximize').hidden = !state.maximize;
  if (state.maximize) setLabel(button('maximize'), state.maximize === 'restore' ? 'Restore' : 'Maximise');
  button('maximize').dataset.state = state.maximize === 'restore' ? 'leave' : 'enter';
  // The toolbar's quit is kiosk-browser's ×, unless a Close × is already there.
  panel.classList.toggle('has-close', !!state.close);
  button('close').hidden = !state.close;
  button('quit').hidden = !state.quit;
  // Icon-only in the toolbar, so the tooltip names the button; the key is added where there is one.
  const keys = { reload: 'Ctrl+Alt+Shift+R', settings: 'Ctrl+Alt+Shift+S', quit: 'Ctrl+Alt+Shift+Q' };
  for (const b of panel.querySelectorAll('button[data-act]')) {
    if (b.dataset.act === 'home' || b.dataset.act === 'pin') continue;
    const label = b.querySelector('.label').textContent;
    const key = keys[b.dataset.act];
    b.title = toolbar() ? (key ? `${label} (${key})` : label) : (key || '');
  }
  placeSeparators();
  if (!menu.hidden) renderMenu();
  report();
}

// A separator shows only between two groups that both have a visible button.
function placeSeparators() {
  let seen = false;
  let pending = null;
  for (const el of panel.children) {
    if (el.classList.contains('sep')) {
      el.hidden = true;
      if (seen) pending = el;
    } else if (el.tagName === 'BUTTON' && !el.hidden && !el.classList.contains('pin')) {
      if (pending) { pending.hidden = false; pending = null; }
      seen = true;
    } else if (el.id === 'who') {
      seen = true;
    }
  }
}

function renderMenu() {
  menu.replaceChildren();
  for (const w of state.windows) {
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = w.title || w.url;
    b.title = w.url;
    if (w.current) b.setAttribute('aria-current', 'true');
    // Focus stays with the window switched to, not the page under this bar.
    b.addEventListener('click', () => { closeMenu(); bar.act('switch', w.id); collapse(w.current); });
    li.append(b);
    menu.append(li);
  }
}

function openMenu() {
  renderMenu();
  menu.hidden = false;
  button('windows').setAttribute('aria-expanded', 'true');
  report();
  const first = menu.querySelector('button');
  if (first) first.focus();
}

function closeMenu() {
  menu.hidden = true;
  button('windows').setAttribute('aria-expanded', 'false');
  report();
}

async function expand(focus) {
  clearTimeout(closeTimer);
  if (!open) {
    open = true;
    state = await bar.state();
    root.classList.replace('closed', 'open');
    panel.hidden = false;
    $('handle').setAttribute('aria-expanded', 'true');
    render();
  }
  if (focus) {
    const first = panel.querySelector('button:not([hidden])');
    if (first) first.focus();
  }
}

// giveBack returns keyboard focus to the page under the bar.
function collapse(giveBack) {
  clearTimeout(closeTimer);
  if (toolbar()) {
    closeMenu();
    report();
    if (giveBack) bar.act('focus-page');
    return;
  }
  if (!open) return;
  open = false;
  closeMenu();
  panel.hidden = true;
  root.classList.replace('open', 'closed');
  $('handle').setAttribute('aria-expanded', 'false');
  report();
  if (giveBack) bar.act('focus-page');
}

$('handle').addEventListener('mouseenter', () => expand(false));
$('handle').addEventListener('click', () => expand(true));
root.addEventListener('mouseenter', () => clearTimeout(closeTimer));
root.addEventListener('mouseleave', () => {
  if (!open || pinned || toolbar() || root.contains(document.activeElement) && document.hasFocus()) return;
  closeTimer = setTimeout(() => collapse(false), CLOSE_DELAY_MS);
});
// Leaving by keyboard or clicking back into the page closes it too.
window.addEventListener('blur', () => { if (open && !pinned) collapse(false); });
// A toolbar only reaches its first-run state once the main process says so.
bar.state().then((s) => { if (s && s.toolbar) { state = s; render(); } });

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!menu.hidden) { closeMenu(); button('windows').focus(); } else collapse(true);
});

panel.addEventListener('click', (event) => {
  const b = event.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'pin') {
    pinned = !pinned;
    b.setAttribute('aria-pressed', String(pinned));
    return;
  }
  if (act === 'windows') {
    if (menu.hidden) openMenu(); else closeMenu();
    return;
  }
  bar.act(act);
  // Actions that leave this window, or change its page, close the bar.
  // Home from a desktop window shows the launcher, which keeps the focus.
  const leaves = act === 'home' && state.home && state.home.leaves;
  if (['home', 'back', 'reload', 'settings', 'close', 'maximize'].includes(act) && !pinned) collapse(act !== 'settings' && !leaves);
});

bar.onState((s) => { state = s; render(); });
bar.onToggle(() => {
  if (toolbar()) {
    if (root.contains(document.activeElement) && document.hasFocus()) collapse(true); else expand(true);
  } else if (open) collapse(true); else expand(true);
});
report();
