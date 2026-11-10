# Airlock Browser

A locked-down browser window for one site or remote desktop on Linux.
It has no browser chrome and no keyboard shortcuts of its own, so key sequences such as Ctrl+W, Ctrl+T and F11 reach the page.
Under KDE Plasma and i3 it also releases the window manager's shortcuts while it has focus, so Alt+Tab, Meta and Alt+1..0 reach the page too.

Typical uses:

- A selkies desktop, such as [dailytop](https://github.com/lonk42/dailytop) or webtop, as a desktop app
- A Coder dashboard, with each workspace desktop in its own window
- A thin-client kiosk for a web portal that hands out Citrix or RDP sessions

## Features

- **Keyboard passthrough.**
  Everything except Ctrl+Alt+F1..F12 and the escape keys below.
  [Detail](docs/design.md#keyboard)
- **KDE Plasma and i3 integration.**
  A KWin window rule, or an i3 mode, set up from the settings.
  [Detail](docs/design.md#window-manager-integration)
- **Monitor and window size.**
  Window, maximised or full screen, on a chosen monitor.
  [Detail](docs/design.md#placement)
- **Second monitor.**
  Under X11, a selkies desktop extends onto a second monitor, chosen automatically or in the settings.
  [Detail](docs/design.md#second-monitor)
- **Certificate pinning.**
  A self-signed certificate is trusted for the session on first connection.
  A config file can add a private CA.
  [Detail](docs/design.md#tls)
- **Reconnect.**
  An unreachable page shows a status page and retries, from 1s up to every 30s.
  A desktop that answers with an HTTP error, such as Coder's `404 - Application Not Found` while a workspace restarts, is retried the same way.
- **Window bar.**
  Full-screen windows have a drop-down bar with the window actions.
  In kiosk mode, other windows have it as a toolbar, with a certificate status chip.
  [Detail](docs/design.md#bar)
- **One window per desktop.**
  A launcher page, such as a Coder dashboard, opens each desktop in its own window.
  [Detail](docs/config.md#windows)
- **Config file and kiosk mode.**
  `--config` sets defaults and locks settings; kiosk mode keeps no data on the local system.
  [Detail](docs/config.md)
- **Download handlers.**
  Listed file types, such as Citrix `.ica` and `.rdp`, are opened with their program, and the app can quit when it exits.
  [Detail](docs/config.md#downloads)
- **Screen sharing.**
  A screen and window picker for pages that share a screen.
  [Detail](docs/config.md#screen-sharing)

## Install

Each [release](https://github.com/lonk42/airlock-browser/releases) has an AppImage and an RPM for x86_64 Linux, with `SHA256SUMS`.

The AppImage runs anywhere with FUSE, without installing:

```bash
mkdir -p ~/Applications
install -m755 airlock-browser-*-x86_64.AppImage ~/Applications/airlock-browser.AppImage
~/Applications/airlock-browser.AppImage
```

The RPM installs to `/opt/Airlock Browser` with `airlock-browser` on the path, and is tested on Fedora:

```bash
sudo dnf install ./airlock-browser-*-x86_64.rpm
airlock-browser
```

The first launch opens the settings.
Enter the address, then **Set up** each item under Integration that you want:

- **KWin window rule** (KDE) or **i3 mode** (i3), for key capture and the monitor choice
- **Application menu** entry
- **Start at login**

The entries run the AppImage from where it was when you set them up.
Replace the file at the same path to upgrade, or install the newer RPM.

## Usage

```text
Ctrl+Alt+Shift+S         # Settings
Ctrl+Alt+Shift+R         # Reload, and trust a changed certificate
Ctrl+Alt+Shift+Q         # Quit
Ctrl+Alt+Shift+B         # Open the bar
Ctrl+Alt+Shift+Escape    # i3: leave the Airlock Browser mode manually
```

A full-screen or borderless window has a tab at the top centre.
Hovering it opens a bar with these actions, a window list and **Leave full screen**.

## Configuration

The settings are saved in `~/.config/airlock-browser/settings.json`, and cookies and site data in `~/.local/share/airlock-browser`.
`AIRLOCK_BROWSER_URL` in the environment overrides the address for one run.

`--config <file>` reads a [YAML config file](docs/config.md) with defaults, locked settings, profiles and kiosk mode:

```bash
~/Applications/airlock-browser.AppImage --config /etc/airlock-browser/coder.yaml
```

## Important notes

- With **Start at login**, the window can open before the site is up.
  It shows `Cannot reach https://…` and connects when the site answers.
- A server that generates a new self-signed certificate, such as a rebuilt container, shows `The certificate of … changed` until Ctrl+Alt+Shift+R.
- Monitor changes take effect at the next launch.
- If the app is killed under i3, a watcher process returns i3 to the default mode.
  If that is killed as well, use Ctrl+Alt+Shift+Escape.

## Build

```bash
npm ci           # Downloads Electron
npm test         # Settings, config file and integration tests
npm start        # Run from the checkout
npm run build    # dist/airlock-browser-<version>-x86_64.AppImage and .rpm (needs rpmbuild)
```

## Future

- Test `media.hardwareVideo` on a machine with VA-API
- Test the screen picker under X11 with real sources

## Documentation

| Doc | Contents |
|---|---|
| [docs/config.md](docs/config.md) | The `--config` file: every key, profiles, kiosk mode, examples |
| [docs/design.md](docs/design.md) | Keyboard, window-manager integration, placement, TLS, navigation, windows, bar, kiosk storage, packaging and releases |
