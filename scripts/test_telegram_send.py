#!/usr/bin/env python3
# =============================================================================
# VELO -- Manual Telegram Send Test (Phase 7.3)
# =============================================================================
#
# NOT part of pytest suite. Run manually to verify real Telegram delivery.
#
# Usage:
#   cd backend
#   python scripts/test_telegram_send.py
#
# Requires TELEGRAM_BOT_TOKEN in .env (real token, not dev-fake).
# =============================================================================

import asyncio
import sys
from pathlib import Path

# Ensure backend/ is on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aiogram import Bot
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramAPIError
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

from app.core.config import settings

# Test accounts registered with @velo_testbot.
TEST_ACCOUNTS = [
    5130305756,
    526738615,
    5971989877,
    5478046601,
    7598677296,
]


async def send_test_message(bot: Bot, chat_id: int) -> bool:
    """Send a test notification to a single Telegram account."""
    text = (
        "<b>VELO Test Notification</b>\n\n"
        "This is a test message from the VELO notification system.\n\n"
        "If you see this, Telegram delivery is working correctly.\n"
        f"Chat ID: <code>{chat_id}</code>"
    )

    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="Open VELO",
                    # Was hardcoded to https://t.me/velo_testbot -- a dead host
                    # AND the wrong bot. settings.telegram_bot_url is already
                    # host-normalized by config.py, so this button follows the
                    # live domain automatically.
                    url=settings.telegram_bot_url,
                ),
            ],
        ],
    )

    try:
        await bot.send_message(
            chat_id=chat_id,
            text=text,
            parse_mode=ParseMode.HTML,
            reply_markup=keyboard,
            disable_web_page_preview=True,
        )
        print(f"  [OK] {chat_id}")
        return True
    except TelegramAPIError as exc:
        print(f"  [FAIL] {chat_id}: {exc}")
        return False


async def main() -> None:
    """Send test messages to all registered test accounts."""
    token = settings.telegram_bot_token

    if "fake" in token.lower() or "dev" in token.lower():
        print("ERROR: TELEGRAM_BOT_TOKEN is a dev placeholder.")
        print("Set a real bot token in .env to run this test.")
        sys.exit(1)

    # The inline button now takes its URL from settings -- an empty value would
    # make aiogram reject the keyboard, so fail loudly and early instead.
    if not settings.telegram_bot_url:
        print("ERROR: TELEGRAM_BOT_URL is not set in .env.")
        print(f"Expected something like https://{settings.telegram_link_domain}/veloappbot")
        sys.exit(1)

    print(f"Bot token: ...{token[-8:]}")
    print(f"Bot URL:   {settings.telegram_bot_url}")
    print(f"Sending to {len(TEST_ACCOUNTS)} accounts:\n")

    bot = Bot(token=token)
    results = []

    try:
        for chat_id in TEST_ACCOUNTS:
            ok = await send_test_message(bot, chat_id)
            results.append((chat_id, ok))

        # Summary.
        ok_count = sum(1 for _, ok in results if ok)
        fail_count = len(results) - ok_count

        print(f"\nResults: {ok_count} sent, {fail_count} failed")

        if fail_count > 0:
            print("\nFailed accounts:")
            for chat_id, ok in results:
                if not ok:
                    print(f"  - {chat_id}")
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
