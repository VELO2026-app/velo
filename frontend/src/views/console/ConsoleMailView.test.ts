// =============================================================================
// VELO Frontend -- ConsoleMailView screen tests (FE-268, FE-262 slice 5)
// =============================================================================
//
// The screen is the announcement form (title, text, audience, send with a
// confirmation) and the card of the sent ones, empty until BE-256. The API
// seam is mocked (sendAnnouncement in @/api/admin); the screen mounts with a
// real Pinia and Colada (the send is an admin mutation). The confirmation is
// the kit's dialog, teleported to <body>.
//
// An announcement cannot be recalled and the server takes no idempotency key,
// so the tests that matter most are the guards against a second send.
// =============================================================================

import { createTestI18n } from '@/locales/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { coladaOptions } from '@/composables/queries/setup'
import ConsoleMailView from '@/views/console/ConsoleMailView.vue'
import * as adminApi from '@/api/admin'
import { ApiResponseError } from '@/api/client'

vi.mock('@/api/admin')

const toastError = vi.fn()
const toastSuccess = vi.fn()
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess, info: vi.fn() }),
}))

let app: App | null = null
let host: HTMLElement | null = null

async function mount(): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  const pinia = createPinia()
  setActivePinia(pinia)
  app = createApp(ConsoleMailView).use(createTestI18n()).use(pinia).use(PiniaColada, coladaOptions)
  app.mount(host)
  await flush()
}

async function flush(): Promise<void> {
  for (let n = 0; n < 6; n++) await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

function field(selector: 'input' | 'textarea'): HTMLInputElement | HTMLTextAreaElement {
  const el = host?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[data-testid="announcement-form"] ${selector}`,
  )
  if (!el) throw new Error(`no ${selector}`)
  return el
}
async function type(selector: 'input' | 'textarea', value: string): Promise<void> {
  const el = field(selector)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}
async function fill(
  title = 'Новые правила начислений',
  body = 'С 1 декабря ставка считается от проведённых сессий.',
): Promise<void> {
  await type('input', title)
  await type('textarea', body)
}
function form(): HTMLFormElement {
  const el = host?.querySelector<HTMLFormElement>('[data-testid="announcement-form"] form')
  if (!el) throw new Error('no form')
  return el
}
async function press(): Promise<void> {
  form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}
/** The confirmation's message while it is open (not while it is leaving). */
function dialogText(): string | null {
  const overlay = document.body.querySelector('.v-modal__overlay:not(.v-modal-leave-active)')
  return overlay?.querySelector('.v-confirm__text')?.textContent?.trim() ?? null
}
function dialogButton(label: string): HTMLButtonElement {
  const found = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.v-confirm__actions .v-btn'),
  ).find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`no dialog button ${label}`)
  return found
}
function audienceTab(label: string): HTMLButtonElement {
  const found = Array.from(host?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []).find(
    (el) => el.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no tab ${label}`)
  return found
}
/** The field messages on screen: a closed row keeps its last text but is hidden. */
function errors(): string[] {
  return Array.from(host?.querySelectorAll('.v-field-error--open') ?? []).map(
    (el) => el.textContent?.trim() ?? '',
  )
}

beforeEach(() => {
  toastError.mockReset()
  toastSuccess.mockReset()
  vi.mocked(adminApi.sendAnnouncement)
    .mockReset()
    .mockResolvedValue({ queued: true, audience: 'all' })
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
  document.body.innerHTML = ''
})

describe('ConsoleMailView: sending', () => {
  it('sends only after the confirmation: title, text and audience reach the API, the form clears', async () => {
    await mount()
    const typed = '  С 1 декабря ставка считается от проведённых сессий.  '
    await fill('  Новые правила начислений ', typed)
    expect(host?.querySelector('[data-testid="announcement-counter"]')?.textContent?.trim()).toBe(
      `${typed.length} из 2000`,
    )

    await press()
    // The confirmation names who receives it; nothing has been sent yet.
    expect(dialogText()).toContain('все участники')
    expect(adminApi.sendAnnouncement).not.toHaveBeenCalled()

    dialogButton('Отправить').click()
    await flush()

    expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(1)
    expect(adminApi.sendAnnouncement).toHaveBeenCalledWith({
      title: 'Новые правила начислений',
      body: 'С 1 декабря ставка считается от проведённых сессий.',
      audience: 'all',
    })
    expect(toastSuccess).toHaveBeenCalledWith('Объявление отправлено')
    expect(dialogText()).toBeNull()
    expect(field('input').value).toBe('')
    expect(field('textarea').value).toBe('')
  })

  it('the masters audience goes to the API and the confirmation names the masters', async () => {
    await mount()
    audienceTab('Мастерам').click()
    await fill()

    await press()
    expect(dialogText()).toContain('все мастера')

    dialogButton('Отправить').click()
    await flush()

    expect(adminApi.sendAnnouncement).toHaveBeenCalledWith(
      expect.objectContaining({ audience: 'masters' }),
    )
  })

  it('"do not send" closes the confirmation and keeps the form; nothing is sent', async () => {
    await mount()
    await fill()
    await press()

    dialogButton('Не отправлять').click()
    await flush()

    expect(dialogText()).toBeNull()
    expect(adminApi.sendAnnouncement).not.toHaveBeenCalled()
    expect(field('input').value).toBe('Новые правила начислений')
  })

  it('an empty title or text is refused with its message and no confirmation; filled fields go through', async () => {
    await mount()

    await press()
    expect(errors()).toEqual(['Введите заголовок', 'Введите текст'])
    expect(dialogText()).toBeNull()

    // Only blanks do not count as a title.
    await type('input', '   ')
    await type('textarea', 'Текст есть')
    await press()
    expect(errors()).toEqual(['Введите заголовок'])
    expect(dialogText()).toBeNull()

    // The message leaves when the field is edited; the valid form is accepted.
    await type('input', 'Заголовок есть')
    expect(errors()).toEqual([])
    await press()
    expect(dialogText()).not.toBeNull()
  })

  describe('against a second announcement', () => {
    it('two quick presses on the confirmation send one announcement', async () => {
      let resolveSend!: (value: { queued: boolean; audience: 'all' }) => void
      vi.mocked(adminApi.sendAnnouncement).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSend = resolve
          }),
      )
      await mount()
      await fill()
      await press()

      const confirm = dialogButton('Отправить')
      confirm.click()
      confirm.click()
      await flush()
      expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(1)

      resolveSend({ queued: true, audience: 'all' })
      await flush()
      expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(1)
      expect(toastSuccess).toHaveBeenCalledTimes(1)
    })

    it('a press while the confirmation is open or a send is in flight is dropped before the input is read', async () => {
      let resolveSend!: (value: { queued: boolean; audience: 'all' }) => void
      vi.mocked(adminApi.sendAnnouncement).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSend = resolve
          }),
      )
      await mount()
      await fill()
      await press()

      // The confirmation is open: the title is emptied and Send is pressed
      // again. Reading the input first would show i18n:console.mail.errors.titleRequired.
      await type('input', '')
      await press()
      expect(errors()).toEqual([])

      // Confirm with the title restored; then press while the send is in flight.
      await type('input', 'Заголовок')
      dialogButton('Отправить').click()
      await flush()
      await type('textarea', '')
      await press()
      expect(errors()).toEqual([])
      expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(1)

      resolveSend({ queued: true, audience: 'all' })
      await flush()
      expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(1)
    })

    it('the send can be repeated once it is over: the form is free again', async () => {
      await mount()
      await fill()
      await press()
      dialogButton('Отправить').click()
      await flush()

      await fill('Второе объявление', 'Другой текст')
      await press()
      dialogButton('Отправить').click()
      await flush()

      expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(2)
      expect(adminApi.sendAnnouncement).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: 'Второе объявление' }),
      )
    })
  })

  describe('failures', () => {
    it('a refusal keeps the form and tells the failure; the same text can be sent again', async () => {
      vi.mocked(adminApi.sendAnnouncement).mockRejectedValueOnce(
        new ApiResponseError(500, 'Сервер недоступен', 'announcement_unmapped'),
      )
      await mount()
      await fill()
      await press()
      dialogButton('Отправить').click()
      await flush()

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith('Не удалось отправить объявление')
      expect(dialogText()).toBeNull()
      expect(field('input').value).toBe('Новые правила начислений')
      expect(toastSuccess).not.toHaveBeenCalled()

      await press()
      dialogButton('Отправить').click()
      await flush()

      expect(adminApi.sendAnnouncement).toHaveBeenCalledTimes(2)
      expect(toastSuccess).toHaveBeenCalledTimes(1)
    })

    it('no answer from the server warns that the announcement may have gone out', async () => {
      vi.mocked(adminApi.sendAnnouncement).mockRejectedValueOnce(new Error('network'))
      await mount()
      await fill()
      await press()
      dialogButton('Отправить').click()
      await flush()

      expect(toastError).toHaveBeenCalledWith(
        'Ответа от сервера нет, объявление могло уйти. Не отправляйте его повторно, пока не убедитесь.',
      )
      expect(field('input').value).toBe('Новые правила начислений')
    })
  })
})

describe('ConsoleMailView: the sent ones', () => {
  it('says the history comes later: no rows, no request for them', async () => {
    await mount()

    const card = host?.querySelector('[data-testid="announcement-history"]')
    expect(card?.textContent).toContain('История появится позже')
    expect(card?.querySelector('li, [role="row"]')).toBeNull()
  })
})
