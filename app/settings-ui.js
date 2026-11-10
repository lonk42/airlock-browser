// Settings overlay. Talks to the main process through window.airlockBrowser (settings-preload.js).
const $ = (id) => document.getElementById(id);
const form = $('form');

const PILL = {
  ok: 'In place', missing: 'Not set up', outdated: 'Out of date',
  conflict: 'Conflict', unavailable: 'Unavailable', present: 'Found',
};
const WM_NAME = { kde: 'KDE Plasma (KWin)', i3: 'i3' };

let busy = false;

function formValues() {
  return {
    url: $('url').value.trim(),
    display: $('display').value,
    windowMode: form.elements.windowMode.value,
    captureKeys: $('captureKeys').checked,
  };
}

function showErrors(errors = {}) {
  $('url').setAttribute('aria-invalid', errors.url ? 'true' : 'false');
  const note = $('url-note');
  note.classList.toggle('bad', !!errors.url);
  note.textContent = errors.url || note.dataset.base || '';
}

function setError(text) {
  $('error').hidden = !text;
  $('error').textContent = text || '';
}

function button(text, onClick, primary) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (primary) b.className = 'primary';
  b.addEventListener('click', onClick);
  return b;
}

function renderItems(items, manage) {
  const list = $('items');
  list.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li');

    const title = document.createElement('div');
    title.className = 'item-title';
    const name = document.createElement('span');
    name.textContent = item.label;
    const pill = document.createElement('span');
    pill.className = `pill ${item.state}`;
    pill.textContent = PILL[item.state] || item.state;
    title.append(name, pill);

    const detail = document.createElement('div');
    detail.className = 'item-detail';
    detail.textContent = item.detail;

    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const act = (action) => () => run(item.id, action);
    if (!manage) { li.append(title, detail); list.append(li); continue; }
    if (item.state === 'missing') actions.append(button('Set up', act('apply'), true));
    if (item.state === 'outdated') actions.append(button('Update', act('apply'), true), button('Remove', act('remove')));
    if (item.state === 'ok' || item.state === 'present') actions.append(button('Remove', act('remove')));

    li.append(title, detail, actions);
    list.append(li);
  }
}

function render(state) {
  const { settings, firstRun, urlOverride, wm, wayland, displays, items, locked, integration, kiosk } = state;

  $('intro').textContent = kiosk
    ? 'Kiosk mode: changes last until Airlock Browser quits, and nothing is saved.'
    : firstRun
      ? 'First run. Enter the address and set up the integration below; the page opens when you save.'
      : 'Changes to the monitor apply the next time Airlock Browser starts.';
  $('cancel').hidden = firstRun;
  $('save').textContent = firstRun ? 'Save and connect' : 'Save';

  $('url').value = settings.url;
  $('url-note').dataset.base = urlOverride ? `AIRLOCK_BROWSER_URL is set, so this run uses ${urlOverride}.` : '';
  showErrors();

  const select = $('display');
  select.replaceChildren(new Option('Wherever the window manager puts it', ''));
  for (const d of displays) {
    select.append(new Option(`${d.name} · ${d.bounds.width}×${d.bounds.height} at ${d.bounds.x},${d.bounds.y}`, d.name));
  }
  if (settings.display && !displays.some((d) => d.name === settings.display)) {
    select.append(new Option(`${settings.display} (not connected)`, settings.display));
  }
  select.value = settings.display;
  const placeable = wm === 'kde' || wm === 'i3' || !wayland;
  select.disabled = !placeable;
  $('display-note').textContent = !placeable
    ? 'This Wayland compositor does not let apps choose a monitor.'
    : wm === 'kde' ? 'Applied through the KWin window rule below.' : '';

  form.elements.windowMode.value = settings.windowMode;
  $('captureKeys').checked = settings.captureKeys;

  // Settings the --config file locks are shown but cannot be changed.
  const lock = (key, els) => {
    for (const el of els) el.disabled = el.disabled || locked.includes(key);
  };
  lock('url', [$('url')]);
  lock('display', [select]);
  lock('windowMode', form.querySelectorAll('input[name=windowMode]'));
  lock('captureKeys', [$('captureKeys')]);
  $('locked-note').hidden = !locked.length;
  $('capture-note').textContent = wm === 'kde' ? 'Needs the KWin window rule below.'
    : wm === 'i3' ? 'Needs the i3 mode below.'
      : 'Only KDE Plasma and i3 are supported; other window managers keep their shortcuts.';

  $('wm-note').textContent = (wm ? `Window manager: ${WM_NAME[wm]}.` : 'No supported window manager found.')
    + (integration === 'manage' ? '' : ' The --config file manages these; they are shown for information.');
  renderItems(items, integration === 'manage');
}

async function withBusy(fn) {
  if (busy) return;
  busy = true;
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try { await fn(); } finally {
    busy = false;
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}

function run(id, action) {
  return withBusy(async () => {
    setError('');
    const result = await window.airlockBrowser.run(formValues(), id, action);
    if (result.errors) { showErrors(result.errors); return; }
    render(result.state);
    if (result.error) setError(result.error);
  });
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  withBusy(async () => {
    setError('');
    const result = await window.airlockBrowser.save(formValues());
    if (result.errors) { showErrors(result.errors); $('url').focus(); return; }
    window.airlockBrowser.close();
  });
});

$('cancel').addEventListener('click', () => window.airlockBrowser.close());

window.airlockBrowser.state().then(render);
