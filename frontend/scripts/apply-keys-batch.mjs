#!/usr/bin/env node
// tz-i18n phase 2.2b, batch 4 (ONE-SHOT codemod): mechanical label->key
// swaps across the remaining small shared components, plus the useI18n
// import + composer binding for files that gain t() calls.
// Complex/coupled files are NOT here (tz-i18n §3.1): ReportUserSheet,
// MethodTaxonomyPicker, VShowMore (caller contract).
import { readFileSync, writeFileSync } from 'node:fs'

const B = (s) => `<script setup lang="ts">\nimport { useI18n } from 'vue-i18n'\n\nconst { t } = useI18n({ useScope: 'global' })`
// The exact insertion block (single-quoted in generated code):
const INJECT = `<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })`

const jobs = [
  {
    file: 'src/components/shared/SchoolAvatarPicker.vue',
    subs: [
      ['<span>+ Загрузить фото</span>', `<span>{{ t('school.upload') }}</span>`],
      ['inputEl?.click()">Заменить</button>', `inputEl?.click()">{{ t('school.replace') }}</button>`],
      ['onRemove">Убрать</button>', `onRemove">{{ t('school.remove') }}</button>`],
    ],
  },
  {
    file: 'src/components/shared/SchoolBannerPicker.vue',
    subs: [
      ['<span>+ Загрузить фото</span>', `<span>{{ t('school.bannerUpload') }}</span>`],
      ['inputEl?.click()">Заменить</button>', `inputEl?.click()">{{ t('school.bannerReplace') }}</button>`],
      ['onRemove">Убрать</button>', `onRemove">{{ t('school.bannerRemove') }}</button>`],
    ],
  },
  {
    file: 'src/components/shared/VoiceRecordingPanel.vue',
    subs: [
      ['aria-label="Отменить запись"', `:aria-label="t('voice.cancelAria')"`],
      ['<span class="voice-panel__busy">Транскрибация…</span>', `<span class="voice-panel__busy">{{ t('voice.transcribing') }}</span>`],
      ['aria-label="Завершить запись"', `:aria-label="t('voice.stopAria')"`],
    ],
  },
  {
    file: 'src/components/shared/MasterCard.vue',
    subs: [
      [`:name="masterName ?? 'Мастер'"`, `:name="masterName ?? t('booking.masterFallback')"`],
      [`toast.info('Профиль мастера недоступен')`, `toast.info(t('masterCard.profileUnavailable'))`],
    ],
  },
  {
    file: 'src/components/shared/CuratorGroupRow.vue',
    subs: [
      ['active> Кураторство </VChip>', `active>{{ t('curatorGroup.offerBadge') }} </VChip>`],
    ],
  },
  {
    file: 'src/components/shared/DiarySearchResults.vue',
    subs: [
      [
        'aria-live="polite">Найдено: {{ items.length }}{{ hasMore ? \'+\' : \'\' }}</p>',
        `aria-live="polite">{{ t('diary.search.found', { n: items.length }) }}{{ hasMore ? '+' : '' }}</p>`,
      ],
    ],
  },
  {
    file: 'src/components/shared/PracticePlaceholder.vue',
    subs: [[`:alt="title ?? 'Практика'"`, `:alt="title ?? t('practice.placeholderAlt')"`]],
  },
  {
    file: 'src/components/shared/TimePickerSheet.vue',
    subs: [
      ['save-label="Сохранить"', `:save-label="t('ui.save')"`],
      [`:title="title"`, `:title="title ?? t('timePicker.title')"`],
      [`{ modelValue: '', title: 'Время практики' }`, `{ modelValue: '' }`],
    ],
  },
  {
    file: 'src/components/shared/MoodSlider.vue',
    subs: [
      [`{ ariaLabel: 'Оценка состояния от 1 до 10', disabled: false }`, `{ ariaLabel: undefined, disabled: false }`],
      [`props.ariaLabel ?? 'Оценка состояния от 1 до 10'`, `props.ariaLabel ?? t('mood.ariaScale')`],
    ],
  },
  {
    file: 'src/components/shared/RoleSwitchSection.vue',
    subs: [
      ['<div class="role-switch__title">Переключение роли</div>', `<div class="role-switch__title">{{ t('roleSwitch.title') }}</div>`],
      [`const ROLE_LABEL: Record<UserRole, string> = {
  user: 'Режим пользователя',
  master: 'Режим мастера',
  admin: 'Режим администратора',
}`, `const ROLE_LABEL: Record<UserRole, string> = {
  get user(): string {
    return t('roleSwitch.user')
  },
  get master(): string {
    return t('roleSwitch.master')
  },
  get admin(): string {
    return t('roleSwitch.admin')
  },
}`],
      [`toast.error('Не удалось переключить роль')`, `toast.error(t('roleSwitch.failed'))`],
    ],
  },
  {
    file: 'src/components/shared/CalendarPracticeCard.vue',
    subs: [
      [`return { label: 'Оплачено', variant: 'success', paid: true }`, `return { label: t('calendarCard.paid'), variant: 'success', paid: true }`],
      [`return { label: 'Бесплатно', variant: 'blue', paid: false }`, `return { label: t('common.free'), variant: 'blue', paid: false }`],
    ],
  },
  {
    file: 'src/components/shared/DiarySearchBar.vue',
    subs: [
      ['placeholder="Искать..."', `:placeholder="t('diary.search.placeholder')"`],
      ['aria-label="Поиск по дневнику"', `:aria-label="t('diary.search.aria')"`],
      ['aria-label="Очистить"', `:aria-label="t('diary.search.clearAria')"`],
      ['<h3 class="diary-search__recent-label">Недавно вы искали:</h3>', `<h3 class="diary-search__recent-label">{{ t('diary.search.recent') }}</h3>`],
    ],
  },
  {
    file: 'src/components/shared/UseTemplateBlock.vue',
    subs: [
      ['<span class="use-template__head-text">Вы создавали ранее…</span>', `<span class="use-template__head-text">{{ t('useTemplate.head') }}</span>`],
      ['Данных пока нет — создайте первую практику', `{{ t('useTemplate.empty') }}`],
    ],
  },
  {
    file: 'src/components/shared/SchoolInviteCard.vue',
    subs: [
      ['>Куратор: {{ curatorName }}</p>', `>{{ t('school.curator', { name: curatorName }) }}</p>`],
      [
        "  () => `${props.studentsCount} ${plural(props.studentsCount, 'ученик', 'ученика', 'учеников')}`,",
        `  () => t('school.students', { n: props.studentsCount }),`,
      ],
      [
        "  () => `${props.mastersCount} ${plural(props.mastersCount, 'мастер', 'мастера', 'мастеров')}`,",
        `  () => t('school.masters', { n: props.mastersCount }),`,
      ],
    ],
  },
  {
    file: 'src/components/shared/SchoolHeroCard.vue',
    subs: [
      [
        "  () => `${props.studentsCount} ${plural(props.studentsCount, 'ученик', 'ученика', 'учеников')}`,",
        `  () => t('school.students', { n: props.studentsCount }),`,
      ],
      [
        "  () => `${props.mastersCount} ${plural(props.mastersCount, 'мастер', 'мастера', 'мастеров')}`,",
        `  () => t('school.masters', { n: props.mastersCount }),`,
      ],
    ],
  },
  {
    file: 'src/components/shared/DiaryThreadCard.vue',
    subs: [
      [`const BANNER_CONFIRMED_TITLE = 'Вы записались на'`, `// tz-i18n 2.2b: TWO keys (the design styles line 2 differently): a plain
// title line and a bracketed reference line; non-locales assemble the
// title+master pair differently ("... for X with Y").
const bannerConfirmedTitle = computed(() => t('diary.bannerConfirmedTitle'))
const bannerConfirmedRef = computed(() =>
  t('diary.bannerConfirmedRef', {
    title: practiceTitle.value,
    master: masterName.value ?? t('shared.form.hostFallback'),
  }),
)`],
      [
        `const bannerLine1 = computed(() =>
  kind.value === 'booking_confirmed' ? BANNER_CONFIRMED_TITLE : baseTitle.value,
)`,
        `const bannerLine1 = computed(() =>
  kind.value === 'booking_confirmed' ? bannerConfirmedTitle.value : baseTitle.value,
)`,
      ],
      [
        `const bannerLine2 = computed(() => {
  if (kind.value === 'booking_confirmed') {
    const withMaster = masterName.value ? \` с \${masterName.value}\` : ''
    return \`[\${practiceTitle.value}\${withMaster}]\`
  }
  return bannerSubtitle.value
})`,
        `const bannerLine2 = computed(() =>
  kind.value === 'booking_confirmed' ? bannerConfirmedRef.value : bannerSubtitle.value,
)`,
      ],
    ],
  },
  {
    file: 'src/components/shared/PracticeAudiencePicker.vue',
    subs: [
      ['Пока нет ни одной группы. Создайте группу на экране «Мои группы».', `{{ t('audience.noGroups') }}`],
      ['<p v-else class="pap__empty">Нет школ, доступных для выбора.</p>', `<p v-else class="pap__empty">{{ t('audience.noSchools') }}</p>`],
    ],
  },
]

let touched = 0
for (const job of jobs) {
  let src = readFileSync(job.file, 'utf8')
  let applied = 0
  for (const [from, to] of job.subs) {
    if (!src.includes(from)) {
      console.log(`MISS ${job.file}: ${from.slice(0, 60)}`)
      continue
    }
    src = src.split(from).join(to)
    applied++
  }
  if (applied === 0) continue
  if (!src.includes('useI18n')) {
    if (!src.includes('<script setup lang="ts">')) {
      console.log(`NO SCRIPT TAG: ${job.file}`)
      continue
    }
    src = src.replace('<script setup lang="ts">', INJECT)
  }
  writeFileSync(job.file, src)
  touched++
  console.log(`${job.file}: ${applied} sub(s)`)
}
console.log(`done: ${touched} files`)
