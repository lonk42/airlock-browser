const test = require('node:test');
const assert = require('node:assert/strict');
const screens = require('../app/screens');

const d = (name, x, y, width = 1920, height = 1080) => ({ name, bounds: { x, y, width, height } });

test('side follows where the other monitor sits', () => {
  const p = d('A', 0, 0);
  assert.equal(screens.sideOf(p, d('B', 1920, 0)), 'right');
  assert.equal(screens.sideOf(p, d('B', -1920, 0)), 'left');
  assert.equal(screens.sideOf(p, d('B', 0, 1080)), 'down');
  assert.equal(screens.sideOf(p, d('B', 0, -1080)), 'up');
  // A taller monitor beside, offset down, is still to the right.
  assert.equal(screens.sideOf(p, d('B', 1920, 300, 1440, 2560)), 'right');
  // A diagonal neighbour goes by its larger offset.
  assert.equal(screens.sideOf(p, d('B', 1920, 600)), 'right');
});

test('auto prefers the nearest monitor beside the first', () => {
  const p = d('A', 1920, 0);
  const displays = [d('L', 0, 0), p, d('R', 3840, 200), d('U', 1920, -1080)];
  // L and R are both beside A; L's centre is nearer.
  assert.deepEqual(screens.pickSecond(displays, p, 'auto'), { display: displays[0], side: 'left' });
  assert.deepEqual(screens.pickSecond([p, d('U', 1920, -1080)], p, 'auto').side, 'up');
});

test('auto picks nothing with one monitor, none picks nothing', () => {
  const p = d('A', 0, 0);
  assert.equal(screens.pickSecond([p], p, 'auto'), null);
  assert.equal(screens.pickSecond([p, d('B', 1920, 0)], p, 'none'), null);
  assert.equal(screens.pickSecond([], null, 'auto'), null);
});

test('a named monitor is used only when connected and not the first', () => {
  const p = d('A', 0, 0);
  const b = d('B', 0, 1080);
  assert.deepEqual(screens.pickSecond([p, b, d('C', 1920, 0)], p, 'B'), { display: b, side: 'down' });
  assert.equal(screens.pickSecond([p, b], p, 'DP-9'), null);
  assert.equal(screens.pickSecond([p, b], p, 'A'), null);
});

test('displayAt finds the monitor holding most of a window', () => {
  const displays = [d('A', 0, 0), d('B', 1920, 0)];
  assert.equal(screens.displayAt({ x: 1800, y: 100, width: 1600, height: 900 }, displays).name, 'B');
  assert.equal(screens.displayAt({ x: 5000, y: 100, width: 10, height: 10 }, displays).name, 'B');
});

test('second page addresses', () => {
  assert.equal(screens.secondaryUrl('https://host:3001/', 'left'), 'https://host:3001/#display2-left');
  assert.equal(screens.secondaryUrl('https://host/app/#x', 'sideways'), 'https://host/app/#display2-right');
  assert.equal(screens.secondarySide('https://host/#display2-up'), 'up');
  assert.equal(screens.secondarySide('https://host/#display2'), 'right');
  assert.equal(screens.secondarySide('https://host/#shared'), null);
  assert.equal(screens.secondarySide('nope'), null);
});

test('xid reads an X11 window id', () => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0x4a00007, 0);
  assert.equal(screens.xid(b), 0x4a00007);
  assert.equal(screens.xid(Buffer.alloc(0)), null);
});

test('xrandr monitors parse to names and bounds', () => {
  const text = `Monitors: 3
 0: +*DP-2 2560/597x1440/336+0+0  DP-2
 1: +HDMI-1 1920/527x1080/296+2560+180  HDMI-1
 2: LEFT 1920/508x1080/286+-1920+0  screen
`;
  assert.deepEqual(screens.parseMonitors(text), [
    { name: 'DP-2', bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
    { name: 'HDMI-1', bounds: { x: 2560, y: 180, width: 1920, height: 1080 } },
    { name: 'LEFT', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ]);
  assert.deepEqual(screens.parseMonitors(''), []);
});
