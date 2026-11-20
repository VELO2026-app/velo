#!/usr/bin/env bash
# Installs the VELO designer agent skill for Claude Code on this Mac.
# Run from the unpacked package (or from docs/figma/velo-figma-designer in the repo):
#   bash install.sh
# Idempotent: re-running updates the skill. Touches only ~/.claude/skills/velo-figma-designer
# and, if missing, the user-level MCP servers figma-console and linear.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills/velo-figma-designer"
ok() { printf '  ✔ %s\n' "$1"; }
bad() { printf '  ✘ %s\n' "$1"; }

echo "1. Claude Code"
if command -v claude >/dev/null 2>&1; then ok "claude $(claude --version 2>/dev/null | head -1)"; else bad "Claude Code не найден: установите приложение Claude и включите Claude Code (см. инструкцию, шаг 1)"; exit 1; fi
command -v node >/dev/null 2>&1 && ok "node $(node --version)" || { bad "нет Node.js: https://nodejs.org (LTS), затем запустить install.sh ещё раз"; exit 1; }

echo "2. Скилл"
mkdir -p "$DEST/scripts" "$DEST/references"
cp "$HERE/SKILL.md" "$DEST/SKILL.md"
cp "$HERE"/scripts/*.js "$DEST/scripts/"
if [ -f "$HERE/references/figma-protocol.md" ]; then cp "$HERE/references/figma-protocol.md" "$DEST/references/"
elif [ -f "$HERE/../../figma-protocol.md" ]; then cp "$HERE/../../figma-protocol.md" "$DEST/references/"
else bad "не нашёл figma-protocol.md"; exit 1; fi
ok "скопирован в $DEST"

echo "3. Сервер Figma (figma-console)"
if claude mcp get figma-console >/dev/null 2>&1; then ok "уже подключён"
else claude mcp add figma-console -s user -- npx -y figma-console-mcp@latest && ok "добавлен"; fi

echo "4. Linear"
if claude mcp get linear >/dev/null 2>&1; then ok "уже подключён"
else claude mcp add --transport http linear -s user https://mcp.linear.app/mcp && ok "добавлен (вход: в Claude Code набрать /mcp → linear → Authenticate)"; fi

echo
echo "Готово. Дальше: инструкция, шаг 3 (плагин в Figma) и шаг 4 (проверка)."
