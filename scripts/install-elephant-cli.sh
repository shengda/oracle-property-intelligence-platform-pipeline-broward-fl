#!/usr/bin/env bash
# Install the pinned Elephant CLI 2 build (elephant-cli.version) into ./bin.
# One CLI build per run: hash, validate, export-tables and upload all use this binary.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit="$(tr -d '[:space:]' < "$root/elephant-cli.version")"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) target=aarch64-apple-darwin ;;
  Darwin-x86_64) target=x86_64-apple-darwin ;;
  Linux-x86_64) target=x86_64-unknown-linux-musl ;;
  Linux-aarch64) target=aarch64-unknown-linux-musl ;;
  *) echo "unsupported platform $(uname -s)-$(uname -m)" >&2; exit 2 ;;
esac
mkdir -p "$root/bin"
archive="$root/bin/elephant-cli.tar.gz"
url="https://github.com/elephant-xyz/elephant-cli/releases/download/build-$commit/elephant-cli-$target.tar.gz"
echo "downloading $url"
curl -fL -o "$archive" "$url"
tar -xzf "$archive" -C "$root/bin"
rm -f "$archive"
"$root/bin/elephant-cli" --version
