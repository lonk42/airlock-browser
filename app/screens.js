// A second monitor for selkies desktops. Selkies extends its desktop across a
// second page at the same address with the fragment #display2-<side>, where
// <side> is right, left, up or down of the first page's monitor. These are the
// pure parts: which monitor, which side, and the second page's address.
// Displays are { name, bounds: { x, y, width, height } }, as listDisplays() gives.

const SIDES = ['right', 'left', 'up', 'down'];

const centre = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

// Where `other` sits relative to `primary`: the direction of its centre,
// horizontal when the two offsets are equal.
function sideOf(primary, other) {
  const p = centre(primary.bounds);
  const o = centre(other.bounds);
  const dx = o.x - p.x;
  const dy = o.y - p.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

// The display that holds most of a window's bounds, or the one nearest its centre.
function displayAt(bounds, displays) {
  let best = null;
  let bestArea = 0;
  for (const d of displays) {
    const b = d.bounds;
    const w = Math.min(bounds.x + bounds.width, b.x + b.width) - Math.max(bounds.x, b.x);
    const h = Math.min(bounds.y + bounds.height, b.y + b.height) - Math.max(bounds.y, b.y);
    if (w > 0 && h > 0 && w * h > bestArea) { best = d; bestArea = w * h; }
  }
  if (best) return best;
  const c = centre(bounds);
  return nearest(displays, c);
}

function nearest(displays, point) {
  let best = null;
  let bestDist = Infinity;
  for (const d of displays) {
    const o = centre(d.bounds);
    const dist = Math.hypot(o.x - point.x, o.y - point.y);
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  return best;
}

// Shares part of the primary's rows: beside it rather than above or below.
function sameRow(primary, other) {
  const p = primary.bounds;
  const o = other.bounds;
  return Math.min(p.y + p.height, o.y + o.height) > Math.max(p.y, o.y);
}

// The second monitor for a primary: the setting's output if connected, none
// for 'none', and for 'auto' the nearest monitor beside the primary, or else
// the nearest above or below it. Returns { display, side } or null.
function pickSecond(displays, primary, setting) {
  if (!primary || setting === 'none') return null;
  const others = displays.filter((d) => d.name !== primary.name);
  let display = null;
  if (setting && setting !== 'auto') {
    display = others.find((d) => d.name === setting) || null;
  } else {
    const beside = others.filter((d) => sameRow(primary, d));
    display = nearest(beside.length ? beside : others, centre(primary.bounds));
  }
  return display ? { display, side: sideOf(primary, display) } : null;
}

// The selkies second page's side, or null when the address is not one.
function secondarySide(url) {
  let hash;
  try { hash = new URL(url).hash; } catch { return null; }
  if (!hash.startsWith('#display2')) return null;
  const m = /^#display2-(right|left|up|down)/.exec(hash);
  return m ? m[1] : 'right';
}

function secondaryUrl(home, side) {
  const u = new URL(home);
  u.hash = `display2-${SIDES.includes(side) ? side : 'right'}`;
  return u.href;
}

// `xrandr --listmonitors`: lines such as ` 0: +*DP-2 2560/597x1440/336+0+0  DP-2`.
// The monitor's name, without the automatic (+) and primary (*) marks, is
// the output's name for a monitor made from one output.
function parseMonitors(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*\d+:\s+[+*]*(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+?(-?\d+)\+?(-?\d+)/.exec(line);
    if (m) out.push({ name: m[1], bounds: { x: +m[4], y: +m[5], width: +m[2], height: +m[3] } });
  }
  return out;
}

// The X11 window id of an Electron window, for i3's [id=...] criteria.
function xid(handle) {
  return handle && handle.length >= 4 ? handle.readUInt32LE(0) : null;
}

module.exports = { SIDES, sideOf, displayAt, pickSecond, secondarySide, secondaryUrl, parseMonitors, xid };
