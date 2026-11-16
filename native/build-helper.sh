#!/usr/bin/env bash
# Builds EpicClaimsNotifier.app without Xcode (Command Line Tools + swiftc).
#
# Deliberately frozen and generic: keep this binary behaviour-free so releases do
# not need to re-sign it. Re-signing an ad-hoc bundle changes its cdhash, which is
# the designated requirement macOS stores with the user's notification grant.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/build}"
app="$out/EpicClaimsNotifier.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

echo "==> compiling (swiftc)"
xcrun --find swiftc >/dev/null
arch="$(uname -m)"
swiftc -O -swift-version 5 \
  -target "${arch}-apple-macos12.0" \
  -framework AppKit -framework UserNotifications \
  -o "$app/Contents/MacOS/EpicClaimsNotifier" \
  "$here/EpicClaimsNotifier/EpicClaimsNotifier.swift"

cp "$here/EpicClaimsNotifier/Info.plist" "$app/Contents/Info.plist"
# Notification banners draw the sending bundle's icon; without an .icns the alert
# shows a generic placeholder.
cp "$here/EpicClaimsNotifier/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

echo "==> signing (ad-hoc, stable identifier)"
codesign --force --deep --sign - --identifier com.diy23.epic-claims.notifier "$app"
codesign -dv "$app" 2>&1 | sed 's/^/    /'

echo "==> registering with LaunchServices"
lsregister="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$lsregister" ] && "$lsregister" -f "$app" || true

echo "built: $app"
