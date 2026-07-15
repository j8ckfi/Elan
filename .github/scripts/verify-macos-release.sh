#!/usr/bin/env bash
set -euo pipefail

if (( $# == 2 )); then
  app="$1"
  dmg="$2"
elif (( $# == 0 )); then
  bundle_dir="src-tauri/target/universal-apple-darwin/release/bundle"
  shopt -s nullglob
  apps=("$bundle_dir"/macos/*.app)
  dmgs=("$bundle_dir"/dmg/*.dmg)

  if (( ${#apps[@]} != 1 )); then
    printf 'Expected exactly one app bundle in %s/macos; found %d\n' \
      "$bundle_dir" "${#apps[@]}" >&2
    exit 1
  fi
  if (( ${#dmgs[@]} != 1 )); then
    printf 'Expected exactly one DMG in %s/dmg; found %d\n' \
      "$bundle_dir" "${#dmgs[@]}" >&2
    exit 1
  fi

  app="${apps[0]}"
  dmg="${dmgs[0]}"
else
  printf 'Usage: %s [APP DMG]\n' "$0" >&2
  exit 2
fi

echo "Verifying code signature: $app"
codesign --verify --deep --strict --verbose=2 "$app"

echo "Asking Gatekeeper to assess: $app"
spctl --assess --type execute --verbose=2 "$app"

echo "Validating stapled notarization ticket: $app"
xcrun stapler validate "$app"

echo "Verifying code signature: $dmg"
codesign --verify --strict --verbose=2 "$dmg"

echo "Asking Gatekeeper to assess: $dmg"
spctl --assess --type open \
  --context context:primary-signature --verbose=2 "$dmg"

echo "Validating stapled notarization ticket: $dmg"
xcrun stapler validate "$dmg"

mount_dir="$(mktemp -d)"
cleanup() {
  hdiutil detach "$mount_dir" -quiet >/dev/null 2>&1 || true
  rmdir "$mount_dir" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Mounting installer and verifying its app"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
shopt -s nullglob
mounted_apps=("$mount_dir"/*.app)
if (( ${#mounted_apps[@]} != 1 )); then
  printf 'Expected exactly one app in mounted DMG; found %d\n' \
    "${#mounted_apps[@]}" >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "${mounted_apps[0]}"
spctl --assess --type execute --verbose=2 "${mounted_apps[0]}"
