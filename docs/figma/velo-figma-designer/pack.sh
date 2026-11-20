#!/usr/bin/env bash
# Builds velo-figma-designer.zip for a machine without the repo (the designer's computer).
#   bash docs/figma/velo-figma-designer/pack.sh [out-dir]     (default: current directory)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "${1:-.}"
OUT="$(cd "${1:-.}" && pwd)"
ZIP="$OUT/velo-figma-designer.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/velo-figma-designer"
mkdir -p "$PKG/references"
cp -R "$HERE/SKILL.md" "$HERE/install.sh" "$HERE/scripts" "$PKG/"
cp "$HERE/../../figma-protocol.md" "$PKG/references/"
cp "$HERE/../designer-guide.md" "$PKG/Инструкция.md"
rm -f "$ZIP"
(cd "$TMP" && zip -qr "$ZIP" velo-figma-designer)
echo "$ZIP"
