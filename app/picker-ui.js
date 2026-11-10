// Screen-share picker, shown over the window whose page called getDisplayMedia.
// Talks to the main process through window.airlockBrowserPicker (picker-preload.js).
const picker = window.airlockBrowserPicker;
const list = document.getElementById('sources');

document.getElementById('cancel').addEventListener('click', () => picker.choose(null));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') picker.choose(null); });

picker.sources().then(({ origin, sources }) => {
  document.getElementById('origin').textContent = `${origin} wants to see a screen or window.`;
  for (const s of sources) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const img = document.createElement('img');
    img.alt = '';
    img.src = s.thumbnail;
    const name = document.createElement('span');
    name.textContent = s.name;
    b.append(img, name);
    b.addEventListener('click', () => picker.choose(s.id));
    li.append(b);
    list.append(li);
  }
  const first = list.querySelector('button');
  if (first) first.focus();
});
