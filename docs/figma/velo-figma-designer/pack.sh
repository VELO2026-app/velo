#!/usr/bin/env bash
# Builds velo-figma-designer-<version>.zip for a machine without the repo (the designer's computer).
#   bash docs/figma/velo-figma-designer/pack.sh [out-dir]     (default: current directory)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "${1:-.}"
OUT="$(cd "${1:-.}" && pwd)"
# The archive carries the skill version (DESIGNER_LIB_VERSION): the designer reports it (FE-234).
VERSION="$(sed -n 's/^const DESIGNER_LIB_VERSION = \([0-9]*\);.*/\1/p' "$HERE/scripts/designer-lib.figma.js")"
[ -n "$VERSION" ] || { echo "no DESIGNER_LIB_VERSION in scripts/designer-lib.figma.js" >&2; exit 1; }
ZIP="$OUT/velo-figma-designer-$VERSION.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PKG="$TMP/velo-figma-designer"
mkdir -p "$PKG/references"
cp -R "$HERE/SKILL.md" "$HERE/install.sh" "$HERE/scripts" "$PKG/"
cp "$HERE/../../figma-protocol.md" "$PKG/references/"
cp "$HERE/../designer-guide.md" "$PKG/Инструкция.md"
echo "$VERSION" > "$PKG/VERSION"
rm -f "$ZIP"
(cd "$TMP" && zip -qr "$ZIP" velo-figma-designer)
echo "$ZIP"
