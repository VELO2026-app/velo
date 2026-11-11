#!/bin/sh
# FE-162: shoot the key screens on two builds and compare them.
#   sh e2e/visual/run.sh <base-dist> <head-dist>     (run from frontend/)
# Output: visual-out/{base,head,diff}, report.html, report.json.
# Both builds are served on :4173, the port the HAR was recorded on (the URL is part of a HAR match).
# VISUAL_STRICT=1 makes a change exit 1 (label `no-visual-change`).
set -eu
base=${1:?base dist dir}
head=${2:?head dist dir}
rm -rf visual-out
VISUAL_DIST=$base VISUAL_OUT=visual-out/base pnpm exec playwright test --project=visual
VISUAL_DIST=$head VISUAL_OUT=visual-out/head pnpm exec playwright test --project=visual
exec node e2e/visual/compare.ts visual-out
