// =============================================================================
// VELO Frontend -- Backend error code -> Russian phrase (B8)
// =============================================================================
//
// Owner ruling 2026-08-16: PLAIN RUSSIAN, nothing else. No key system, no
// locale files, no i18n library, no t() wrapper -- full multi-language is its
// own future task and gets solved there, once, with everything in view. This
// table is not a first step toward that; building it "i18n-ready" is the
// failure mode this ruling explicitly rejects.
//
// Every code the backend can raise (VeloError.code, backend/app/core/
// exceptions.py + one code="..." per module raise site) maps to ONE Russian
// sentence here. useApiError.ts's extractApiError()/errorMessage() consult
// this table before ever falling back -- e.detail (backend's raw English
// message) is never read, let alone shown on screen.
//
// RECONCILED (PROMPT №747): 24 distinct codes are genuinely raised today
// (`grep -rnHE '\bcode(:\s*str)?\s*=\s*"[a-z_]+"' backend/app --include=*.py`,
// comment lines excluded, word-boundary on `code` so "..._passcode = ..."
// stub literals elsewhere in zoom_client.py don't false-positive in). 22 of
// those 24 are here, phrase-shaped. 2 are deliberately NOT here --
// zoom_meeting_not_failed and practice_full -- neither is a "show this
// phrase" case: one is a silently-recovered race (shows an info toast, not
// an error), the other drives a full-screen sold-out state with no error
// text at all. Forcing either through a code->phrase table would be the
// wrong shape; their call sites are untouched. ONE further entry,
// practice_not_found, is NOT among the 24 -- it is raised nowhere, only
// named in exceptions.py's own usage-example comment (`№745`'s original "25
// distinct codes" figure counted that comment line; corrected here). Kept
// anyway, at zero cost, so a future raise site is covered without anyone
// needing to remember this table. ONE MORE, validation_error, is not a
// VeloError.code at all -- see its own comment below. Total table size: 24.
//
// SEEDED from the 7 call sites that already carried a hand-written Russian
// phrase for a specific code (verbatim, not re-worded -- those were written
// with a real screen in view): bot_url_not_configured, direction_not_confirmed,
// style_not_confirmed, zoom_meeting_not_active, group_in_use, invite_invalid,
// insufficient_balance. The other 15 genuinely-raised codes plus
// practice_not_found are new, written from each raise site's own message.
export const ERROR_MESSAGES: Record<string, string> = {
  // Seeded verbatim from existing point-branches.
  bot_url_not_configured: 'Ссылки для приглашений временно недоступны. Сообщите в поддержку.',
  direction_not_confirmed: 'Это направление ещё не подтверждено в вашем профиле',
  style_not_confirmed: 'Этот вид практики ещё не подтверждён в вашем профиле',
  zoom_meeting_not_active: 'Встреча Zoom для этой практики недоступна',
  group_in_use:
    'Эта группа — единственная аудитория одной из практик. Сначала измените аудиторию практики, затем удалите группу.',
  invite_invalid:
    'Приглашение одноразовое: возможно, оно уже использовано или ссылка повреждена. Запросите новую ссылку у администратора.',
  insufficient_balance: 'Недостаточно средств на балансе',

  // New -- written from each raise site's own English message.
  already_master: 'Вы уже мастер',
  blocked_by_master: 'Мастер этой практики закрыл вам доступ',
  master_profile_not_found: 'Профиль мастера не найден',
  master_profile_not_verified: 'Профиль мастера ещё не подтверждён',
  method_change_pending: 'Заявка на изменение методов уже на рассмотрении',
  not_a_student: 'Эта практика доступна только ученикам мастера',
  not_in_audience: 'Эта практика недоступна для вашей группы',
  practice_completed: 'Эта практика уже завершена — отменить бронирование нельзя',
  // Not currently raised anywhere (only named in exceptions.py's own usage
  // example) -- included defensively so a future raise site is covered
  // without anyone needing to remember this table.
  practice_not_found: 'Практика не найдена',
  role_not_allowed: 'Эта роль недоступна для вашего аккаунта',

  // Curator groups (schools). Nine codes; six were already reachable before
  // this table knew about them, three were added to their raise sites so the
  // 404s stopped arriving as the generic `not_found`. Every one of the three
  // is deliberately ONE code for several causes -- see each phrase.
  curator_group_name_taken: 'У вас уже есть школа с таким названием',
  curator_cannot_leave:
    'Куратор не может покинуть свою школу. Передайте её другому мастеру или удалите.',
  own_group: 'Это ваша школа',
  master_required: 'Ссылка предназначена для верифицированных мастеров',
  blocked_by_curator: 'Вступление в эту школу недоступно',
  transfer_pending:
    'Предложение уже отправлено. Сначала отмените его, затем предложите другому мастеру.',
  // One code for: неизвестный токен, отозванная ссылка, удалённая школа и
  // школа с неверифицированным куратором. Различать их нельзя намеренно:
  // иначе по ссылке можно было бы выведать существование школы.
  invite_not_found: 'Приглашение недействительно',
  // One code for «предложения нет» и «предложение адресовано не вам».
  transfer_not_found: 'Предложение о передаче не найдено',
  // One code for ученика, постороннего, скрытого мастера и самого куратора.
  transfer_target_not_member: 'Передать школу можно только мастеру из её состава',

  // VeloError base-class defaults (no module-specific code set).
  unauthorized: 'Сессия истекла — войдите заново',
  not_found: 'Запрошенный ресурс не найден',
  forbidden: 'Действие недоступно',
  conflict: 'Конфликт с текущим состоянием — попробуйте обновить страницу',
  bad_request: 'Некорректный запрос',
  internal_error: 'Внутренняя ошибка сервера. Попробуйте ещё раз',

  // NOT a VeloError.code -- assigned by the FRONTEND itself (client.ts:195)
  // for a raw Pydantic 422 response (backend validation, not a VeloError
  // raise site). Found while fixing the №747 test repair round: this code
  // is real and structurally guaranteed on every Pydantic validation
  // failure, so it was leaking English exactly like the 16 originally
  // measured -- just never counted, because the backend-only reconciliation
  // couldn't see a code the frontend assigns to itself.
  validation_error: 'Проверьте введённые данные',
}

// Safety-net text ONLY (PROMPT №747) -- for a code with no table entry at
// all (a genuinely new/forgotten backend code, or the `code: string =
// 'unknown'` default on a malformed response). Not the per-call-site
// fallback extractApiError() callers already supply -- this backs
// errorMessage() below, whose whole point is a lookup with no caller input.
export const GENERIC_ERROR_MESSAGE = 'Что-то пошло не так. Попробуйте ещё раз.'
