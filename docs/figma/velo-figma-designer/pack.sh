#!/usr/bin/env bash
# Builds velo-figma-designer.zip for a machine without the repo (the designer's Mac).
#   bash docs/figma/velo-figma-designer/pack.sh [out-dir]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$PWD}"
TMP="$(mktemp -d)"
PKG="$TMP/velo-figma-designer"
mkdir -p "$PKG/references"
cp -R "$HERE/SKILL.md" "$HERE/install.sh" "$HERE/scripts" "$PKG/"
cp "$HERE/../../figma-protocol.md" "$PKG/references/"
cp "$HERE/../designer-guide.md" "$PKG/Инструкция.md"
(cd "$TMP" && zip -qr "$OUT/velo-figma-designer.zip" velo-figma-designer)
rm -rf "$TMP"
echo "$OUT/velo-figma-designer.zip"
