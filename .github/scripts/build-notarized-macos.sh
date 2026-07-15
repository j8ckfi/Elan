#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

notary_profile="${NOTARY_PROFILE:-elan-notary}"
signing_identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$signing_identity" ]]; then
  signing_identity="$(
    security find-identity -v -p codesigning \
      | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
      | head -1
  )"
fi
if [[ -z "$signing_identity" ]]; then
  printf 'No Developer ID Application identity was found in the Keychain\n' >&2
  exit 1
fi

package_version="$(jq -r .version package.json)"
tauri_version="$(jq -r .version src-tauri/tauri.conf.json)"
cargo_version="$(sed -n '/^\[package\]$/,/^\[/s/^version = "\([^"]*\)"$/\1/p' src-tauri/Cargo.toml)"
if [[ "$package_version" != "$tauri_version" || \
      "$package_version" != "$cargo_version" ]]; then
  printf 'Version mismatch: package=%s tauri=%s cargo=%s\n' \
    "$package_version" "$tauri_version" "$cargo_version" >&2
  exit 1
fi

xcrun notarytool history --keychain-profile "$notary_profile" >/dev/null

export APPLE_SIGNING_IDENTITY="$signing_identity"
bunx tauri build \
  --target universal-apple-darwin \
  --bundles app,dmg \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'

bundle_dir="src-tauri/target/universal-apple-darwin/release/bundle"
shopt -s nullglob
apps=("$bundle_dir"/macos/*.app)
dmgs=("$bundle_dir"/dmg/*.dmg)
if (( ${#apps[@]} != 1 || ${#dmgs[@]} != 1 )); then
  printf 'Expected one app and one DMG; found %d and %d\n' \
    "${#apps[@]}" "${#dmgs[@]}" >&2
  exit 1
fi
app="${apps[0]}"
dmg="${dmgs[0]}"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
app_zip="$work_dir/Elan.app.zip"
ditto -c -k --keepParent "$app" "$app_zip"

xcrun notarytool submit "$app_zip" \
  --keychain-profile "$notary_profile" \
  --wait
xcrun stapler staple "$app"

xcrun notarytool submit "$dmg" \
  --keychain-profile "$notary_profile" \
  --wait
xcrun stapler staple "$dmg"

bash .github/scripts/verify-macos-release.sh "$app" "$dmg"

archive="$bundle_dir/macos/Elan_universal.app.tar.gz"
tar -czf "$archive" -C "$(dirname "$app")" "$(basename "$app")"

printf '\nNotarized release artifacts:\n%s\n%s\n' "$dmg" "$archive"
