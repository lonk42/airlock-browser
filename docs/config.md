# Config file

`airlock-browser --config <file>` reads a YAML file that sets defaults, locks settings and turns on kiosk mode.
Without `--config` the app uses the settings page and `~/.config/airlock-browser/settings.json` alone.

The file is checked strictly.
An unknown key, a wrong type or a YAML tag stops the app with a window naming the problem, such as
`kiosk.yaml: koisk: unknown key. Known keys: version, kiosk, ...`.
Desktop entries set up from a run with `--config` start the app with the same file.

## Example

```yaml
version: 1
kiosk: true
profile: coder
title: Coder
settings:
  url: https://coder.example.lan
  windowMode: fullscreen
```

## Keys

| Key | Default | Kiosk default | Meaning |
|---|---|---|---|
| `version` | | | Required, `1`. |
| `kiosk` | `false` | | [Kiosk mode](#kiosk-mode). |
| `profile` | none | | A separate set of cookies, site data, settings and single-instance lock. Lowercase letters, digits and dashes. |
| `title` | `Airlock Browser` | | Window title until the page sets its own, and the title of status pages. |
| `settings.url` | | | Address to open. Required in kiosk mode, with `settingsPage: false`, or when `url` is locked. |
| `settings.display` | | | Output name, such as `DP-2`. |
| `settings.secondDisplay` | `auto` | | A selkies desktop's [second monitor](design.md#second-monitor): `auto`, `none` or an output name. X11 only. |
| `settings.windowMode` | | | `normal`, `maximized` or `fullscreen`. |
| `settings.captureKeys` | | | `true` or `false`. |
| `toolbar.fullscreen` | `true` | | In kiosk mode, the bar's **Full screen** and **Leave full screen** switch a window between full screen and the toolbar for the run, even with `windowMode` locked. |
| `toolbar.navigation` | `false` | | **Home** and **Back** on the bar when the address is a desktop origin, which has neither otherwise. For a site such as a video meeting that needs the desktop permissions. |
| `toolbar.security` | `true` | | The kiosk toolbar's security chip: green when the certificate is trusted, amber for http, `tls.insecure` or a changed pinned certificate. |
| `launcher.windowMode` | `settings.windowMode` | | The [launcher](#windows)'s own `normal`, `maximized` or `fullscreen`, such as a normal window for the login with full-screen desktops. |
| `lock` | none | `all` | Settings the user cannot change: a list of the names above, `all` or `none`. |
| `settingsPage` | `true` | `false` | Whether Ctrl+Alt+Shift+S opens the settings page. |
| `integration` | `manage` | `report` | `report` shows the integration items without **Set up** or **Remove**. |
| `keys.quit` | `true` | `true` | Ctrl+Alt+Shift+Q, and **Quit** on the bar. |
| `keys.reload` | `true` | `true` | Ctrl+Alt+Shift+R, and **Reload** on the bar. |
| `keys.settings` | `settingsPage` | `settingsPage` | Ctrl+Alt+Shift+S. |
| `keys.bar` | `true` | `true` | Ctrl+Alt+Shift+B. |
| `bar` | `auto` | `auto` | The drop-down bar: `auto` on full-screen and borderless windows, `always`, or `never`. In kiosk mode a window that is not full screen has a [toolbar](#kiosk-mode) instead. |
| `downloads` | a save dialog | none saved | See [Downloads](#downloads). |
| `media.screenPicker` | `false` | | A picker for screen sharing from a desktop origin's `getDisplayMedia`. |
| `media.hardwareVideo` | `false` | | VA-API video decode and encode. Untested. |
| `navigation.allow` | none | | Other origins pages may navigate to. |
| `navigation.auth` | none | | Login providers: navigable, and their popups open as child windows. |
| `navigation.desktops` | the origin of `url` | | Origins that get pointer lock, keyboard lock, clipboard and the other desktop permissions. |
| `navigation.offsite` | `browser` | `block` | What happens to any other address: the default browser, or nothing. |
| `tls.ca` | none | | PEM files of extra certificate authorities, relative to the config file. |
| `tls.pin` | the host of `url` | | Hosts that trust the first certificate they show in a run. |
| `tls.insecure` | none | | Hosts whose certificate is not checked. |

Origins are written `https://host`, `https://host:port` or `https://*.domain`.
`*.domain` matches any subdomain, not `domain` itself.
The `tls` keys take the same forms, or a bare host.

Settings from the file are the starting values.
Once the user saves the settings page, their own values win for every setting not in `lock`.
`AIRLOCK_BROWSER_URL` is ignored when `url` is locked.

## Coder

The Coder dashboard is the address, and workspace apps are the desktops.
Workspace apps must use subdomains (`subdomain = true` on the `coder_app`).
Coder signs in to an app through the dashboard, so both origins are allowed.

```yaml
version: 1
kiosk: true
profile: coder
title: Coder
settings:
  url: https://coder.example.lan
  windowMode: fullscreen                       # The desktops
launcher:
  windowMode: normal                           # The dashboard and its login
navigation:
  desktops: [https://*.coder.example.lan]
  auth: [https://login.microsoftonline.com]    # Only with an OIDC provider
tls:
  ca: [/etc/pki/example-ca.pem]                # Only for a private CA
```

## Windows

With `navigation.desktops` set, the address is a launcher, such as the Coder dashboard.
Each desktop it opens gets its own window, and opening the same desktop again brings that window to the front.
Closing the launcher while a desktop is open hides it; closing the last desktop shows it again.

## Downloads

With a `downloads` section, only the listed file extensions are saved.
Each is opened with its program, which gets the file path as its last argument, or only saved if the program is `null`.

```yaml
downloads:
  handlers:
    ica: [wfica]                         # Citrix Workspace
    rdp: [xfreerdp, /cert:ignore]
  dir: ~/Downloads                       # Optional; the kiosk directory in kiosk mode
  quit: handler                          # never, download or handler
```

`quit: handler` quits when the program exits with status 0, so the session ends with the remote one.
`quit: download` quits once the file is saved, without running anything.
In kiosk mode the file is deleted when its program exits, and the default directory is removed at quit, so `quit: download` needs a `dir`.

## Screen sharing

`media.screenPicker: true` answers `getDisplayMedia` from a desktop origin.
Under Wayland the desktop portal asks the user, and its choice is used.
Under X11 the app shows its own list of screens and windows.

## Profiles

| | Cookies and site data | settings.json |
|---|---|---|
| No profile | `~/.local/share/airlock-browser` | `~/.config/airlock-browser/` |
| `profile: coder` | `~/.local/share/airlock-browser/profiles/coder` | `~/.config/airlock-browser/profiles/coder/` |

Two profiles run side by side.
A second launch of the same profile brings its window to the front.

## Kiosk mode

`kiosk: true` keeps nothing on the local system.

- Cookies, site data, caches, crash dumps and logs go in a directory on a tmpfs:
  `$XDG_RUNTIME_DIR/airlock-browser-kiosk-<profile>` when that is a tmpfs, otherwise `/dev/shm/airlock-browser-kiosk-<profile>-<uid>`.
- The directory is emptied at start and removed when the app exits, including after a crash or SIGKILL.
- The user's `settings.json` is not read or written.
  Changes on the settings page, if it is enabled, last until the app quits.
- Every setting is locked and the settings page is off, unless the file says otherwise.
- No window-manager title bar shows. A window that is not full screen has the bar as a fixed toolbar above the page, and its title moves the window. Full screen, it is the drop-down. The bar switches a window between the two (`toolbar.fullscreen`), and `bar: never` removes both.
- The user logs in to the site at every start.

The app restarts itself once at launch, with `XDG_CACHE_HOME` and `XDG_DATA_HOME` pointed into the kiosk directory, so the GPU shader cache and Chromium's certificate database go there too.
[Detail](design.md#kiosk-storage)

Not covered:

- fontconfig can update its font cache in `~/.cache/fontconfig` before the restart.
  It lists font files only.
- PulseAudio's client library creates `~/.config/pulse/cookie` when the desktop plays sound, if it does not exist yet.
- KDE's notification history keeps the text of warnings the app shows.
- Swap can hold tmpfs pages.
