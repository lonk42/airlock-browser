#!/bin/bash

# Re-creates /usr/bin/airlock-browser at the end of the transaction, after
# every %postun has run. Remove scripts in releases up to 0.2.0-beta.1 delete
# the link on upgrade, after this package's %post has made it; this puts it
# back. Same commands as electron-builder's after-install.tpl.
# fpm does not expand electron-builder's ${...} macros here, so the paths are
# written out.
target='/opt/Airlock Browser/airlock-browser'
link='/usr/bin/airlock-browser'

[ -x "$target" ] || exit 0

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --install "$link" airlock-browser "$target" 100 || ln -sf "$target" "$link"
else
    ln -sf "$target" "$link"
fi
exit 0
