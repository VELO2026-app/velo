# Голосовой ввод (MVP, транскрибация через OpenRouter): шаг 1 — Composer, шаг 2 — все textarea — ТЗ для frontend-агента

## Статус и границы задачи

Это frontend-задача на MVP фичи голосового ввода:

1. микрофон в общем `Composer` (чат с мастером + создание записи дневника)
   становится функциональным: ТАП по микрофону запускает запись
   (tap-to-toggle — без удержаний и слайдов);
2. во время записи поле заменяет минималистичная панель: слева крестик
   отмены, затем зелёная мягко мигающая точка и секундомер, справа кнопка
   стопа (квадратик), которая останавливает запись и отправляет её на
   транскрибацию; на время обработки весь ряд composer задизейблен;
3. аудио уходит напрямую из браузера в OpenRouter (модель OpenAI) и
   транскрибируется;
4. расшифрованный текст вставляется в то поле ввода, из которого голосовой
   ввод был вызван;
5. шаг 2 (§11): тот же голосовой ввод включается во всех textarea
   приложения — шаг 1 покрывает только Composer.

Это осознанный MVP: **backend не затрагивается вообще**. Браузер зовёт
OpenRouter напрямую. Позже, когда появится «нормальный бек», транскрибация
уедет за бек-прокси (в беке уже есть заготовленный шов — модуль
`backend/app/modules/ai/`, по замыслу его авторов реальный сервис подключается
заменой `get_ai_service()`); фронт тогда меняет ровно одну функцию —
`transcribeAudio` в `src/api/openrouter.ts`. До этого решения не
имитировать бек и не добавлять прокси-эндпоинты на своей стороне.

В этой задаче нельзя:

- трогать backend, `frontend/src/api/client.ts` и вообще наш API-слой —
  OpenRouter не наш API, ходить в него надо raw `fetch` из отдельного модуля;
- в рамках Шага 1 (§1–§10) расширять фичу на другие поля ввода — их
  подключение вынесено в Шаг 2 (§11); два шага — два PR, не смешивать;
- делать вставку текста в непустое поле или в позицию курсора — микрофон
  остаётся empty-field-only: запись доступна ТОЛЬКО при пустом поле, первый
  введённый символ прячет её (см. §6);
- делать голосовые сообщения как вложения/аудио-плееры — только
  текст-транскрипт в поле;
- показывать ложный success: нет ключа, нет разрешения на микрофон, ошибка
  сети — каждый случай честным сообщением, поле остаётся пустым;
- заводить новую глобальную систему feature flags ради одного флага;
- визуальные browser/screenshot-проверки в рамках этой задачи не выполнять.
  Проверка — по коду, unit/screen-тестам, typecheck и lint.

## Что уже есть в проекте

- Общий composer: `frontend/src/components/shared/Composer.vue`. Он один
  обслуживает чат (`ChatThreadScreen.vue`) и дневник (`DiaryComposer.vue`).
- **Шов под эту фичу уже заложен**: в `Composer.vue` есть флаг-gated
  визуальный стаб микрофона — диск справа от поля (`voiceStub` prop,
  empty-field-only, `@pointerdown.prevent`, намеренно без обработчика,
  комментарий «wire the real recorder or delete this when voice messages
  land»). Флаг `COMPOSER_VOICE_STUB = false` в
  `frontend/src/utils/constants.ts` (секция с комментарием owner pass
  2026-08-27 / 2026-09-07).
- `ChatThreadScreen.vue` уже передаёт стаб-флаг в `Composer`.
- `DiaryComposer.vue` стаб НЕ передаёт — там комментарий [FE-42]: вернуть
  `:voice-stub`, «когда реальный рекордер появится». Эта задача его и
  закрывает.
- Иконки: `IconMic` (уже используется стабом), `IconSend`, `IconClose`
  существуют; новые иконки добавляются SFC в
  `frontend/src/components/icons/` + одна строка экспорта в `index.ts`
  (DS-5 баррел).
- Тосты: `useToast()` (`toast.success/error/info`) — `frontend/src/composables/useToast.ts`.
- Хептики: `platform.hapticFeedback('light'|'medium'|'heavy')` из
  `frontend/src/platform/index.ts` (в Telegram идёт в нативный
  HapticFeedback, вне — тихий fallback). Пример использования —
  `ReflectionView.vue`.
- Лоадер: `VLoader` (`size` prop).
- Дизайн-токены: `frontend/src/styles/variables.css` — `--velo-size-44`,
  `--velo-size-50`, `--radius-full`, `--velo-nav-active-bg`, `--velo-white`,
  `--transition-fast`. Диски composer: в однострочном режиме капсулы 36 px с
  прозрачным skirt до 44 px touch-target (`.composer--single .composer__btn`).
- Анимационная конвенция: только non-layout свойства (transform, opacity,
  box-shadow, border-color), `--transition-fast`; никакого
  backdrop-filter на самих элементах ввода (iOS WebKit shimmer — см. баннер
  Composer).
- Env: `frontend/env.d.ts` (`ImportMetaEnv`), `frontend/.env.example`,
  значения читаются через `import.meta.env.VITE_*`.
- Тесты: Vitest, конвенция без `@vue/test-utils` mount — `createApp` +
  wrapper через `h()`, host-div в `document.body`, события через
  handler-props (образец: `DiaryThreadCard.test.ts`). Чистая логика
  выносится в экспортируемые pure-функции (образец:
  `useComposerGrowCap.ts`). Команда гейта: `npm test`, `npm run typecheck`,
  `npm run lint`.
- i18n в проекте нет: все строки — русский, инлайн в шаблонах/TS. Так и
  продолжать.

## 1. Env и kill-switch

### Переменные окружения

Добавить в `frontend/env.d.ts` (`ImportMetaEnv`) и в
`frontend/.env.example`:

```text
VITE_OPENROUTER_API_KEY=        # ключ openrouter.ai; пусто = фича честно недоступна
VITE_OPENROUTER_TRANSCRIBE_MODEL=   # пусто = дефолт openai/gpt-4o-audio-preview
```

- Модель по умолчанию — `openai/gpt-4o-audio-preview` (выбрана владельцем
  для качества на русском). Удешевление до
  `openai/gpt-4o-mini-audio-preview` — одна строка в env, код не меняется.
- В `.env.example` рядом с ключом оставить предупреждение: ключ компилируется
  в публичный бандл (MVP-решение), поэтому в дашборде OpenRouter обязательно
  выставить spend cap; при переходе на бек-прокси ключ уходит с фронта.
- В собственный `frontend/.env` ключ в git не коммитится (файл уже
  gitignored).

### Kill-switch

В `frontend/src/utils/constants.ts` заменить `COMPOSER_VOICE_STUB` на:

```ts
export const COMPOSER_VOICE_INPUT = true
```

с датированным комментарием в стиле файла (реальный рекордер подключён,
флаг = kill-switch: `false` возвращает composer к прежнему поведению).
Семантика `false`: микрофонный диск не рендерится вообще, никаких
резерваций места — как со стабом сегодня. Один флаг питает оба composer.

## 2. Транскрибация: `src/api/openrouter.ts` (новый файл)

Единственная функция:

```ts
export interface TranscribeResult {
  ok: boolean
  text?: string
  error?: string
}
export function transcribeAudio(blob: Blob): Promise<TranscribeResult>
```

Форма результата сознательно повторяет `ComposerSendResult` — потребитель
уже умеет её интерпретировать.

Требования:

- Raw `fetch` на `https://openrouter.ai/api/v1/chat/completions`,
  `Authorization: Bearer <import.meta.env.VITE_OPENROUTER_API_KEY>`.
  В шапке файла — комментарий, почему модуль вне `client.ts` (сторонний API,
  MVP-seam, заменяется бек-прокси одной функцией) и почему токен не должен
  попадать в логи/ошибки.
- Без ключа в env — сразу `{ ok: false, error: 'Голосовой ввод недоступен' }`,
  без сетевого запроса и без крэша.
- Тело запроса — chat completions c мультимодальной audio-частью:

```json
{
  "model": "<модель из env или openai/gpt-4o-audio-preview>",
  "temperature": 0,
  "max_tokens": 1000,
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "<промпт ниже>" },
      { "type": "input_audio", "input_audio": { "data": "<base64 wav>", "format": "wav" } }
    ]
  }]
}
```

- Промпт (инлайн-константа): дословная транскрибация аудио, только текст
  расшифровки — без пояснений, кавычек и markdown; язык оригинала
  сохраняется. Никаких «улучшений» речи.
- **Формат — только WAV.** OpenAI audio-модели через OpenRouter принимают
  `input_audio` лишь в wav/mp3, а `MediaRecorder` пишет webm/opus (Chrome,
  Android) или mp4/aac (iOS Safari). Поэтому на вход `transcribeAudio`
  всегда приходит уже сконвертированный WAV 16 kHz mono (см. §3);
  `format: 'wav'` захардкожен. Fallback «отправить сырой blob» не делать —
  это гарантированный 4xx на половине устройств.
- Таймаут 30 s через `AbortController`; аборт маппится в обычную сетевую
  ошибку.
- Разбор ответа: `choices[0].message.content`, `trim()`. Защитная чистка:
  снять обрамляющие markdown-заборы (```), обрамляющие кавычки, если модель
  их вернула. Пустая строка после чистки — это ошибка распознавания, не
  успех.
- Маппинг ошибок (тексты RU, через `result.error`):

| Условие | Сообщение |
|---|---|
| нет `VITE_OPENROUTER_API_KEY` | `Голосовой ввод недоступен` |
| 401 / 403 | `Ключ транскрибации не настроен` |
| 402 | `Закончился баланс OpenRouter` |
| 429 | `Слишком часто, попробуйте позже` |
| 5xx / сеть / таймаут | `Сервис транскрибации недоступен` |
| пустая расшифровка | `Не удалось распознать речь` |

Любой другой 4xx — в общую сетевую ветку. Тело ошибки OpenRouter в текст
пользователя не подставлять.

## 3. Аудио-утилиты: `src/utils/audio.ts` (новый файл)

Только чистые функции, пригодные для юнит-тестов без браузера:

- `formatStopwatch(totalSeconds: number): string` — `M:SS`, ведущий ноль
  только у секунд (`0:00`, `0:07`, `1:05`). Отрицательные и NaN — `0:00`.
- `pickRecorderMime(): string | undefined` — первый поддерживаемый из
  `audio/webm;codecs=opus`, `audio/mp4` по `MediaRecorder.isTypeSupported`;
  undefined = recorder mime не выбран, `MediaRecorder()` создаётся без mime.
- `blobToBase64(blob: Blob): Promise<string>` — без data-URL префикса.
- `encodeWav(audioBuffer: AudioBuffer): Blob` — downmix в mono, ресэмпл в
  16 kHz (linear interpolation по каналам достаточно для речи), PCM16 LE,
  корректный RIFF/WAVE заголовок. Это pure-функция над данными буфера —
  для тестов принимает объект с `sampleRate`/`numberOfChannels`/
  `getChannelData`, реальный `AudioBuffer` не требуется.

Конвертация записи в WAV (склейка `decodeAudioData` + `encodeWav`)
живёт в рекордере (§4), не в утилитах: ей нужен живой `AudioContext`.

## 4. Рекордер: `src/composables/useVoiceRecorder.ts` (новый файл)

Стейт-машина: `idle → requesting → recording → processing → idle`
(ошибка — тост на месте вызова + возврат в `idle`; отдельное error-состояние
в UI не вводить).

Публичный API:

```ts
const state: Ref<'idle'|'requesting'|'recording'|'processing'>
const elapsedSec: Ref<number>
const errorReason: Ref<'permission'|'unsupported'|null>
function start(): Promise<void>
function stop(): Promise<Blob | null>   // WAV 16 kHz mono; null при сбое/слишком короткой записи
function cancel(): void
```

Поведение:

- `start()`: `navigator.mediaDevices.getUserMedia({ audio: true })`.
  Нет `getUserMedia`/`MediaRecorder` → `errorReason='unsupported'`.
  `NotAllowedError`/`NotFoundError` → `errorReason='permission'`. Тексты
  тостов (`Доступ к микрофону запрещён` / `Микрофон недоступен на этом
  устройстве`) поднимает вызывающий `Composer`, не комопзабл.
- `MediaRecorder` создаётся с `pickRecorderMime()`; `ondataavailable`
  копит чанки. `AudioContext` нужен только для конвертации в WAV на
  `stop()` (§3); анализатора уровня и волны НЕ делать — индикатор записи
  статичный (§5, решение владельца).
- Секундомер: интервал 200 ms, `elapsedSec` считается из `Date.now()` минус
  время старта (без накопительного инкремента — без дрейфа).
- Авто-стоп на **60 s**: reaching cap = автоматический `stop()`.
- `stop()`: останавливает recorder/треки/анализатор/таймеры, blob собирается
  из чанков, затем `AudioContext.decodeAudioData` + `encodeWav` → WAV Blob.
  Декодировать тем же контекстом, что анализировал — браузер умеет
  декодировать то, что сам записал. Сбой декодирования → `null`.
- `cancel()`: та же зачистка, blob отбрасывается.
- `onScopeDispose`: полная зачистка (потоки, AudioContext, интервалы) —
  уход с экрана посреди записи не должен оставить живой микрофон.
- `document.visibilitychange → hidden` во время `recording`: молча
  `cancel()` (без тостов) — безопасный MVP-путь.

## 5. Панель записи: `src/components/shared/VoiceRecordingPanel.vue` (новый файл)

Панель встаёт внутрь существующей glass-карточки поля composer (`composer__field`)
на место textarea: геометрия ряда не меняется, glass-слои (`::before`/`::after`)
остаются как есть.

Раскладка повторяет мессенджерную полосу записи, но по клику — без
удержаний: у каждой кнопки есть состояние, в котором до неё можно
дотянуться, палец никого не держит.

Состояния панели:

```text
recording:   [✕]  [●] [0:07]                         [⏹]
processing:  [Транскрибация…  ⟳VLoader]   — весь ряд composer задизейблен
```

- Тап по диску микрофона (вне панели) запускает запись; панель встаёт
  внутрь существующей glass-карточки поля (`composer__field`) на место
  textarea: геометрия ряда не меняется, glass-слои (`::before`/`::after`)
  остаются как есть. Сам диск микрофона на время записи скрывается
  (v-if) — мёртвый мик рядом с панелью не нужен.
- Крестик отмены — `IconClose`, СЛЕВА (aria-label `Отменить запись`),
  тап — `cancel()`.
- Зелёная точка — индикатор записи («зелёный фонарик»). Цвет —
  существующий DS-токен из `variables.css` (success/teal-семейство,
  например `--velo-teal-600`; новый оттенок не заводить). Мягкое мигание:
  keyframes ТОЛЬКО по opacity (~1 → ~0.35 и обратно, ~1.6 s ease-in-out
  infinite) — «дыхание», без пульс-скачков, без scale, без анимаций
  layout-свойств (конвенция).
- Секундомер: `formatStopwatch(elapsedSec)`, tabular-цифры
  (`font-variant-numeric`); справа от него flex-spacer.
- Волны и анализатора уровня НЕТ — индикатор минимальный по решению
  владельца.
- Стоп — новая `IconStop` (квадрат, currentColor, `size` prop как у всех
  иконок; SFC + экспорт в `icons/index.ts`; aria-label `Завершить
  запись`), СПРАВА, в позиции штатного send-слота composer. Тап =
  `stop()` → остановить запись и отправить на транскрибацию. Диск тот
  же, что у composer-кнопок: `--velo-size-44` / 36 px в капсульном
  режиме, `--velo-nav-active-bg`, skirt до 44 px.
- processing: вместо индикаторной группы — `Транскрибация…` + `VLoader`;
  **весь ряд composer задизейблен**: ✕ и ⏹ не реагируют, тапы по ряду
  ничего не делают, пока не придёт результат (текст в поле или тост
  ошибки).
- Props: `state`, `elapsedSec`, `busyLabel` (дефолт `Транскрибация…`).
  Emits: `cancel`, `stop`.
- Хептики — в `Composer` (владелец переходов состояний), не в панели:
  light на старт записи, `success`/`error` (`notificationOccurred`) на
  результат транскрибации, по образцу `ReflectionView.vue` (try/catch не
  нужен — platform уже фолбэчится).

## 6. Интеграция в `Composer.vue`

Проп `voiceStub?: boolean` заменить на `voiceInput?: boolean`
(дефолт false). Ветка рендера диска остаётся empty-field-only, причём
условие — СТРОГО пустое поле: `v-if="voiceInput && text.length === 0"`.
Не переиспользовать `!canSend`: он trim-зависимый, и при строке из одних
пробелов микрофон остался бы видимым, а по правилу фичи записи нет, как
только введён хоть один символ (включая пробел). Первый введённый символ —
в том числе из черновика, загруженного из localStorage, — прячет диск;
очищение поля возвращает его.

### Запуск и остановка (tap-to-toggle)

- Обычный `@click` на диске микрофона: тап → `recorder.start()` (запрос
  доступа к микрофону) → панель записи. Никаких удержаний, слайдов,
  pointer capture и аффордансов — модель «клик → запись → клик-стоп».
  `@pointerdown.prevent` старого стаба не сохранять: он нужен был, чтобы
  тап не крал фокус у поля; здесь поле к моменту тапа пустое и
  расфокусировано само (см. ниже).
- При старте записи, если поле было в фокусе: `blur()` +
  `setComposing(false)` — клавиатура не должна висеть над записью.
- `⏹` в панели: `recorder.stop()` → транскрибация.
- `✕` в панели: `recorder.cancel()` — молча, поле пустое, без тоста и без
  запроса.
- Стоп при записи < 1 s → `cancel()` + `toast.info('Запись слишком
  короткая')` — полсекунды тишины не должны уходить в API.
- Авто-стоп на 60 s (§4) работает как ручной стоп: транскрибация
  запускается сама.
- Повторный запуск во время записи невозможен: диск микрофона скрыт
  (v-if) на время записи; в processing неактивен весь ряд.

### Состояния ряда

- `idle`: прежний composer (диск микрофона + поле).
- `recording`: textarea скрыта (`v-show`, по образцу preview-ветки), на её
  месте `VoiceRecordingPanel` ([✕] [●] [0:07] … [⏹]); диск микрофона
  скрыт (v-if).
- `processing`: панель в busy-состоянии, **весь ряд composer
  задизейблен** — кнопки панели и поле не реагируют до результата
  (текст в поле или тост ошибки).
- Результат: полученная расшифровка **встаёт в то самое поле ввода, из
  которого была вызвана запись**: `text.value = transcript`. Поле к этому
  моменту пустое (запись была возможна только из пустого поля), так что
  вставка = присваивание; draft-watch, `canSend` и появление send-диска
  срабатывают сами, как при обычном наборе. Диск микрофона при этом
  исчезает (поле непустое). Далее `autogrow()`. **Без автофокуса** —
  клавиатура не должна выпрыгивать сама; кто хочет править — тапнет по
  полю.
- Ошибка транскрибации: `toast.error(result.error)`, панель закрывается,
  поле остаётся пустым. Пустая расшифровка при ok-ответе — тот же путь с
  сообщением `Не удалось распознать речь`.

Механику composer не ломать: `send`-prop, `draftKey`, `growCap`,
FE-9 preview-жизненный цикл (высота textarea сбрасывается при скрытии и
пересчитывается при возврате — как в `watch(showingPreview, ...)`),
капсульная геометрия, BG-ROOT freeze (закрыт, не переиспользовать).

## 7. Потребители флага

- `frontend/src/components/shared/ChatThreadScreen.vue`: заменить передачу
  `:voice-stub="COMPOSER_VOICE_STUB"` на `:voice-input="COMPOSER_VOICE_INPUT"`.
- `frontend/src/components/shared/DiaryComposer.vue`: добавить
  `:voice-input="COMPOSER_VOICE_INPUT"` — этим закрывается TODO [FE-42];
  баннер-комментарий про «микрофон временно скрыт» переписать по факту.
- Локальные импорты `COMPOSER_VOICE_STUB` в тестах заменить на новый флаг.

## 8. Файлы, которые должен затронуть frontend-агент

Новые:

- `frontend/src/utils/audio.ts` + `audio.test.ts`;
- `frontend/src/composables/useVoiceRecorder.ts` + `useVoiceRecorder.test.ts`;
- `frontend/src/api/openrouter.ts` + `openrouter.test.ts`;
- `frontend/src/components/shared/VoiceRecordingPanel.vue` + тест;
- `frontend/src/components/icons/IconStop.vue`.

Изменяемые:

- `frontend/src/components/shared/Composer.vue` (+ голосовой тест-файл рядом);
- `frontend/src/utils/constants.ts`;
- `frontend/src/components/shared/ChatThreadScreen.vue` (+ его тест, если
  фиксирует стаб-проп);
- `frontend/src/components/shared/DiaryComposer.vue` (+ `DiaryComposer.test.ts`);
- `frontend/env.d.ts`;
- `frontend/.env.example`.

Не менять в рамках Шага 1:

- backend и `frontend/src/api/client.ts`;
- `EntryView.vue`, `SupportView*`, `SendMessageModal`, `FormShell`,
  группы/рефлексии — их подключение — Шаг 2 (§11);
- `DiaryThreadCard` / `DiaryFeedCard`, фильтры/поиск/пагинация дневника;
- механизм BG-ROOT/AppFrame freeze;
- существующие тексты и поведение composer вне микрофонной ветки.

## 9. Тесты

Конвенция дома: `createApp` + `h()`-wrapper без `@vue/test-utils`, host-div
в `document.body`, чистые функции экспортируются ради тестов. MediaRecorder/
getUserMedia/AudioContext в happy-dom нет — ставить через `vi.stubGlobal`.

### `audio.test.ts`

- `formatStopwatch`: 0, 7, 59, 60, 65, 3599, 3600; отрицательное и NaN → `0:00`.
- `pickRecorderMime` с замоканным `isTypeSupported`: выбирает webm при
  поддержке, mp4 когда webm нет, undefined когда ничего.
- `encodeWav`: корректные RIFF/WAVE-поля в заголовке, mono, 16 kHz, длина
  data-чанка = `samples * 2`, PCM16 значения соответствуют входу
  (контрольный синус/константа); стерео-вход даёт downmix.
- `blobToBase64` возвращает тело без префикса data-URL.

### `useVoiceRecorder.test.ts`

- happy path: start → state `recording`, timer тикает (fake timers),
  stop() резолвится WAV-blob'ом, state `idle` после обработки.
- отказ `getUserMedia` (NotAllowedError) → `errorReason='permission'`,
  состояние возвращается в `idle`.
- отсутствие `navigator.mediaDevices` → `errorReason='unsupported'`.
- авто-стоп: прокрутка fake-таймеров за 60 s вызывает остановку.
- `cancel()` отбрасывает чанки и зачищает интервалы (после unmount
  таймеров нет — проверка через `vi.getTimerCount()`).
- `visibilitychange → hidden` в состоянии recording вызывает cancel.

### `openrouter.test.ts`

- Мок `fetch`: ok-ответ → `{ ok: true, text }`; в payload уходят
  `format: 'wav'`, баз64-данные, модель из env (проверить обе: дефолт и
  переопределение), temperature 0.
- Каждый класс ошибок из таблицы §2 возвращает точный RU-текст:
  401, 402, 429, 500, reject fetch (сеть), аборт (таймаут).
- Пустой `content`/пустая строка после чистки → `Не удалось распознать речь`.
- Markdown-забор и обрамляющие кавычки срезаются.
- Отсутствие ключа → `Голосовой ввод недоступен` и fetch НЕ вызывался.

### `VoiceRecordingPanel.test.ts`

- `state='recording'`: рендерятся ✕ (aria-label `Отменить запись`),
  зелёная точка, секундомер из пропа и ⏹ (aria-label `Завершить запись`).
- Тапы по ✕/⏹ эмитят `cancel` / `stop`.
- `state='processing'`: busy-строка + VLoader вместо точки/секундомера;
  обе кнопки задизейблены и не эмитят.

### Голосовой тест `Composer`

- `vi.mock('@/api/openrouter')` и `vi.mock('@/composables/useVoiceRecorder')`
  (рекордер подменяется управляемым фейком: state/elapsed +
  resolve-able stop).
- Флаг on + пустое поле: диск микрофона есть; появление ЛЮБОГО символа в
  `text` (включая строку из одних пробелов и текст, вставленный после
  транскрибации) прячет диск; очистка поля возвращает его. Проверить, что
  условие именно `text.length === 0`, а не `!canSend`.
- Тап по микрофону на пустом поле → панель записи ([✕] [●] [0:07] … [⏹]),
  диск микрофона скрыт.
- Завершение записи (`stop()` → blob → мок транскрибации ok) — расшифровка
  встала в поле как его содержимое, send-контроль доступен, draft сохранён
  для diary-key, диск микрофона после вставки скрыт.
- `ok: false` → тост с `result.error`, поле пустое.
- Тап ✕ — отмена: поле пустое, тостов нет, транскрибация не вызывалась.
- Запись < 1 s + стоп — info-тост «Запись слишком короткая»,
  транскрибация не вызывалась.
- В processing весь ряд неактивен: тапы по ✕/⏹ не эмитят, повторный
  запуск записи невозможен.
- Флаг off (`COMPOSER_VOICE_INPUT = false` через мок констант) — диск не
  рендерится, прежнее поведение байт-в-байт.

### Команды проверки

```bash
cd frontend
npm test -- audio useVoiceRecorder openrouter VoiceRecordingPanel Composer DiaryComposer ChatThreadScreen
npm run typecheck
npm run lint
```

Визуальный browser-run и screenshot comparison не входят в проверку этой
задачи.

## 10. Что уточнить у владельца до/во время реализации

1. Реальный ключ OpenRouter (владелец кладёт в `frontend/.env` сам) и
   выставленный в дашборде spend cap — без этого фича в dev-окружении
   честно отвечает «Голосовой ввод недоступен».
2. Финальный текст промпта транскрибации, если будет пожелание по стилю
   расшифровок (пунктуация/абзацы).
3. Ограничение 60 s и порог 1 s для «слишком короткой записи» — числа
   дефолтные, меняются константами в одном месте.
4. Нужные SVG для `IconStop` из Figma (или согласовать отрисовку квадрата
   по образцу текущих glyph-иконок).

## 11. Шаг 2 — голосовой ввод во всех textarea

Шаг 1 проверен в бою (Composer); шаг 2 раскатывает тот же пайплайн на все
многострочные поля приложения. Два шага — два PR: шаг 2 не начинать до
приёмки шага 1.

### Подход

1. Общая оркестрация выносится из Composer в
   `src/composables/useVoiceDictation.ts` (новый файл): оборачивает
   `useVoiceRecorder` + `transcribeAudio`, отдаёт `state`
   (`'idle'|'recording'|'processing'`), `elapsedSec`, `errorReason`,
   `start()`, `stop()` (стоп → транскрибация → расшифровка или ошибка) и
   `cancel()`. Composer переводится на него как на единственный пайплайн —
   поведение не меняется, шаг-1 тесты остаются зелёными.
2. Основная точка подключения — DS-примитив
   `src/components/ui/VTextarea.vue`: необязательный проп `voiceInput`,
   дефолт которого — глобальный флаг `TEXTAREA_VOICE_INPUT = true`
   (`constants.ts`, kill-switch того же сорта, что
   `COMPOSER_VOICE_INPUT`; `false` убирает микрофон со ВСЕХ textarea без
   правок call-sites). Точечный opt-out на конкретном поле:
   `:voice-input="false"`.
3. Нативный textarea редактирования записи (`EntryView.vue`, контент) —
   единственное многострочное поле вне VTextarea. НЕ мигрировать его на
   VTextarea (там свой autogrow/scroll — риск регрессии): локальная врезка
   на `useVoiceDictation` + `VoiceRecordingPanel` по образцу Composer.
   Заголовок записи (однострочный input) голосовым вводом не покрывается.

### Известные места с textarea (проверить все)

- `FormShell.vue` (рефлексия/фидбек/чек-ин) — поле комментария;
- `SupportView.vue` и `MasterSupportView.vue` — текст обращения;
- `AdminSupportDetailView.vue` — ответ оператора;
- `SendMessageModal.vue` — сообщение мастеру;
- `CuratorGroupPageView.vue` и `MasterGroupDetailView.vue` — посты групп;
- `BookingConfirmedView.vue` — заметка к бронированию;
- `ReportUserSheet.vue` — жалоба;
- `EntryView.vue` — контент записи (нативный textarea, см. выше).

Перед завершением шага агент обязан прогнать `grep -rn "VTextarea"
frontend/src` и убедиться, что на каждом call-site поле с включённым
флагом рендерится корректно (мик не ломает ни одну компоновку); исключения
— только через `:voice-input="false"` с указанием причины в комментарии.

### Отличия от Composer (осознанные, не «унифицировать»)

- Микрофон виден ВСЕГДА, когда поле доступно (не disabled/readonly/
  loading) — не только при пустом поле: в формах и рефлексиях диктовка в
  непустой текст нужна. Расшифровка ДОБАВЛЯЕТСЯ к содержимому: чистая
  функция `appendTranscript(current, transcript, maxLen?)` (экспорт из
  `useVoiceDictation.ts`): пустое поле → расшифровка; непустое →
  `current + separator + transcript`, где separator — один пробел, если
  `current` не кончается пробельным символом; затем обрезка по `maxLen`
  (в VTextarea передаётся её prop `maxlength`), если задан. Правило «хоть
  1 символ — микрофон скрыт» остаётся ТОЛЬКО в Composer.
- Кнопка микра — ghost-иконка (`IconMic`, без заливки-диска) в правом
  верхнем углу поля: прозрачный фон, цвет `--velo-text-placeholder`,
  hit-area 44 px; textarea при включённом голосе получает дополнительный
  padding-right, чтобы текст не заходил под иконку.
- Во время записи textarea скрывается (`v-show`), на её месте —
  `VoiceRecordingPanel` в геометрии поля ([✕] [●] [0:07] … [⏹], как в
  §5); processing — busy-состояние, поле неактивно до результата.
- Ошибки — те же тосты (маппинг §2); пустая расшифровка — тост «Не
  удалось распознать речь», содержимое поля не меняется.

### Файлы Шага 2

Новые:

- `frontend/src/composables/useVoiceDictation.ts` + тест (включая
  `appendTranscript`).

Изменяемые:

- `frontend/src/components/shared/Composer.vue` — перевод на
  `useVoiceDictation` (поведение идентично, шаг-1 тесты зелёные);
- `frontend/src/components/ui/VTextarea.vue` + тест;
- `frontend/src/views/user/EntryView.vue` + тест;
- `frontend/src/utils/constants.ts` — `TEXTAREA_VOICE_INPUT`.

### Тесты Шага 2

- `useVoiceDictation.test.ts`: стейт-машина start → recording →
  processing → результат/ошибка на моках рекордера и `transcribeAudio`;
  cancel; `appendTranscript`: пустое поле, непустое без хвостового
  пробела, с хвостовым переводом строки, обрезка по maxLen.
- Тест `VTextarea`: мик есть по дефолту (флаг true), скрыт при
  disabled/readonly и при `:voice-input="false"`; тап → панель; стоп →
  текст дописан с учётом maxlength; ✕ → содержимое без изменений;
  processing неактивен.
- Тест `EntryView`: мик на контентном textarea, вставка дописывает текст,
  заголовок не затронут.
- Смоук FormShell/Support: поле рендерится с миком без ломки компоновки.

### Команды проверки Шага 2

```bash
cd frontend
npm test -- useVoiceDictation VTextarea EntryView Composer
npm run typecheck
npm run lint
```

### Definition of Done Шага 2

- На каждом textarea приложения (список выше + grep-сверка) работает
  голосовой ввод; kill-switch `TEXTAREA_VOICE_INPUT = false` убирает его
  везде без правок call-sites.
- Расшифровка дописывается к существующему тексту с обрезкой по maxlength;
  пустая расшифровка и ошибки оставляют поле нетронутым.
- Composer работает на общем `useVoiceDictation`, все шаг-1 тесты зелёные.
- `EntryView` покрыт локальной врезкой; заголовок записи не затронут.

## Definition of Done (Шаг 1)

- В обоих composer (чат с мастером, дневник) микрофон на пустом поле
  работает по tap-to-toggle: тап — запись, панель с ✕ / зелёной точкой /
  секундомером / ⏹; тап по ⏹ — стоп и транскрибация; тап по ✕ — отмена;
  запись < 1 s — подсказка без запроса; на время обработки ряд
  задизейблен.
- Во время записи видны зелёная мягко мигающая точка и секундомер; панель
  живёт в существующей glass-карточке ряда, геометрия не прыгает.
- Запись доступна только при полностью пустом поле: первый введённый
  символ (включая пробел или текст из загруженного черновика) прячет
  микрофон, очистка — возвращает.
- Расшифровка вставляется в то поле, из которого запись была вызвана,
  draft/canSend/send-диск реагируют как на обычный ввод; клавиатура сама
  не поднимается.
- Все ошибки (нет ключа, нет разрешения, ошибка OpenRouter, пустая
  расшифровка) честны и локализованы по таблице §2; ни одного fake success.
- WAV-конвертация обязательна и покрыта тестами (OpenAI-модели принимают
  только wav/mp3).
- Kill-switch `COMPOSER_VOICE_INPUT = false` возвращает composer к прежнему
  поведению без изменений в потребителях.
- Бек, `client.ts` и все перечисленные в «не менять» поверхности не тронуты.
- `VITE_OPENROUTER_API_KEY` / `VITE_OPENROUTER_TRANSCRIBE_MODEL` описаны в
  `env.d.ts` и `.env.example` с предупреждением о публичности ключа.
- Все перечисленные unit/screen-тесты, typecheck и lint проходят.
