#!/bin/sh
# Build Power.app into ~/Applications. Icon comes from ~/.power/avatars/power.* if present.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
OUT="$HOME/Applications/Power.app"
TMP=$(mktemp -d)
mkdir -p "$TMP/Power.app/Contents/MacOS" "$TMP/Power.app/Contents/Resources"
swiftc -O -o "$TMP/Power.app/Contents/MacOS/Power" "$DIR/mac/PowerApp.swift" -framework Cocoa -framework WebKit

ICON=$(ls "$HOME/.power/avatars/power."* 2>/dev/null | head -1 || true)
if [ -n "$ICON" ]; then
  SET="$TMP/Power.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -s format png -z $s $s "$ICON" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -s format png -z $((s*2)) $((s*2)) "$ICON" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$TMP/Power.app/Contents/Resources/Power.icns"
fi

cat > "$TMP/Power.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Power</string>
  <key>CFBundleDisplayName</key><string>Power</string>
  <key>CFBundleIdentifier</key><string>local.power.agent</string>
  <key>CFBundleExecutable</key><string>Power</string>
  <key>CFBundleIconFile</key><string>Power</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.3.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>PowerDir</key><string>$DIR</string>
</dict></plist>
PLIST
codesign --force --sign - "$TMP/Power.app" >/dev/null 2>&1 || true
mkdir -p "$HOME/Applications"
rm -rf "$OUT"; mv "$TMP/Power.app" "$OUT"; rm -rf "$TMP"
echo "built $OUT"
