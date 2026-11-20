#!/usr/bin/env bash
# Installs the VELO designer agent skill for Claude Code on this Mac.
# Run from the unpacked package (or from docs/figma/velo-figma-designer in the repo):
#   bash install.sh
# Idempotent: re-running updates the skill. Touches only ~/.claude/skills/velo-figma-designer
# and, if missing, the user-level MCP servers figma-console and linear.
# Step numbers in the messages refer to the guide (Инструкция.md / docs/figma/designer-guide.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.claude/skills/velo-figma-designer"
# The figma-console-mcp version the VELO agents run and tested (bump together with the guide).
FIGMA_CONSOLE_VERSION="1.46.0"
FAILED=0
ok() { printf '  ✔ %s\n' "$1"; }
bad() { printf '  ✘ %s\n' "$1"; FAILED=1; }

echo "1. Node.js и Claude Code"
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version)"
else
  bad "нет Node.js: поставьте его по инструкции, шаг 1, и запустите install.sh ещё раз"
  exit 1
fi
if command -v claude >/dev/null 2>&1; then
  ok "$(claude --version 2>/dev/null | head -1)"
else
  bad "нет Claude Code: поставьте его по инструкции, шаг 2, закройте и снова откройте Терминал, запустите install.sh ещё раз"
  exit 1
fi

echo "2. Скилл"
mkdir -p "$DEST/scripts" "$DEST/references"
cp "$HERE/SKILL.md" "$DEST/SKILL.md"
cp "$HERE"/scripts/*.js "$DEST/scripts/"
if [ -f "$HERE/references/figma-protocol.md" ]; then
  cp "$HERE/references/figma-protocol.md" "$DEST/references/"
elif [ -f "$HERE/../../figma-protocol.md" ]; then
  cp "$HERE/../../figma-protocol.md" "$DEST/references/"
else
  bad "не нашёл figma-protocol.md рядом с install.sh"
  exit 1
fi
ok "скопирован в $DEST"

echo "3. Сервер Figma (figma-console $FIGMA_CONSOLE_VERSION)"
if claude mcp get figma-console >/dev/null 2>&1; then
  ok "уже подключён"
elif claude mcp add figma-console -s user -- npx -y "figma-console-mcp@$FIGMA_CONSOLE_VERSION"; then
  ok "добавлен"
else
  bad "не удалось добавить сервер figma-console (сообщение выше) — напишите Владимиру"
fi

echo "4. Linear"
if claude mcp get linear >/dev/null 2>&1; then
  ok "уже подключён"
elif claude mcp add --transport http linear -s user https://mcp.linear.app/mcp; then
  ok "добавлен (вход: в Claude Code набрать /mcp → linear → Authenticate)"
else
  bad "не удалось добавить сервер Linear (сообщение выше) — напишите Владимиру"
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Есть ошибки (✘ выше). Исправьте и запустите install.sh ещё раз."
  exit 1
fi
echo "Готово. Дальше: инструкция, шаг 4 (плагин в Figma) и шаг 5 (проверка)."
