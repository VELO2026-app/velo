# Быстрый доступ и создание внешней активности — ТЗ для frontend-агента

## Статус и границы задачи

Это frontend-задача на новый пользовательский путь:

1. две кнопки быстрого доступа на главной;
2. переход из «Добавить запись» сразу к вводу обычной записи в дневнике;
3. отдельный экран «Новое событие» для активности, которая произошла вне приложения;
4. подготовленный seam для подключения backend API;
5. после появления API — сохранение активности и обновление дневника.

Backend-контракт для внешней активности пока уточняется. Поэтому UI, роутинг,
локальное состояние и тесты можно сделать заранее, но нельзя:

- отправлять внешнюю активность в существующий `POST /api/v1/diary`;
- сохранять её как `note`, `dream`, `checkin`, `feedback` или `practice_outcome`;
- показывать ложный success, если данные не были сохранены на сервере;
- локально подмешивать фальшивое событие в diary feed.

Пока backend не готов, production-вход «Внести активность» не включать. Допустимо
держать готовый экран и его unit-тесты в коде, но публиковать кнопку следует в том
же релизе, где реальный submit уже подключён. Не заводить ради одного экрана
новую глобальную систему feature flags без отдельного решения.

Карточка сохранённой внешней активности внутри дневника в эту задачу **не
входит**. Для неё понадобятся утверждённые backend `kind` и `snapshot`; нельзя
изображать её одним из существующих типов. Существующие карточки дневника
описаны отдельно в `docs/diary-thread-events-ui-task.md`.

Визуальные browser/screenshot-проверки в рамках этой задачи не выполнять. Проверка
должна быть по коду, unit/screen-тестам, typecheck и lint.

## Что уже есть в проекте

- Главная пользователя: `frontend/src/views/user/UserDashboardView.vue`.
- Сейчас после «Ближайшие практики» сразу идёт «Ваш прогресс»; блока «Быстрый
  доступ» нет.
- Дневник: `frontend/src/views/user/DiaryFeedView.vue`.
- Ввод записи: `frontend/src/components/shared/DiaryComposer.vue` поверх
  `frontend/src/components/shared/Composer.vue`.
- У `Composer` есть внутренний `focusField()`, но ни `Composer`, ни
  `DiaryComposer` не отдают публичный `focus()` родителю. Поэтому одной навигации
  на `/user/diary` недостаточно, чтобы «Добавить запись» действительно было
  быстрым входом в написание текста.
- Дата и время уже выбираются через
  `frontend/src/components/shared/DatePickerSheet.vue` и
  `frontend/src/components/shared/TimePickerSheet.vue`.
- Печать обязательности уже существует: `IconRequired`; заполненное состояние —
  `IconRequiredDone`.
- Нужные иконки состояния уже есть: `IconRatingConfused`, `IconRatingGood`,
  `IconRatingFire`; их цвета заданы через `RATING_ICON_COLOR`.
- Общий `FormShell` рассчитан на check-in/feedback/reflection с карточкой
  практики и общей структурой вопроса. Для «Нового события» он не подходит и
  расширяться под эту задачу не должен.

## 1. Блок «Быстрый доступ» на главной

### Положение

Добавить отдельную секцию в `UserDashboardView.vue`:

```text
Ближайшие практики
карточка практики
Zoom / Check-in

Быстрый доступ
Внести активность
Добавить запись

Ваш прогресс
...
```

Секция должна присутствовать независимо от того, есть ли ближайшая практика,
идёт ли её загрузка или показан empty state. Она не является частью карточки
практики.

Заголовок использовать того же уровня и с тем же классом/типографикой, что
«Ближайшие практики» и «Ваш прогресс»: `dashboard__section-title`.

### Кнопка «Внести активность»

- Семантически это `<button type="button">`, не ссылка и не карточка.
- На всю доступную ширину контентного rail.
- Высота не меньше 44 px; форма — вытянутая капсула с полностью округлёнными
  концами (`border-radius: var(--radius-full)`).
- Фон: полупрозрачный персиковый (`--velo-glass-peach-40`).
- Контур: 1.5–2 px персикового акцента (`--velo-peach-500`).
- Текст и обе иконки: тот же персиковый акцент.
- Слева — отдельная иконка активности без собственного background/circle.
- По центру оставшегося места — подпись `Внести активность`, визуально
  выровненная влево.
- Справа — chevron вправо. Это короткий chevron из макета, не длинная стрелка
  `IconArrowRight`, если их силуэты различаются.
- Внутренние отступы по горизонтали около 14–16 px; расстояние иконка → текст
  около 10–12 px.
- По нажатию: `router.push({ name: 'user-diary-activity-new' })`.

Нельзя собирать эту строку из обычного `VButton`: его контент центрируется и он
не обеспечивает схему «leading icon / растущий label / trailing chevron».
Достаточно локальной разметки и scoped-стилей в dashboard; отдельный shared
компонент нужен только если этот паттерн появляется ещё на одном экране.

### Кнопка «Добавить запись»

Геометрия полностью совпадает с первой кнопкой. Отличаются только тон, иконка,
текст и действие:

- фон: `--velo-glass-teal-40`;
- контур: 1.5–2 px `--velo-teal-600`;
- текст и иконки: `--velo-teal-700` или ближайший существующий токен, который
  сохраняет читаемость;
- leading icon — иконка записи/пера/растения именно из Figma;
- подпись: `Добавить запись`;
- trailing chevron — тот же, что у первой строки;
- по нажатию: переход в дневник с одноразовым намерением открыть composer:

```ts
router.push({
  name: 'user-diary',
  query: { compose: 'note' },
})
```

Между двумя капсулами оставить один небольшой вертикальный шаг, визуально около
8–12 px. Они не должны сливаться в одну карточку.

### Состояния кнопок

- Нормальное: как описано выше.
- `:active`: лёгкое уменьшение opacity/scale без сдвига соседнего контента.
- `:focus-visible`: явный outline, не удалять клавиатурный фокус.
- Disabled допустим только как временное release-состояние до API. Если кнопку
  всё же показывают disabled, рядом/под ней должно быть честное `Скоро`; одна
  молча неработающая кнопка недопустима. Предпочтительный release-вариант — не
  показывать её до подключения submit.
- Touch target — вся капсула, не только текст или chevron.

## 2. «Добавить запись»: одноразовый фокус дневника

Цель: один tap на главной открывает дневник и переводит существующий composer в
режим ввода `note`. Новый экран записи создавать не нужно.

Изменения публичного контракта:

1. В `Composer.vue` экспортировать через `defineExpose` метод `focus()`.
   Метод должен вызывать существующую логику `focusField()`, а не дублировать
   focus/autogrow/preview-поведение.
2. В `DiaryComposer.vue` держать ref на `Composer` и проксировать наружу
   `focus()`.
3. В `DiaryFeedView.vue` держать ref на `DiaryComposer`.
4. Если `route.query.compose === 'note'`, после mount/`nextTick` вызвать
   `diaryComposerRef.focus()`.
5. После обработки удалить только `compose` через `router.replace`, сохранив
   остальные query-параметры. Иначе повторный mount/back снова будет открывать
   клавиатуру.

Если WebView не разрешит программно поднять soft keyboard после перехода,
composer всё равно должен раскрыться и получить caret/focus; следующего tap по
полю не должно требоваться для выхода из collapsed preview.

Существующий draft `velo:diary:draft:note`, отправка записи, autogrow, blur,
outside-tap и позиция ленты не меняются.

## 3. Роут и layout экрана «Новое событие»

Добавить:

```ts
{
  path: 'diary/activity/new',
  name: 'user-diary-activity-new',
  component: () => import('@/views/user/ExternalActivityCreateView.vue'),
}
```

Экран полноэкранный и иммерсивный:

- нижний tab bar скрыт;
- внешний `MobileLayout` работает в fill-режиме;
- экран сам содержит header, прокручиваемое тело и нижний action bar;
- фон приложения/мандала остаётся видимым между белыми элементами;
- не использовать fog mask поверх формы;
- не использовать `VHeader`: референс имеет собственную компактную строку
  header внутри экрана.

В `UserShell.vue` добавить route name в условия `hideTabBar` и `isFillRoute`.
Не делать широкую перестройку всех route meta ради одного нового экрана.

Структура корня:

```text
external-activity (height: 100%; flex-column; min-height: 0)
  header (flex: 0 0 auto)
  scroll-body (flex: 1 1 auto; min-height: 0; overflow-y: auto)
  footer (flex: 0 0 auto)
```

Так кнопка «Сохранить» остаётся у нижнего края, а прокручивается только форма.
Footer не должен перекрывать textarea. Safe-area уже применена `AppFrame`; не
добавлять второй `env(safe-area-inset-*)` без проверки существующего layout.

### Header

- Слева — существующий `VBackButton` с `aria-label="Назад на главную"`.
- В текущем design system `VBackButton` — круг 44×44. Не создавать второй
  screenshot-only back pill: репозиторий явно объявляет круг каноническим для
  всех экранов.
- Рядом слева заголовок `Новое событие`, одна строка, цвет
  `--velo-text-primary`.
- Back всегда ведёт на `{ name: 'user-dashboard' }`; это также безопасный
  fallback для deep link без browser history.
- Справа в референсе есть круглая кнопка `...`. Сейчас для неё не определено ни
  одного действия. Нельзя рендерить кликабельный `VMenu` с пустой панелью.
  До уточнения действий оставить справа spacer размером с `VMenu` trigger, чтобы
  геометрия header не прыгнула. Если product подтвердит действие, использовать
  существующий `VMenu`, а не рисовать новый kebab.

## 4. Экран «Новое событие»: полный UI

Порядок элементов фиксирован:

```text
[back] Новое событие                         [right slot]

[required legend]

Когда произошло событие
[Дата]                                      [required seal]
[Время]                                     [required seal]

Выбор активности
[white activity card with chips + custom input] [required seal]

Мое состояние
[confused]        [good]        [fire]       [required seal]

Мысли
[textarea]

[Сохранить]
```

### Легенда обязательных полей

Это постоянная легенда, а не ошибка, появляющаяся после submit:

```text
[IconRequired] — поля, обязательные для заполнения
```

Использовать ту же структуру, что в `CreatePracticeView.vue` /
`MasterGroupCreateView.vue`:

- розовая полупрозрачная plate;
- розовая рамка;
- радиус около 12–15 px;
- `IconRequired` 22 px слева;
- текст 14 px;
- вся строка компактная, ориентировочно 38–42 px, а не 64 px как `Banner`.

Не использовать shared `Banner`: его min-height и двухстрочная структура для
этой легенды слишком велики.

### Секция «Когда произошло событие»

Заголовок: `Когда произошло событие`.

Два независимых picker-trigger поля:

- первое отображает `Дата`, пока значение пустое;
- второе отображает `Время`, пока значение пустое;
- после выбора показывать локализованную дату и `HH:MM`;
- оба поля — белые пластины на всю ширину до gutter обязательной печати;
- форма близка к прямоугольнику с мягким небольшим радиусом, не капсула;
- высота 40 px, текст слева, padding 16 px;
- `IconRequired`/`IconRequiredDone` расположен **снаружи** белого поля справа в
  зарезервированном gutter, как в date/time блоке `CreatePracticeView.vue`;
- пустое поле использует placeholder color, заполненное — primary text color;
- error state — розовая рамка и короткая ошибка под соответствующим полем.

Использовать `DatePickerSheet` и `TimePickerSheet`. Для внешнего события дата в
будущем недопустима. Добавить в `DatePickerSheet` необязательный prop `max` по
аналогии с существующим `min`; изменение должно быть backward-compatible для
всех текущих вызовов. На этом экране передавать `max=today`.

Если выбрана сегодняшняя дата и будущее время, блокировать submit общей
валидацией timestamp. Не усложнять shared `TimePickerSheet` динамическим max,
пока product отдельно этого не потребует.

Дата и время интерпретируются в timezone профиля пользователя через
`useViewerTimezone`. Нельзя собирать timestamp через local browser timezone.
Если backend принимает единый ISO timestamp, адаптер должен формировать его
через Luxon и отправлять UTC ISO; окончательное правило зависит от backend
контракта.

### Секция «Выбор активности»

Заголовок: `Выбор активности`.

Слева расположен белый rounded container, справа — отдельный required gutter.
Контейнер:

- solid white background;
- радиус около `var(--radius-md)`;
- padding 12–16 px;
- chips переносятся естественно (`display:flex; flex-wrap:wrap`);
- горизонтальный и вертикальный gap 8–10 px;
- на ширине референса должны естественно получаться примерно две chips в строке,
  без hardcoded grid-колонок.

Предустановленные chips, строго в этом порядке:

| UI label | Временный frontend key |
|---|---|
| Вокал | `vocal` |
| Гвоздестояние | `nail_standing` |
| Медитация | `meditation` |
| Массаж | `massage` |
| Йога | `yoga` |
| Танцы | `dance` |

Keys считаются frontend-моделью до утверждения backend enum; перед отправкой их
маппит один API adapter. Не размазывать строковые значения по template/store.

Chips:

- вытянутые капсулы;
- border 1–1.5 px primary blue;
- обычное состояние: белое/прозрачное внутри, синий текст;
- selected: solid `--velo-primary`, белый текст и border того же цвета;
- выбор одиночный;
- кнопки имеют `aria-pressed`;
- можно использовать `VChip size="md" clickable`, если итоговая высота и
  отступы совпадают с макетом; не копировать его CSS без необходимости.

#### «Свой вариант»

В референсе это не постоянно видимая седьмая chip. Начальное состояние:

1. шесть предустановленных chips;
2. ниже — отдельное outlined capsule-поле `Укажите ваш вариант`;
3. справа внутри поля — диагональная action-arrow из Figma.

Поведение:

- ввод текста сам по себе не переключает выбранную активность;
- tap по стрелке или Enter при непустом `trim()` выбирает `custom`;
- после этого над полем появляется filled chip `Свой вариант`, как на последнем
  кадре референса;
- введённый текст остаётся в поле и становится `customActivityName`;
- выбор любой предустановленной chip снимает `custom`, но не обязан стирать
  введённый draft — пользователь может вернуться к нему;
- повторный commit стрелкой снова выбирает `custom`;
- если выбранный custom очищен до пустой строки, форма становится invalid,
  required seal возвращается в красное состояние;
- пустая arrow-action ничего не сохраняет и показывает ошибку у поля;
- trailing arrow является кнопкой с `aria-label="Выбрать свой вариант"`, а не
  декоративной картинкой.

Нельзя использовать `MethodTaxonomyPicker`: он обслуживает двухуровневую
таксономию методов мастера, ходит в `/taxonomy` и возвращает другой payload.

Required seal всей секции считается заполненным, когда:

```ts
selectedActivity !== null &&
(selectedActivity !== 'custom' || customActivityName.trim().length > 0)
```

### Секция «Мое состояние»

Заголовок: `Мое состояние`.

Ряд из трёх больших самостоятельных icon-buttons, без slider track и без
подписей под иконками:

| Значение UI | Иконка | Цвет | Accessible label |
|---|---|---|---|
| `2` | `IconRatingConfused` | `RATING_ICON_COLOR.confused` | `Есть вопросы` |
| `6` | `IconRatingGood` | `RATING_ICON_COLOR.good` | `Хорошо` |
| `9` | `IconRatingFire` | `RATING_ICON_COLOR.fire` | `Огонь` |

Значения `2 / 6 / 9` — уже существующие центры трёх зон в `MoodSlider` и
сохраняют общую семантику `1–3 / 4–7 / 8–10`. Если backend утвердит enum вместо
score, преобразование выполняется только в API adapter.

Важно: розовый `IconRatingGood` сам по себе не означает, что он выбран. Цвета
трёх иконок семантические. Начальное значение должно быть `null`; нельзя молча
подставлять «Хорошо» за пользователя.

- У каждой кнопки touch area минимум 44×44, целевая видимая иконка около 54–60
  px согласно Figma export.
- Ряд распределяет три кнопки равномерно и оставляет справа отдельный gutter для
  required seal.
- Нажатие выбирает ровно одно значение; `aria-pressed` отражает выбор.
- Selected/pressed-вариант должен быть получен из Figma. До получения не
  перекрашивать glyph: временно допустим тонкий внешний ring/halo и небольшой
  scale, который не меняет высоту ряда.
- Не использовать `MoodSlider`: на целевом экране нет track, thumb и labels.
- Required seal красный при `null`, зелёный после выбора.

### Секция «Мысли»

Заголовок: `Мысли`.

Поле необязательное. Copy placeholder должен совпадать:

```text
Напишите, что это было и что с вами произошло. Вы можете вернуться к рефлексии позже
```

Использовать `VTextarea` с visually-hidden accessible label `Мысли`, но сделать
экранный variant через scoped class:

- solid white background;
- приблизительно 110–120 px минимальной высоты;
- мягкий небольшой радиус, визуально ближе к прямоугольной plate, чем к карточке;
- resize выключен на mobile;
- текст начинается сверху слева;
- placeholder переносится естественно;
- no required seal;
- `useKeyboardFieldScroll` уже находится внутри `VTextarea`, дублировать его во
  view не нужно.

Ограничение длины не придумывать до backend-контракта. После получения схемы
`maxlength` и счётчик должны совпадать с серверным лимитом.

### Нижняя кнопка «Сохранить»

- Отдельный footer под scroll-body.
- Full-width primary pill, высота 50 px, подпись `Сохранить`.
- Использовать `VButton variant="primary" block`.
- Кнопка остаётся видимой при прокрутке формы и не перекрывает последний field.
- До первого submit она визуально активна, как в референсе; отсутствие required
  полей обрабатывается валидацией, а не silent disabled.
- Во время реального запроса: `loading=true`, повторный tap игнорируется.
- Пока API отсутствует, нельзя оставлять активную кнопку, которая показывает
  success без сохранения. Экран не включается в production entry point.

## 5. Локальная модель формы

До появления generated backend types использовать view-local UI-модель:

```ts
type ActivityChoice =
  | 'vocal'
  | 'nail_standing'
  | 'meditation'
  | 'massage'
  | 'yoga'
  | 'dance'
  | 'custom'

interface ExternalActivityDraft {
  date: string                 // YYYY-MM-DD, timezone пользователя
  time: string                 // HH:mm
  activity: ActivityChoice | null
  customActivityName: string
  stateScore: 2 | 6 | 9 | null
  thoughts: string
}
```

Начальные значения все пустые/`null`. Форму не автозаполнять текущими датой,
временем или состоянием: в макете поля явно начинаются пустыми, а автоподстановка
создала бы правдоподобную, но неверную запись.

Локальный draft persistence в эту задачу не входит. При API-ошибке введённые
данные остаются на экране; при успешном сохранении форма очищается только перед
уходом с route.

## 6. Валидация

Обязательны:

- `date`;
- `time`;
- выбранная активность;
- непустой `customActivityName.trim()`, если выбран `custom`;
- `stateScore`.

Необязательно:

- `thoughts`.

Дополнительные правила:

- итоговый timestamp не может быть в будущем в timezone пользователя;
- строка custom после trim не может быть пустой;
- лимиты длины и допустимая давность события берутся только из backend schema.

При невалидном submit:

1. сетятся ошибки всех невалидных полей/секций;
2. scroll-body прокручивается к первой ошибке;
3. первый доступный control получает focus;
4. required legend остаётся легендой и не заменяется общей ошибкой;
5. пользовательские значения не сбрасываются.

Ошибку группы активности показывать под белым card, ошибку состояния — под
icon-row. Не добавлять `*` в заголовки: обязательность уже обозначена seals.

## 7. Backend seam — подключить только после подтверждения контракта

Предполагаемая, но пока **не утверждённая** форма запроса:

```ts
interface CreateExternalActivityRequest {
  occurred_at: string
  activity_type:
    | 'vocal'
    | 'nail_standing'
    | 'meditation'
    | 'massage'
    | 'yoga'
    | 'dance'
    | 'custom'
  custom_activity_name: string | null
  mood: number
  thoughts: string | null
}
```

Не фиксировать endpoint или payload в production-коде по этому примеру. После
ответа backend:

1. обновить OpenAPI-generated types штатным `velo gen-types`; не редактировать
   `frontend/src/api/generated.ts` вручную;
2. добавить ровно один typed wrapper в `frontend/src/api/diary.ts`;
3. добавить в `useDiaryStore` отдельные `externalActivitySubmitting` и
   `submitExternalActivity()`;
4. внутри store после успешного POST вызвать существующий feed refresh;
5. view получает `{ ok, error, code? }` и не знает URL/transport;
6. UI keys преобразовать в backend enum в одном adapter/mapping;
7. `thoughts.trim() || null`; custom name отправляется только при `custom`.

На успешный ответ:

- дождаться завершения POST;
- best-effort обновить diary feed;
- показать success toast `Событие добавлено`;
- перейти на `{ name: 'user-diary' }`;
- не вставлять optimistic item вручную.

На ошибку:

- остаться на форме;
- сохранить весь draft;
- снять loading;
- field-level 422 ошибки привязать к соответствующим controls;
- неизвестную/network ошибку показать toast `Не удалось сохранить событие`;
- не показывать success и не переходить в дневник.

### Что нужно подтвердить у backend

- точный method/path;
- точные enum values типов активности;
- единый `occurred_at` или отдельные `date`/`time`/`timezone`;
- тип состояния: score 1–10, три enum-зоны или другое;
- максимальная длина custom name и thoughts;
- запрет/допуск будущей даты и максимальная давность;
- response schema и возвращаемый id;
- синхронно ли новая активность появляется в `GET /api/v1/diary/feed`;
- новый `DiaryEventKind`, `source_type`, `source_id` и полный snapshot;
- категория фильтра diary feed;
- нужны ли edit/delete/detail endpoint;
- защита от двойного POST/idempotency.

Без ответов на эти пункты можно завершить представление и локальную логику, но
нельзя считать end-to-end задачу выполненной.

## 8. Файлы, которые должен затронуть frontend-агент

Обязательная UI-часть:

- `frontend/src/views/user/UserDashboardView.vue`;
- `frontend/src/views/user/UserDashboardView.test.ts`;
- `frontend/src/router/index.ts`;
- `frontend/src/views/shells/UserShell.vue`;
- `frontend/src/views/user/ExternalActivityCreateView.vue` — новый;
- `frontend/src/views/user/ExternalActivityCreateView.test.ts` — новый;
- `frontend/src/components/shared/Composer.vue`;
- `frontend/src/components/shared/DiaryComposer.vue`;
- `frontend/src/components/shared/DiaryComposer.test.ts`;
- `frontend/src/views/user/DiaryFeedView.vue`;
- `frontend/src/views/user/DiaryFeedView.test.ts`;
- `frontend/src/components/shared/DatePickerSheet.vue` и его тест — только для
  backward-compatible `max`.

После готовности backend:

- `frontend/src/api/generated.ts` — только через генератор;
- `frontend/src/api/types.ts` — только re-export/узкий bridge, если это реально
  требуется до следующей генерации;
- `frontend/src/api/diary.ts`;
- `frontend/src/stores/diary.ts` и его тесты.

Иконки добавлять в `frontend/src/components/icons/` и экспортировать через
`index.ts`. SVG-компоненты должны принимать `size` и краситься через
`currentColor`; plate/background принадлежит кнопке, не SVG.

Не менять в этой задаче:

- backend;
- существующие карточки `DiaryThreadCard`/`DiaryFeedCard`;
- diary filters/search/pagination;
- `FormShell`;
- `MethodTaxonomyPicker`;
- check-in/feedback/reflection flows.

## 9. Тесты

### `UserDashboardView.test.ts`

- Блок расположен между nearest-practice section и progress section.
- Обе quick-action кнопки рендерятся с точными подписями.
- Нажатие «Внести активность» ведёт на `user-diary-activity-new`.
- Нажатие «Добавить запись» ведёт на `user-diary` с
  `query: { compose: 'note' }`.
- Блок остаётся при loading/empty ближайших практик.
- Touch actions не запускают click карточки практики.

### `Composer` / `DiaryComposer` / `DiaryFeedView`

- Публичный `focus()` фокусирует реальный textarea.
- `compose=note` вызывает focus один раз.
- Query очищается через replace без потери остальных query params.
- Обычный вход в дневник без query не меняет focus.
- Existing note draft при focus раскрывается, но не отправляется.

### `ExternalActivityCreateView.test.ts`

- Рендерятся все секции, exact copy и шесть activity chips в заданном порядке.
- Начальное состояние не содержит выбранной активности и состояния.
- Predefined chips работают как single-select.
- Ввод custom сам не выбирает его; arrow/Enter выбирает и показывает filled
  `Свой вариант`.
- Пустой custom не проходит валидацию.
- State buttons отдают 2/6/9 и корректный `aria-pressed`.
- Date, time, activity и state required; thoughts optional.
- Будущий timestamp блокируется в timezone профиля.
- Невалидный submit не вызывает API.
- Во время submit повторный клик не вызывает второй запрос.
- Успех refresh-ит feed и ведёт в дневник.
- Ошибка сохраняет draft, снимает loading и остаётся на route.
- Back ведёт на dashboard.
- Tab bar отсутствует, route использует fill layout.

### `DatePickerSheet.test.ts`

- `max` запрещает дни после верхней границы.
- Переход в следующий месяц/год за `max` не позволяет выбрать недопустимую дату.
- Все существующие вызовы без `max` остаются неизменными.
- `min` продолжает работать вместе с `max`.

### Команды проверки

```bash
cd frontend
npm test -- UserDashboardView DiaryComposer DiaryFeedView ExternalActivityCreateView DatePickerSheet
npm run typecheck
npm run lint
```

Визуальный browser-run и screenshot comparison не входят в проверку этой задачи.

## 10. Что забрать из Figma до финального pixel pass

Нужны отдельные SVG без внешних plate/background:

1. leading icon `Внести активность`;
2. leading icon `Добавить запись`;
3. trailing chevron quick-action строки, если текущий `IconArrowRight` не
   совпадает;
4. диагональная arrow-action поля `Укажите ваш вариант`;
5. active/pressed/focus state для трёх иконок «Мое состояние»;
6. назначение и пункты правого kebab на экране «Новое событие».

Также желательно снять из Dev Mode:

- точную высоту и border-width двух quick-action капсул;
- horizontal rail экрана;
- радиус required legend;
- радиус белых date/time полей;
- padding/radius activity card и gaps chips;
- размер трёх state icons и selected delta;
- высоту/radius textarea;
- footer paddings.

До получения чисел использовать существующие DS tokens, а не плодить близкие
цвета и радиусы. Компонентная геометрия должна оставаться устойчивой при замене
SVG: фиксируется slot/touch-box, не intrinsic width/height конкретной иконки.

## Definition of Done

- На dashboard есть две точные quick-action капсулы в нужном месте.
- «Добавить запись» за один переход раскрывает существующий note composer.
- Экран «Новое событие» собран как отдельный fill-route без tab bar.
- Все required/optional поля, chips, custom interaction и state buttons работают
  по описанным правилам.
- Ни одно поле не подставляет за пользователя фиктивное значение.
- До backend-интеграции нет fake submit/fake diary item.
- После утверждения backend-контракта POST типизирован, защищён от дубля, refresh
  diary feed вызывается, ошибки не уничтожают draft.
- Новая активность не маскируется под существующий diary kind.
- Все перечисленные unit/screen-тесты, typecheck и lint проходят.
- Никакие unrelated diary/check-in/feedback/form компоненты не переделаны.
