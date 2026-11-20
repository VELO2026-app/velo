#!/usr/bin/env bash
# Installs the VELO designer agent skill on this Mac.
#   bash install.sh            OpenAI Codex (default; owner's decision D-9, 20.11.2026)
#   bash install.sh --claude   Claude Code (second option)
# Run from the unpacked package (or from docs/figma/velo-figma-designer in the repo).
# Idempotent: re-running updates the skill and keeps existing MCP entries.
#
# Codex (https://learn.chatgpt.com/docs/build-skills, .../docs/extend/mcp):
#   skill -> ~/.agents/skills/velo-figma-designer (USER scope; Codex CLI, ChatGPT desktop app and the
#            IDE extension read it); MCP servers -> ~/.codex/config.toml, shared by the same clients.
# Claude Code: skill -> ~/.claude/skills/velo-figma-designer; MCP via `claude mcp add -s user`.
# Step numbers in the messages refer to the guide (Инструкция.md / docs/figma/designer-guide.md).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLIENT="codex"
[ "${1:-}" = "--claude" ] && CLIENT="claude"
# The figma-console-mcp version the VELO agents run and tested (bump together with the guide).
FIGMA_CONSOLE_VERSION="1.46.0"
LINEAR_URL="https://mcp.linear.app/mcp"
FAILED=0
ok() { printf '  ✔ %s\n' "$1"; }
bad() { printf '  ✘ %s\n' "$1"; FAILED=1; }

echo "1. Node.js и $([ "$CLIENT" = codex ] && echo Codex || echo 'Claude Code')"
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version)"
else
  bad "нет Node.js: поставьте его по инструкции, шаг 1, и запустите install.sh ещё раз"
  exit 1
fi
if command -v "$CLIENT" >/dev/null 2>&1; then
  ok "$("$CLIENT" --version 2>/dev/null | head -1)"
else
  bad "нет программы $CLIENT: поставьте её по инструкции, шаг 2, закройте и снова откройте Терминал, запустите install.sh ещё раз"
  exit 1
fi

echo "2. Скилл"
if [ "$CLIENT" = codex ]; then DEST="$HOME/.agents/skills/velo-figma-designer"; else DEST="$HOME/.claude/skills/velo-figma-designer"; fi
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

if [ "$CLIENT" = codex ]; then
  CONFIG="$HOME/.codex/config.toml"
  mkdir -p "$HOME/.codex"
  touch "$CONFIG"
  echo "3. Сервер Figma (figma-console $FIGMA_CONSOLE_VERSION) в $CONFIG"
  if grep -q '^\[mcp_servers\.figma-console\]' "$CONFIG"; then
    ok "уже подключён"
  else
    # startup_timeout_sec: the first start downloads the package with npx (default 10 s is too short)
    printf '\n[mcp_servers.figma-console]\ncommand = "npx"\nargs = ["-y", "figma-console-mcp@%s"]\nstartup_timeout_sec = 90\ntool_timeout_sec = 120\n' "$FIGMA_CONSOLE_VERSION" >> "$CONFIG"
    ok "добавлен"
  fi
  echo "4. Linear"
  if grep -q '^\[mcp_servers\.linear\]' "$CONFIG"; then
    ok "уже подключён"
  else
    printf '\n[mcp_servers.linear]\nurl = "%s"\n' "$LINEAR_URL" >> "$CONFIG"
    ok "добавлен (вход: инструкция, шаг 5 — codex mcp login linear)"
  fi
  if codex mcp list >/dev/null 2>&1; then
    if codex mcp list 2>/dev/null | grep -E 'figma-console|linear' >/dev/null; then
      ok "codex видит оба сервера"
    else
      bad "codex mcp list не показывает серверы — напишите Владимиру"
    fi
  else
    bad "codex не читает $CONFIG (codex mcp list с ошибкой) — напишите Владимиру"
  fi
else
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
  elif claude mcp add --transport http linear -s user "$LINEAR_URL"; then
    ok "добавлен (вход: в Claude Code набрать /mcp → linear → Authenticate)"
  else
    bad "не удалось добавить сервер Linear (сообщение выше) — напишите Владимиру"
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "Есть ошибки (✘ выше). Исправьте и запустите install.sh ещё раз."
  exit 1
fi
echo "Готово. Дальше: инструкция, шаг 4 (плагин в Figma) и шаг 5 (проверка)."
