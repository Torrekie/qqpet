#!/bin/bash
# Offline native build. The web/resource preparation is a separate project step.
set -euo pipefail
ios_root="$(cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(cd -- "$ios_root/.." && pwd)"
fail() { printf '%s\n' "$*" >&2; exit 1; }
compile_only=false
for argument in "$@"; do
  case "$argument" in
    --compile-only) compile_only=true ;;
    --help)
      printf '%s\n' 'Usage: ios/build.sh [--compile-only]' \
        'Linux: set QQPET_SDK and QQPET_TOOLCHAIN_DIR (a bin directory), or QQPET_CC, QQPET_LD and QQPET_LDID.' \
        'Optional version guards: QQPET_CLANG_VERSION and QQPET_LD_VERSION.'
      exit 0 ;;
    *) fail "Unknown build argument: $argument" ;;
  esac
done
host_os="$(uname -s)"
case "$host_os" in Darwin|Linux) ;; *) fail "Unsupported build host: $host_os" ;; esac
minimum_ios=14.0
[[ "${QQPET_IOS_MIN_VERSION:-14.0}" == "$minimum_ios" ]] || fail 'The native host deployment target is iOS 14.0.'
architecture="${QQPET_ARCH:-arm64}"
case "$architecture" in arm64|arm64e) ;; *) fail "Unsupported iOS device architecture: $architecture" ;; esac

resolve_tool() {
  local executable resolved
  executable="$1"
  resolved="$(command -v -- "$executable")" || fail "Missing executable: $executable"
  [[ -f "$resolved" && -x "$resolved" ]] || fail "Expected one executable path: $executable"
  printf '%s/%s\n' "$(cd -- "$(dirname -- "$resolved")" && pwd)" "$(basename -- "$resolved")"
}
node="$(resolve_tool "${QQPET_NODE:-node}")"
python="$(resolve_tool "${QQPET_PYTHON:-python3}")"
absolute_path() { "$node" -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$1"; }
toolchain_dir="${QQPET_TOOLCHAIN_DIR:-}"
if [[ -n "$toolchain_dir" ]]; then
  [[ -d "$toolchain_dir" ]] || fail "Toolchain bin directory does not exist: $toolchain_dir"
  toolchain_dir="$(absolute_path "$toolchain_dir")"
fi
sdk_path="${QQPET_SDK:-${QQPET_IOS_SDK:-}}"
if [[ -z "$sdk_path" ]]; then
  [[ "$host_os" == Darwin ]] || fail 'Linux builds require QQPET_SDK pointing to an installed public iPhoneOS SDK.'
  sdk_path="$(xcrun --sdk iphoneos --show-sdk-path)"
fi
sdk_path="$(absolute_path "$sdk_path")"
[[ -f "$sdk_path/System/Library/Frameworks/UIKit.framework/Headers/UIKit.h" && -d "$sdk_path/usr/lib" ]] || fail "Not a public iPhoneOS SDK: $sdk_path"
cc="${QQPET_CC:-}"
ld="${QQPET_LD:-}"
if [[ -n "$toolchain_dir" ]]; then
  [[ -n "$cc" ]] || cc="$toolchain_dir/clang"
  if [[ -z "$ld" ]]; then
    if [[ -x "$toolchain_dir/ld" ]]; then ld="$toolchain_dir/ld"
    else ld="$toolchain_dir/aarch64-apple-darwin14-ld"; fi
  fi
fi
if [[ "$host_os" == Darwin ]]; then
  [[ -n "$cc" ]] || cc="$(xcrun --find clang)"
  [[ -n "$ld" ]] || ld="$(xcrun --find ld)"
fi
[[ -n "$cc" && -n "$ld" ]] || fail 'Set QQPET_CC and QQPET_LD, or QQPET_TOOLCHAIN_DIR.'
cc="$(resolve_tool "$cc")"
ld="$(resolve_tool "$ld")"
cc_version="$("$cc" --version)"
ld_version="$("$ld" -v 2>&1 || true)"
[[ "$cc_version" == *clang* ]] || fail 'The selected compiler must be Clang.'
[[ "$ld_version" == *PROJECT:ld* || "$ld_version" == *PROJECT:dyld* || "$ld_version" == *ld64-* ]] || fail 'QQPET_LD must select Apple ld/ld64, including its Linux cctools port.'
if [[ -n "${QQPET_CLANG_VERSION:-}" ]]; then
  [[ "$cc_version" == *"$QQPET_CLANG_VERSION"* ]] || fail 'The compiler version does not match QQPET_CLANG_VERSION.'
fi
if [[ -n "${QQPET_LD_VERSION:-}" ]]; then
  [[ "$ld_version" == *"$QQPET_LD_VERSION"* ]] || fail 'The linker version does not match QQPET_LD_VERSION.'
fi
ldid="${QQPET_LDID:-}"
if [[ -z "$ldid" && -n "$toolchain_dir" && -x "$toolchain_dir/ldid" ]]; then ldid="$toolchain_dir/ldid"; fi
if [[ -z "$ldid" ]] && command -v ldid >/dev/null 2>&1; then ldid=ldid; fi
if [[ -n "$ldid" ]]; then ldid="$(resolve_tool "$ldid")"
elif [[ "$host_os" == Darwin ]]; then codesign="$(resolve_tool codesign)"
else fail 'Linux builds require QQPET_LDID or an installed ldid. No unsigned package is produced.'; fi
build_root="$(absolute_path "${QQPET_IOS_BUILD_DIR:-$repo_root/out/ios-native}")"
web_root="$(absolute_path "${QQPET_WEB_ROOT:-$repo_root/out/ios}")"
resource_root="$(absolute_path "${QQPET_RESOURCES_ROOT:-$repo_root/out/ios-assets}")"
app_version="$("$node" "$repo_root/scripts/version.mjs" --field version)"
if [[ "$compile_only" == false ]]; then
  [[ -f "$web_root/index.html" && -f "$web_root/game.html" ]] || fail "Missing iOS web output: $web_root. Run the separate web build first."
  "$node" - "$web_root/version.json" "$app_version" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const expected = process.argv[3]
const actual = JSON.parse(fs.readFileSync(file, 'utf8'))
if (actual.version !== expected) throw new Error('Web/native versions differ; rebuild the web output with the same version inputs.')
NODE
fi
bundle_dir="$build_root/Payload/QQPet.app"
mkdir -p "$build_root/obj" "$bundle_dir"
common=(-target "$architecture-apple-ios$minimum_ios" -isysroot "$sdk_path" -fobjc-arc -fblocks -O2
  -I"$ios_root/native" -I"$ios_root/vendor/TrollSpeed/headers" -I"$ios_root/vendor/TrollSpeed/KIF")
common+=(-std=gnu11)
signature="$(printf '%s\n' "$sdk_path" "$cc" "$cc_version" "${common[@]}" | "$node" -e 'const c=require("node:crypto");let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(c.createHash("sha256").update(s).digest("hex")))')"
old_signature="$(cat "$build_root/compile-signature" 2>/dev/null || true)"
objects=()
for source in "$ios_root"/native/*.m "$ios_root"/vendor/TrollSpeed/KIF/*.m; do
  object="$build_root/obj/$(basename "$source").o"
  objects+=("$object")
  changed=false
  if [[ ! -f "$object" || "$source" -nt "$object" || "$signature" != "$old_signature" ]]; then changed=true; fi
  for header in "$ios_root"/native/*.h "$ios_root"/vendor/TrollSpeed/headers/*.h "$ios_root"/vendor/TrollSpeed/KIF/*.h; do
    if [[ "$header" -nt "$object" ]]; then changed=true; break; fi
  done
  if [[ "$changed" == true ]]; then
    printf 'Compiling %s\n' "$(basename "$source")"
    "$cc" "${common[@]}" -c "$source" -o "$object"
  fi
done
link_args=("${common[@]}" "-fuse-ld=$ld" "${objects[@]}")
if [[ -n "${QQPET_IOS_CLANG_RT:-}" ]]; then
  [[ -f "$QQPET_IOS_CLANG_RT" ]] || fail "Missing iOS compiler-rt archive: $QQPET_IOS_CLANG_RT"
  link_args+=("$(absolute_path "$QQPET_IOS_CLANG_RT")")
fi
"$cc" "${link_args[@]}" -Wl,-adhoc_codesign -o "$bundle_dir/QQPetIOS" \
  -framework Foundation -framework UIKit -framework WebKit -framework QuartzCore -framework CoreGraphics -framework CoreFoundation -framework AudioToolbox -framework AVFoundation
printf '%s\n' "$signature" > "$build_root/compile-signature"
"$node" "$repo_root/scripts/version.mjs" --plist "$ios_root/Info.plist" --output "$bundle_dir/Info.plist"
cp "$ios_root"/icons/*.png "$bundle_dir/"
cp "$ios_root/audio-policy.js" "$bundle_dir/"
if [[ "$compile_only" == false ]]; then
  if [[ ! -f "$web_root/index.html" || ! -f "$web_root/game.html" ]]; then printf 'Missing built iOS web pages in %s. Run the separate web build first.\n' "$web_root" >&2; exit 1; fi
  if [[ ! -d "$resource_root/pet" ]]; then resource_root="$repo_root/resources"; fi
  if [[ ! -d "$resource_root/pet" ]]; then printf 'Missing pet resources; set QQPET_RESOURCES_ROOT to verified real assets.\n' >&2; exit 1; fi
  # One small process checks pointer files before copying. It never fetches LFS objects.
  "$node" - "$resource_root/pet" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
const root=process.argv[2];
function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);else if(entry.isFile()&&fs.statSync(file).size<1024){const bytes=fs.readFileSync(file);if(bytes.subarray(0,43).toString().startsWith('version https://git-lfs.github.com/spec/v1'))throw Error(`Git LFS pointer: ${file}`)}}}
scan(root);
NODE
  mkdir -p "$bundle_dir/web"
  rsync -a --delete --exclude='/pet/' --exclude='/icons/' "$web_root/" "$bundle_dir/web/"
  mkdir -p "$bundle_dir/web/pet"
  rsync -a --delete "$resource_root/pet/" "$bundle_dir/web/pet/"
  if [[ -d "$resource_root/icons" ]]; then mkdir -p "$bundle_dir/web/icons"; rsync -a --delete "$resource_root/icons/" "$bundle_dir/web/icons/"; fi
fi
if [[ -n "$ldid" ]]; then "$ldid" -Cadhoc -S"$ios_root/entitlements.plist" "$bundle_dir/QQPetIOS"
else "$codesign" --force --sign - --entitlements "$ios_root/entitlements.plist" "$bundle_dir/QQPetIOS"; fi
"$python" "$repo_root/scripts/check-ios-binary.py" "$bundle_dir/QQPetIOS" --arch "$architecture" --minimum "$minimum_ios" --entitlements "$ios_root/entitlements.plist"
if [[ "$compile_only" == true ]]; then printf 'Native compilation complete; web/assets omitted: %s\n' "$bundle_dir"; exit 0; fi
# Build directly in Payload; do not duplicate the full asset bundle for packaging.
ipa_temp="$build_root/QQPetIOS.new.ipa"
rm -f "$ipa_temp"
(cd "$build_root" && zip -q -r "$ipa_temp" Payload)
mv -f "$ipa_temp" "$build_root/QQPetIOS.ipa"
printf 'Built %s\n' "$build_root/QQPetIOS.ipa"
