// =============================================================================
// VELO load tests -- Telegram WebApp initData for a synthetic student
// =============================================================================
//
// The same algorithm the backend verifies (auth/service.py,
// validate_telegram_init_data), per
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
//   data_check_string = sorted "key=value" pairs (DECODED values), joined "\n"
//   secret_key        = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash              = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
//
// The backend percent-decodes the query string ONCE (parse_qs) and signs what
// it gets, so the values are signed raw here and percent-encoded only for
// transport. auth_date is "now": the backend refuses initData older than
// auth_init_data_ttl_seconds (300) or more than auth_clock_skew_seconds (60)
// in the future, so one string is built per login, never reused.
//
// The bot token lives only in the caller's argument. Nothing here logs,
// returns or stores it; the returned string carries only the HMAC.
// =============================================================================

import crypto from 'k6/crypto';

/**
 * Build signed initData for `telegramId`.
 *
 * @param {number} telegramId  synthetic student id (LOAD_TID_MIN..MAX)
 * @param {string} botToken    the dev bot token (from BOT_TOKEN env)
 * @param {number} [nowSeconds] auth_date override, for the self-check only
 * @returns {string} url-encoded initData
 */
export function buildInitData(telegramId, botToken, nowSeconds) {
  const authDate = nowSeconds === undefined
    ? Math.floor(Date.now() / 1000)
    : nowSeconds;
  // ASCII-only names: the signature is over UTF-8 bytes on both sides, but
  // keeping the payload ASCII removes encoding as a variable altogether.
  const user = JSON.stringify({
    id: telegramId,
    first_name: 'Load',
    last_name: String(telegramId),
    language_code: 'ru',
  });
  const fields = {
    auth_date: String(authDate),
    query_id: `load${telegramId}`,
    user,
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = crypto.hmac('sha256', 'WebAppData', botToken, 'binary');
  const hash = crypto.hmac('sha256', secretKey, dataCheckString, 'hex');
  return Object.keys(fields)
    .map((k) => `${k}=${encodeURIComponent(fields[k])}`)
    .concat([`hash=${hash}`])
    .join('&');
}
