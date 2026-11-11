# Design

## Keyboard

A remote desktop in a browser tab loses key sequences for two independent reasons.

1. **Browser accelerators.**
   Ctrl+W closes the tab in Firefox.
   `chromium --kiosk` still keeps Ctrl+T, Ctrl+L and F11.
2. **Window-manager grabs.**
   With `$mod` set to Mod1 (Alt), i3 grabs Alt+Tab, Alt+1..0, Alt+Enter and Alt+F at the X level, before any client sees them.
   KDE Plasma takes Alt+Tab, Alt+\`, Alt+F1/F3/F4, Meta on its own, and most Meta combinations.
   No browser setting changes this, and it is the larger of the two.

Electron with `Menu.setApplicationMenu(null)` has no accelerators.
Kiosk mode in a browser cannot remove all of them.
WebKitGTK was also considered; Electron uses the same Chromium engine as Chrome, so selkies WebRTC behaves the same.

## Window-manager integration

The settings overlay reports each integration item as in place, not set up, out of date, or in conflict, and writes it only when asked.
Saving the settings rewrites the window-manager items that are already set up, so they follow the monitor and key-capture choices.

### KWin

One rule in `~/.config/kwinrulesrc`, group `airlock-browser`, with an exact match on window class `airlock-browser`.
It sets "Ignore global shortcuts" (`disableglobalshortcuts`, forced) and, with a monitor chosen, "Position" (apply initially) to that monitor's origin.
KWin applies the rule while the window has focus, so there is nothing to toggle and nothing to reset after a crash.
The file is edited line by line, leaving other rules byte-for-byte, then KWin is told to `reconfigure` over D-Bus.

The rule cannot tell two windows of the same app apart.
Matching on the title as well does not work: Electron sets the title after KWin evaluates the rule.
The settings are an overlay inside the window, and every desktop window, as well as the launcher, gets the rule.
With the rule in place, Alt+Tab goes to the page, so switching between Airlock Browser windows needs the bar or the taskbar.

### i3

A mode containing only the escape binding releases every other i3 binding while it is active.
The settings write `~/.config/i3/airlock-browser.conf` from the mode name, add an `include` for it to the i3 config, and reload i3.
The window enters the mode on focus and returns to `default` on blur, close and quit, through `i3-msg mode`.
Key capture under i3 is only switched on once `i3-msg -t get_binding_modes` lists the mode: `i3-msg mode <name>` for an undefined mode fails with no visible symptom.

A detached `sh` started at launch waits for the app's PID with `tail --pid` and then returns i3 to `default` if it is still in the mode.
This covers SIGKILL and crashes, which skip Electron's own reset.

A mode of the same name defined directly in the i3 config is reported as a conflict and not touched.

## Placement

Wayland clients cannot choose their own position, so the monitor choice goes through the window manager:

| Session | Monitor names from | Applied by |
|---|---|---|
| KDE Wayland | Electron `screen`, whose labels are output names such as `DP-2` | KWin rule position |
| KDE X11 | `xrandr --listmonitors` | KWin rule position |
| i3 | `i3-msg -t get_outputs` | `i3-msg [id=…] move container to output` |
| Other X11 | `xrandr --listmonitors` | `BrowserWindow.setBounds` |
| Other Wayland | | Not possible |

Under X11 Electron's `screen` gives no output names; it is the fallback when `xrandr` lists nothing.
The window manager places a new window itself when it maps it, after `show()` returns, so `i3-msg` and `setBounds` are repeated until the window is on the monitor.
i3 matches the window by its X11 id, since every window has the same class.
Window, maximised or fullscreen is applied by the app after placement, so fullscreen fills the monitor the window opened on.
A chosen monitor that is not connected keeps the position already in the KWin rule.

## Second monitor

Selkies extends its desktop across a second page: the same address with the fragment `#display2-<side>`, where the side is `right`, `left`, `up` or `down` of the first page's monitor.
Each page sends its window size, and the server adds a monitor to the remote desktop for the second one.
Selkies has one second display at most, and plays sound on the first page only.

Under X11, once a desktop window's page has loaded and defines `window.selkiesCoreInitialize`, the app opens a second window on the second monitor with that address, in the same window mode.
The page is checked every 500 ms for 15 s after each load, since selkies loads its core after the page.

`settings.secondDisplay` picks the monitor:

- `auto`: the nearest monitor beside the first window's, by centre, or else the nearest above or below.
- An output name: that monitor, if connected and not the first window's.
- `none`: no second window.

The side is the direction from the first monitor's centre to the second's, horizontal on a tie.
The first window's monitor is `settings.display`, or the one that holds most of the window.

The two windows are one desktop:

- The second window opens without focus, comes to the front with the first, and closes with it.
- The Windows list shows the pair once; the second window's bar shows its title with "· second screen".
- Closing the second window keeps it closed for the run, through reloads.
- When the first page loads selkies again (a reload, or a retry after a workspace restart), the second page is reloaded too. Selkies' second page does not rejoin a restarted server by itself, and keeps its last frame on screen.
- The second page's address is the first page's address at the time, not the window's home, so it uses the host name Coder redirected to.
- Selkies' own second-screen button calls `window.open` with a `#display2` address of the window's own origin. That opens the second window, on the monitor `auto` would pick, even with `secondDisplay: none`. Its side comes from the monitors, not from the page.

Under Wayland the second window opens only from selkies' button, wherever the compositor puts it.

## TLS

A selkies container serves a self-signed certificate and generates a new one on rebuild, so it cannot be pinned in advance.
A certificate verify proc trusts the first certificate the target host presents in a run and rejects any other for that host.
Ctrl+Alt+Shift+R clears the pin and reconnects.
Hosts other than the target, and certificates Chromium already accepts, get Chromium's normal verification.

The config file adds two more ways in, checked first (`app/tls.js`).
`tls.insecure` accepts any certificate from the hosts it names.
`tls.ca` accepts a chain that leads to one of its certificates, checked with Node's `X509Certificate`: each signature, each validity period, and the host name on the first certificate.
Electron gives the chain as `certificate.issuerCert`, so a server that does not send its intermediate is refused.
`tls.pin` replaces the default pin list; pins are kept per host, so a wildcard such as `*.coder.example.lan` pins each workspace host separately.

Reading the certificate before starting, with `openssl s_client`, does not work for a login autostart: the server may not be listening yet.

## Permissions and navigation

`main.js` grants pointer lock, keyboard lock, fullscreen, clipboard, media, display capture, HID and MIDI to desktop origins only: the target origin, or `navigation.desktops` from the config file.
Autoplay is enabled.
Top-level navigation, by link or by server redirect (`will-navigate`, `will-redirect`), is checked against the allowed origins.
Anything else goes to the default browser, or is blocked with `navigation.offsite: block`.
Only `http:` and `https:` addresses are passed to the default browser.
The settings overlay has the only preload; IPC from any other page is ignored.

Coder opens a workspace app with `window.open()` on a blank page and then sets the popup's location, so the window-open handler sees only `about:blank`.
A blank popup is created hidden, and its first navigation decides what happens: a login provider's page shows the popup, and any other address is handled like a `window.open` of that address.
A login provider's popup (MSAL's `loginPopup`) stays a child window with the opener relationship intact, so the page can read its result.

## Windows

The launcher window loads the address.
A page that opens a desktop origin other than the launcher's own, by `window.open` or by a link, gets a window for that origin, or brings the existing one to the front.
Each window has a home origin, and navigation to it stays in the window.
A desktop window also owns the first desktop origin its page lands on: Coder redirects `desktop--main--ws--user.coder.example.lan` to `desktop--ws--user.coder.example.lan` for a workspace with one agent, and selkies later navigates to its own address when it reconnects.
Without that, the reconnect opened a second window for the same desktop.
Coder signs in to a workspace app by redirecting from the app to the dashboard and back, so routing by the origin of the current page would open a second window during the login.
An allowed page that is neither the window's home nor a desktop opens in the launcher.

Closing the launcher while a desktop window is open hides it.
Closing the last desktop window shows it again, and closing the launcher alone quits.
The escape keys act on the window they are pressed in, and a second launch brings the last focused window to the front.
Retry state is per window: a desktop window retries its own address.
A desktop page that answers with an HTTP status of 400 or more is retried with the same backoff, with the server's page shown meanwhile.
Selkies reloads its page when the server goes away, so during a Coder workspace restart it lands on Coder's `404 - Application Not Found`, which would otherwise stay.
`launcher.windowMode` gives the launcher its own window mode, so a login page can be a normal window while desktops are full screen.

## Bar

Each window has a `WebContentsView` at the top centre with `bar.html`.
The page reports the size of what it shows, and the view is set to that size, so the desktop loses only the pull tab (72×14 px) while the bar is closed.
The pull tab opens the bar on hover, and Ctrl+Alt+Shift+B opens it with keyboard focus for when selkies holds pointer lock.
It closes when the pointer leaves it, unless pinned, and gives keyboard focus back to the page.
An action that moves to another window does not: focusing the page under the bar raises its window again under Wayland, over the window just switched to.

`bar: auto` shows it on a full-screen window, page full screen included, and on a window without decorations.
In kiosk mode every window is created without decorations, and when it is not full screen it gets the same page as a fixed toolbar instead (`toolbarFor` in `main.js`).
A `BrowserWindow`'s own page always fills the window, so in a kiosk window the site is a separate `WebContentsView` (`rec.page`), below the toolbar or filling the window in full screen, and the window's own page stays blank.
That is what lets the bar switch a window between full screen and the toolbar.
A page's own full screen fills the window too, and leaving it restores the window only if the page was what made it full screen, so selkies leaving its full screen does not drop a full-screen kiosk window.
The toolbar's view grows over the site only while its Windows menu is open.
Both forms share one look: charcoal surfaces, a blue mark and active underline.
Open, the drop-down is a floating card that starts with the window's name, so it is clear which desktop it acts on; its separators show only between groups that have a button.
The toolbar is a 38 px strip with the config's `title` as a brand, **Back** (greyed out without history), **Reload** and **Home**, the page title centred, then the security chip and the window buttons, including **Maximise** since the window has no decorations.
The icons are Google's [Material Icons](https://github.com/google/material-design-icons), under the Apache License 2.0, as inline SVG, so the bar needs no icon font.
The settings overlay, the screen picker and the status pages use the same palette and mark.

The security chip is green when the page's certificate is trusted: verified by Chromium or a `tls.ca`, or pinned and unchanged.
It is amber for plain http, a `tls.insecure` host, or a pinned certificate that changed, and absent on status pages.
`tls.js` records how it accepted each host (`trust()`), which is what the chip reads; `toolbar.security: false` hides it.
Under i3 a window has no decorations because i3 tiles it, so there it shows only in full screen.

The buttons follow the config: **Reload** and **Quit** follow `keys.reload` and `keys.quit`, **Settings** follows `settingsPage`.
**Full screen** is hidden when `windowMode` is locked, except to leave a page's own full screen.
A desktop window has a button named after `title` that shows the launcher, and **Close**; the launcher has **Home** and **Back** when its address is not a desktop.
Each window's views are closed with it: a `WebContentsView`'s page outlives its window otherwise.

## Downloads and screen sharing

Download handlers are run with `spawn`, not `execFile`, so a long Citrix session's output cannot fill `execFile`'s buffer and kill it.
They run only for extensions listed in the config.

The screen picker uses `session.setDisplayMediaRequestHandler`, with the picker in its own view over the window.
Pages get no injected script, and `navigator.mediaDevices.getDisplayMedia` is not replaced.
Under Wayland, `desktopCapturer.getSources` goes through the desktop portal, which shows its own dialog and returns one source; the app's picker appears only when there is more than one source, which means X11.

Chromium no longer supports TLS 1.0 or 1.1, and no setting brings them back; `tls.insecure` covers certificate errors only.

## Kiosk storage

A kiosk keeps everything Electron writes in one directory on a tmpfs, set with `app.setPath` for `userData`, `sessionData`, `crashDumps`, `logs` and `downloads`, plus Chromium's `--disk-cache-dir`.
The name is fixed per profile, so Electron's single-instance lock, which lives in that directory, still finds a running copy.
`XDG_RUNTIME_DIR` is used only if `statfs` says it is a tmpfs or ramfs; some containers have it on disk.
`/dev/shm` is the fallback.

Setting the directory from JavaScript is not enough.
An audit run with a fresh `HOME` found the NVIDIA GL cache in `~/.cache/nvidia` and the NSS certificate database in `~/.local/share/pki`.
Chromium starts its GPU and utility processes with the environment it was launched with, and `process.env` changes in the main script never reach them.
The kiosk therefore re-execs itself once with `XDG_CACHE_HOME` and `XDG_DATA_HOME` inside the directory, using Node's `process.execve`.
`execve` keeps the PID, so an AppImage's FUSE mount stays up.
The user's original values travel in `AIRLOCK_BROWSER_KIOSK_ORIGINAL_ENV` and are restored for the integration status and for programs the app starts.
fontconfig writes its cache during Chromium's startup, before the main script runs, so it still lands in `~/.cache/fontconfig`.

Removal happens after exit.
Chromium's network service writes `Network Persistent State` and the cache index after the app's `quit` event, and Electron exits on SIGTERM without emitting `quit`.
A detached `sh` started at launch waits with `tail --pid` and then removes the directory, unless its `SingletonLock` symlink names a different PID, meaning a new instance has taken it over.
The app also removes the directory on `quit` and on `exit`, and on SIGTERM, SIGINT and SIGHUP it quits normally.

The audit, repeated for any change that touches storage: run a kiosk config with a fresh `HOME`, use the page, quit, then list every file newer than a marker under `HOME`, `/tmp`, `/var/tmp` and the runtime dir.
Send SIGTERM to the main process only.
`pkill -x electron` also kills the GPU and network processes, and the app then dies with SIGTRAP (`GPU process isn't usable. Goodbye.`).

## Packaging

An AppImage and an RPM, both built by electron-builder with Electron pinned in `package.json`.
Either way the app runs the same Electron on every machine.
The cost is about 125 MB per copy, and Chromium security updates arrive only with a rebuild.

The RPM is electron-builder's `rpm` target, which runs fpm and needs `rpmbuild`.
It is built with `_build_id_links none`: otherwise it owns `/usr/lib/.build-id` links that clash with any other Electron app installed from an RPM.
electron-builder's own remove script deletes the `/usr/bin/airlock-browser` link on every run, and on an upgrade the old package's remove script runs after the new one's install script, so the link was lost.
`build/rpm-after-remove.sh` is that script with a guard that skips it unless the package is really being erased; `build/rpm-posttrans.sh` re-creates the link at the end of the transaction, for upgrades from 0.2.0-beta.1 and earlier, whose remove scripts have no guard.
`publish` is off, so neither package carries electron-updater metadata; there is no auto-update.

`.github/workflows/release.yml` builds both on a version tag such as `1.0.0`, after checking the tag matches `package.json` and running the tests, and publishes them with `SHA256SUMS` as the tag's release.
`test.yml` runs the tests on every push to `main` and on pull requests, without downloading Electron.

npm 11 does not run Electron's download script on install, so `postinstall` runs it explicitly.

Electron's user data (cookies, site data) is set to `~/.local/share/airlock-browser` with `app.setPath`, and the app's own settings are in `~/.config/airlock-browser`.
`app.setName('airlock-browser')` sets the window class, which the KWin rule and i3 match on.
