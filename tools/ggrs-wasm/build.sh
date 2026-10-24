#!/usr/bin/env bash
# Rebuilds ../../interpreter/vendor/ggrs/ from src/ with GGRS pinned in
# Cargo.toml. Needs Rust 1.94.1 with the wasm32-unknown-unknown target
# (rustup reads rust-toolchain.toml) and wasm-bindgen-cli 0.2.129, the
# version Cargo.toml pins, which this installs under target/ if missing.
set -euo pipefail

TOOLCHAIN=1.94.1
BINDGEN=0.2.129

here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../interpreter/vendor/ggrs"
cd "$here"

version=$(rustc --version)
[[ $version == "rustc $TOOLCHAIN "* ]] || { echo "need rustc $TOOLCHAIN, found: $version" >&2; exit 1; }

bindgen="$here/target/bindgen/bin/wasm-bindgen"
if [[ ! -x $bindgen || $("$bindgen" --version) != "wasm-bindgen $BINDGEN" ]]; then
  cargo install --locked --root "$here/target/bindgen" wasm-bindgen-cli --version "=$BINDGEN"
fi

cargo_home=${CARGO_HOME:-$HOME/.cargo}
# Path prefixes leak into panic messages; map them to fixed names.
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$here=/ggrs-wasm"
cargo build --locked --release --target wasm32-unknown-unknown

mkdir -p "$out"
"$bindgen" --target web --no-typescript --out-dir "$out" target/wasm32-unknown-unknown/release/ggrs_wasm.wasm
shasum -a 256 "$out"/*
