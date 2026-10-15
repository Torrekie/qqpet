#!/usr/bin/env bash
set -euo pipefail

# Build and verify the pinned Ruffle runtime without changing npm dependencies.
# All disposable toolchains, caches and sources belong to this invocation.
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
: "${RUNNER_TEMP:?RUNNER_TEMP must name the runner temporary directory}"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  echo 'This experimental build requires Linux x86_64.' >&2
  exit 1
}

df -h -- "$RUNNER_TEMP" "$repo"
free -h
disk_kib=$(df -Pk -- "$RUNNER_TEMP" | awk 'NR == 2 { print $4 }')
memory_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
cpus=$(nproc)
if (( disk_kib < 12 * 1024 * 1024 )); then
  echo 'Ruffle requires at least 12 GiB of free temporary disk space.' >&2
  exit 1
fi
if (( memory_kib < 4 * 1024 * 1024 )); then
  echo 'Ruffle requires at least 4 GiB of available memory.' >&2
  exit 1
fi
build_jobs=2
if (( memory_kib < 6 * 1024 * 1024 || cpus < 2 )); then build_jobs=1; fi
printf 'Available memory: %s KiB; CPUs: %s; build jobs: %s\n' "$memory_kib" "$cpus" "$build_jobs"

for tool in curl sha256sum tar xz unzip git python3 rustup java cc c++ make clang-18 llvm-ar-18; do
  command -v "$tool" >/dev/null || { echo "Missing build dependency: $tool" >&2; exit 1; }
done
chrome=$(command -v google-chrome || command -v google-chrome-stable || true)
[[ -n "$chrome" ]] || { echo 'Google Chrome is required for the lifetime check.' >&2; exit 1; }
libclang_found=false
for library in /usr/lib/llvm-18/lib/libclang.so* /usr/lib/llvm-18/lib/libclang-18.so*; do
  if [[ -f "$library" ]]; then libclang_found=true; break; fi
done
[[ $libclang_found == true ]] || {
  echo 'LLVM 18 libclang is required by the pinned jpegxr bindgen build.' >&2
  exit 1
}
movie="$repo/resources/pet/Action/GG/Egg/Stand.swf"
python3 - "$movie" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
if not path.is_file() or path.read_bytes()[:3] not in (b'FWS', b'CWS', b'ZWS'):
    raise SystemExit('Fetch resources/pet/Action/GG/Egg/Stand.swf with Git LFS before building.')
PY

task=$(mktemp -d "$RUNNER_TEMP/qqpet-ruffle.XXXXXXXX")
trap 'rm -rf -- "$task"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$task/tools/bin" "$task/tmp" "$task/downloads" "$task/logs"
rustup=$(command -v rustup)
export RUSTUP_HOME="$task/rustup" CARGO_HOME="$task/cargo"
export TMPDIR="$task/tmp" NPM_CONFIG_CACHE="$task/npm-cache"
export RUSTUP_TOOLCHAIN=1.98.0 CARGO_BUILD_JOBS="$build_jobs" BINARYEN_CORES="$build_jobs"
export LIBCLANG_PATH=/usr/lib/llvm-18/lib
export CC_wasm32_unknown_unknown=clang-18 AR_wasm32_unknown_unknown=llvm-ar-18
export NODE_OPTIONS=--max-old-space-size=2048
for tool in cargo rustc rustdoc rustup; do ln -s "$rustup" "$task/tools/bin/$tool"; done

download() {
  local url=$1 digest=$2 destination=$3
  curl --fail --location --retry 3 --silent --show-error "$url" --output "$destination"
  if ! printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status; then
    echo "Checksum mismatch: $url" >&2
    return 1
  fi
}

run_logged() {
  local label=$1 status
  shift
  echo "$label"
  if "$@" >"$task/logs/$label.log" 2>&1; then return 0; else status=$?; fi
  python3 - "$task/logs/$label.log" <<'PY'
import pathlib, re, sys
lines = pathlib.Path(sys.argv[1]).read_text(errors='replace').splitlines()
first = next((i for i, line in enumerate(lines) if re.search(r'\berror(?:\[|:|\s)', line, re.I)), None)
if first is not None and first < len(lines) - 80:
    print('\n'.join(lines[max(0, first - 5):first + 20]))
    print('... last 80 log lines ...')
print('\n'.join(lines[-80:]))
PY
  return "$status"
}

download 'https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz' \
  cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008 "$task/downloads/node.tar.xz"
mkdir "$task/node"
tar -xJf "$task/downloads/node.tar.xz" -C "$task/node" --strip-components=1
download 'https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.127/wasm-bindgen-0.2.127-x86_64-unknown-linux-musl.tar.gz' \
  61d4a7dc85acfa0d2354ccc0b8361928c7e52a746d17f28ebaa795ed3dc1614a "$task/downloads/wasm-bindgen.tar.gz"
tar -xzf "$task/downloads/wasm-bindgen.tar.gz" -C "$task/tools/bin" \
  --strip-components=1 --wildcards '*/wasm-bindgen'
download 'https://github.com/WebAssembly/binaryen/releases/download/version_129/binaryen-version_129-x86_64-linux.tar.gz' \
  50b9fa62b9abea752da92ec57e0c555fee578760cd237c40107957715d2976ba "$task/downloads/binaryen.tar.gz"
# This is the same single-binary extraction used by Ruffle's official Dockerfile.
tar -xzf "$task/downloads/binaryen.tar.gz" -C "$task/tools/bin" \
  --strip-components=2 --wildcards '*/bin/wasm-opt'
export PATH="$task/node/bin:$task/tools/bin:$PATH"
run_logged rust-toolchain "$rustup" toolchain install 1.98.0 --profile minimal --component rust-src --target wasm32-unknown-unknown
node --version
rustc --version
wasm-bindgen --version
wasm-opt --version
java -version
clang-18 --version

archive_sha=0eeb2575b3eca698939364b0cbb38505cc7fa773ac07fb33985089e92c97c5cc
download 'https://github.com/ruffle-rs/ruffle/releases/download/v0.6.0/ruffle-0.6.0-reproducible-source.zip' \
  "$archive_sha" "$task/downloads/source.zip"
source="$task/source"
mkdir "$source"
unzip -q "$task/downloads/source.zip" -d "$source"
[[ -f "$source/tools/asc/asc.jar" ]] || { echo 'The source archive is missing asc.jar.' >&2; exit 1; }
python3 - "$source/web/version_seal.json" <<'PY'
import json, sys
seal = json.load(open(sys.argv[1]))
assert seal['version_number'] == '0.6.0', 'Unexpected Ruffle source version'
assert seal['commitHash'] == 'cac5c99ce4a17e606f4ee3090389bb878f852055', 'Unexpected Ruffle source commit'
PY
export CARGO_TARGET_DIR="$source/target"
export BUILD_WASM_MVP=true ENABLE_VERSION_SEAL=true WASM_SOURCE=cargo CARGO_FEATURES=jpegxr
cp "$source/web/src/audio.rs" "$task/audio.original.rs"
cd "$source/web"
run_logged npm-install npm ci --no-audit --no-fund

add_counter() {
  python3 - "$source/web/src/audio.rs" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
edits = {
    'pub struct WebAudioBackend {': '''thread_local! {
    static LIVE_BUFFERS: Cell<u32> = const { Cell::new(0) };
}

#[wasm_bindgen]
pub fn audio_buffer_count() -> u32 {
    LIVE_BUFFERS.with(Cell::get)
}

pub struct WebAudioBackend {''',
    '        Ok(buffer)\n': '        LIVE_BUFFERS.with(|count| count.set(count.get() + 1));\n        Ok(buffer)\n',
    'impl Drop for Buffer {\n    fn drop(&mut self) {': 'impl Drop for Buffer {\n    fn drop(&mut self) {\n        LIVE_BUFFERS.with(|count| count.set(count.get() - 1));',
}
for old, new in edits.items():
    assert text.count(old) == 1, f'Counter patch must match exactly once: {old!r}'
    text = text.replace(old, new)
path.write_text(text)
PY
}

apply_fix() {
  cp "$task/audio.original.rs" "$source/web/src/audio.rs"
  (cd "$source" && git apply --check "$repo/scripts/patches/ruffle-audio-lifetime.patch")
  (cd "$source" && git apply "$repo/scripts/patches/ruffle-audio-lifetime.patch")
}

build_bundle() {
  local label=${1##*/}
  run_logged "$label-core" npm run build --workspace=ruffle-core
  run_logged "$label-selfhosted" npm run build --workspace=ruffle-selfhosted
  test -s packages/selfhosted/dist/ruffle.js
  cp -a packages/selfhosted/dist "$1"
}

# Only these temporary diagnostic builds expose the live Rust Buffer counter.
add_counter
build_bundle "$task/baseline"
apply_fix
add_counter
build_bundle "$task/fixed"
node "$repo/scripts/check-ruffle-lifetime.mjs" \
  --baseline "$task/baseline" --fixed "$task/fixed" --movie "$movie" --chrome "$chrome"
rm -rf -- "$task/baseline" "$task/fixed"

# Restore the exact original source before applying only the production fix.
# All build flags remain identical, allowing Cargo to reuse both profile caches.
apply_fix
build_bundle "$task/production"
node --input-type=module - "$task/production" "$source/web/packages/core/dist/ruffle_web-wasm_mvp_bg.wasm" "$repo/scripts/patches/ruffle-audio-lifetime.patch" <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const [bundle, mvp, patch] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = {};
function wasmExports(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('Invalid Wasm header');
  let at = 8;
  const uint = () => {
    let value = 0, shift = 0, byte;
    do {
      if (at >= bytes.length || shift > 28) throw new Error('Invalid Wasm integer');
      byte = bytes[at++]; value += (byte & 127) * 2 ** shift; shift += 7;
    } while (byte & 128);
    return value;
  };
  while (at < bytes.length) {
    const section = bytes[at++], size = uint(), end = at + size;
    if (end > bytes.length) throw new Error('Invalid Wasm section');
    if (section === 7) {
      const names = [], count = uint();
      for (let i = 0; i < count; ++i) {
        const length = uint();
        names.push(bytes.subarray(at, at + length).toString('utf8')); at += length;
        ++at; uint();
      }
      if (at !== end) throw new Error('Invalid Wasm exports');
      return names;
    }
    at = end;
  }
  return [];
}
function inventory(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) inventory(path, relative + '/');
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      if (((relative.endsWith('.js') || relative.endsWith('.map')) && bytes.includes('audio_buffer_count')) ||
          (relative.endsWith('.wasm') && wasmExports(bytes).includes('audio_buffer_count')))
        throw new Error('A diagnostic audio counter remains in the production bundle');
      files[relative] = hash(bytes);
    } else throw new Error('Unexpected non-file bundle entry: ' + relative);
  }
}
inventory(bundle);
const mvpHash = hash(readFileSync(mvp));
const fallbacks = Object.keys(files).filter(name => name.endsWith('.wasm') && files[name] === mvpHash);
if (fallbacks.length !== 1 || basename(fallbacks[0]) !== fallbacks[0]) throw new Error('Expected exactly one matching root MVP Wasm asset');
if (!files['ruffle.js']) throw new Error('Missing Ruffle loader');
const manifest = {
  schemaVersion: 1,
  ruffleVersion: '0.6.0',
  source: {
    commit: 'cac5c99ce4a17e606f4ee3090389bb878f852055',
    archiveSha256: '0eeb2575b3eca698939364b0cbb38505cc7fa773ac07fb33985089e92c97c5cc',
  },
  patch: { path: 'scripts/patches/ruffle-audio-lifetime.patch', sha256: hash(readFileSync(patch)) },
  toolchain: { rust: '1.98.0', wasmBindgen: '0.2.127', binaryen: '129', node: '24.22.0' },
  fallbackWasm: fallbacks[0],
  files,
};
writeFileSync(join(bundle, 'qqpet-runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Production runtime verified; MVP asset: ' + manifest.fallbackWasm);
JS

cd "$repo"
mkdir -p out
rm -rf -- out/ruffle-runtime
cp -a "$task/production" out/ruffle-runtime
echo 'Complete production runtime: out/ruffle-runtime'
