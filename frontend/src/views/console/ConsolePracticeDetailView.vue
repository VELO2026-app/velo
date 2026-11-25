<!--
  VELO Frontend -- ConsolePracticeDetailView (FE-262, slice 3)

  One practice in the web console (route console-practices-detail): the
  figures of its booking (booked, attended, no-show, or booked and free for a
  practice still ahead), a tab with the participants and their booking status,
  a tab with the Zoom attendance, and the practice's own data on the right.

  Data: `GET /admin/practices/{id}` (practice + the roster of live bookings,
  cancelled ones are not in it) and, once the Zoom tab is opened,
  `GET /admin/practices/{id}/zoom-attendance` (per-booking minutes and the
  rows Zoom could not match to a participant). Both are Colada queries
  (composables/queries/admin.ts). The API has no late-cancellation mark, no
  price, no format and no reviews: the screen shows what the answers carry.
-->

<template>
  <ConsolePage
    :title="practice?.title ?? t('console.modules.practices')"
    :crumbs="t('console.groups.content')"
    testid="console-practice-detail"
  >
    <template v-if="practice" #title-extra>
      <ConsoleBadge :tone="isPast ? 'muted' : 'info'" data-testid="practice-state">{{
        isPast
          ? t('console.practices.detail.state.past')
          : t('console.practices.detail.state.upcoming')
      }}</ConsoleBadge>
    </template>
    <template #actions>
      <VButton variant="outline" size="sm" data-testid="practice-back" @click="backToList">{{
        t('console.practices.detail.back')
      }}</VButton>
    </template>
    <template v-if="practice" #tabs>
      <VSegment
        v-model="tab"
        compact
        :options="tabOptions"
        :aria-label="t('console.practices.detail.tabsLabel')"
      />
    </template>

    <ConsoleLoading v-if="loading" data-testid="practice-loading" />
    <VEmptyState
      v-else-if="notFound"
      icon="warning"
      :title="t('console.practices.detail.notFound')"
      data-testid="practice-not-found"
    />
    <VEmptyState
      v-else-if="failed"
      icon="warning"
      :title="t('console.practices.detail.loadFailed')"
      :description="errorText"
    >
      <VButton size="sm" variant="outline" @click="retry">{{ t('common.retry') }}</VButton>
    </VEmptyState>

    <div v-else-if="practice" class="practice-detail">
      <div class="practice-detail__main">
        <div class="practice-detail__stats">
          <ConsoleStat
            :label="t('console.practices.detail.stats.booked')"
            :value="practice.booked"
          />
          <template v-if="isPast">
            <ConsoleStat
              :label="t('console.practices.detail.stats.attended')"
              :value="practice.attended"
              tone="good"
            />
            <ConsoleStat
              :label="t('console.practices.detail.stats.noShow')"
              :value="noShowCount"
              tone="bad"
            />
          </template>
          <ConsoleStat
            v-else
            :label="t('console.practices.detail.stats.free')"
            :value="freeSeats"
          />
        </div>

        <ConsoleCard
          v-if="tab === 'participants'"
          :title="t('console.practices.detail.participants.title')"
          flush
        >
          <ConsoleTable
            :columns="rosterColumns"
            :rows="roster"
            row-key="user_id"
            :label="t('console.practices.detail.participants.label')"
          >
            <template #cell-name="{ row }">
              <VAvatar
                class="practice-detail__avatar"
                :name="row.name"
                :url="row.avatar_url ?? undefined"
                size="sm"
              />
              <span class="practice-detail__name">{{ row.name }}</span>
            </template>
            <template #cell-status="{ row }">
              <BookingStatusBadge :status="row.status" />
            </template>
            <template #empty>{{ t('console.practices.detail.participants.empty') }}</template>
          </ConsoleTable>
        </ConsoleCard>

        <template v-else>
          <!-- No answer and no failure yet: the loader, also in the tick before the request starts. -->
          <ConsoleLoading v-if="!zoom && !zoomFailed" data-testid="zoom-loading" />
          <ConsoleCard v-else-if="zoomFailed" :title="t('console.practices.detail.zoom.title')">
            <VEmptyState icon="warning" :title="t('console.practices.detail.zoom.loadFailed')">
              <VButton size="sm" variant="outline" @click="retryZoom">{{
                t('common.retry')
              }}</VButton>
            </VEmptyState>
          </ConsoleCard>
          <template v-else-if="zoom">
            <ConsoleCard :title="t('console.practices.detail.zoom.title')">
              <dl class="practice-detail__facts">
                <div class="practice-detail__fact">
                  <dt>{{ t('console.practices.detail.zoom.meetingStatus') }}</dt>
                  <dd>
                    <ConsoleBadge :tone="meetingStatus.tone" data-testid="zoom-meeting-status">{{
                      meetingStatus.label
                    }}</ConsoleBadge>
                  </dd>
                </div>
                <div class="practice-detail__fact">
                  <dt>{{ t('console.practices.detail.zoom.report') }}</dt>
                  <dd>
                    <ConsoleBadge :tone="zoom.report_ingested ? 'success' : 'muted'">{{
                      zoom.report_ingested
                        ? t('console.practices.detail.zoom.reportReady')
                        : t('console.practices.detail.zoom.reportWaiting')
                    }}</ConsoleBadge>
                  </dd>
                </div>
                <div class="practice-detail__fact">
                  <dt>{{ t('console.practices.detail.zoom.unmatched') }}</dt>
                  <dd>
                    <ConsoleBadge
                      :tone="zoom.unmatched_count > 0 ? 'warning' : 'muted'"
                      data-testid="zoom-unmatched-count"
                      >{{ zoom.unmatched_count }}</ConsoleBadge
                    >
                  </dd>
                </div>
                <!-- ZoomMeeting.last_sync_error: raw text the backend recorded, English. -->
                <div v-if="zoom.last_sync_error" class="practice-detail__fact">
                  <dt>{{ t('console.practices.detail.zoom.lastError') }}</dt>
                  <dd class="practice-detail__error" data-testid="zoom-last-error">
                    {{ zoom.last_sync_error }}
                  </dd>
                </div>
              </dl>
            </ConsoleCard>

            <ConsoleCard :title="t('console.practices.detail.zoom.bookingsTitle')" flush>
              <ConsoleTable
                :columns="zoomColumns"
                :rows="zoomBookings"
                row-key="booking_id"
                :label="t('console.practices.detail.zoom.bookingsLabel')"
              >
                <template #cell-status="{ row }">
                  <BookingStatusBadge :status="row.status" />
                </template>
                <template #cell-zoom_minutes_present="{ row }">
                  {{ row.zoom_minutes_present === null ? '—' : minutes(row.zoom_minutes_present) }}
                </template>
                <template #cell-attendance_decided_via="{ row }">
                  {{ decidedViaLabel(row.attendance_decided_via) }}
                </template>
                <template #empty>{{ t('console.practices.detail.zoom.bookingsEmpty') }}</template>
              </ConsoleTable>
            </ConsoleCard>

            <ConsoleCard
              v-if="unmatched.length > 0"
              :title="t('console.practices.detail.zoom.unmatchedTitle')"
              flush
            >
              <ConsoleTable
                :columns="unmatchedColumns"
                :rows="unmatched"
                row-key="segment_id"
                :label="t('console.practices.detail.zoom.unmatchedLabel')"
              >
                <template #cell-user_email="{ row }">
                  {{ row.user_email ?? t('console.practices.detail.zoom.unknownEmail') }}
                </template>
                <template #cell-join_time="{ row }">{{ whenOrDash(row.join_time) }}</template>
                <template #cell-leave_time="{ row }">{{ whenOrDash(row.leave_time) }}</template>
                <template #cell-duration_seconds="{ row }">
                  {{
                    row.duration_seconds === null
                      ? '—'
                      : minutes(Math.round(row.duration_seconds / 60))
                  }}
                </template>
              </ConsoleTable>
            </ConsoleCard>
          </template>
        </template>
      </div>

      <aside class="practice-detail__side">
        <ConsoleCard :title="t('console.practices.detail.about.title')">
          <dl class="practice-detail__facts">
            <div class="practice-detail__fact">
              <dt>{{ t('console.practices.detail.about.when') }}</dt>
              <dd data-testid="about-when">
                {{ formatWhen(practice.scheduled_at, practice.timezone) }}
              </dd>
            </div>
            <div class="practice-detail__fact">
              <dt>{{ t('console.practices.detail.about.duration') }}</dt>
              <dd>{{ minutes(practice.duration_minutes) }}</dd>
            </div>
            <div class="practice-detail__fact">
              <dt>{{ t('console.practices.detail.about.master') }}</dt>
              <dd>{{ practice.master_name }}</dd>
            </div>
            <div v-if="practice.direction" class="practice-detail__fact">
              <dt>{{ t('console.practices.detail.about.direction') }}</dt>
              <dd>{{ directionLabel(practice.direction) }}</dd>
            </div>
            <div class="practice-detail__fact">
              <dt>{{ t('console.practices.detail.about.seats') }}</dt>
              <dd>{{ practice.capacity ?? '∞' }}</dd>
            </div>
          </dl>
        </ConsoleCard>
      </aside>
    </div>
  </ConsolePage>
</template>

<script setup lang="ts">
import { t } from '@/locales'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@pinia/colada'
import { routeParam } from '@/router/routeParam'
import { isOptionEnabled } from '@/platform/instance'
import { VAvatar, VButton, VEmptyState, VSegment } from '@/components/ui'
import type { SegmentOption } from '@/components/ui'
import ConsoleCard from '@/components/console/ConsoleCard.vue'
import ConsolePage from '@/components/console/ConsolePage.vue'
import ConsoleTable, { type ConsoleTableColumn } from '@/components/console/ConsoleTable.vue'
import BookingStatusBadge from '@/components/console/content/BookingStatusBadge.vue'
import ConsoleBadge from '@/components/console/ConsoleBadge.vue'
import ConsoleLoading from '@/components/console/ConsoleLoading.vue'
import ConsoleStat from '@/components/console/content/ConsoleStat.vue'
import { ApiResponseError } from '@/api/client'
import { useConsoleWidth } from '@/composables/useConsoleWidth'
import {
  adminPracticeAttendanceQuery,
  adminPracticeQuery,
  onFailedRequest,
} from '@/composables/queries/admin'
import { screenQueryState } from '@/composables/queries/screenState'
import { extractApiError } from '@/composables/useApiError'
import { useToast } from '@/composables/useToast'
import { formatWhen } from '@/utils/console/date'
import { CONSOLE_BASE } from '@/utils/console/modules'
import { labelOrRaw } from '@/utils/console/labelOrRaw'
import type { ConsoleTone } from '@/utils/console/tone'
import { formatCount } from '@/utils/format'
import { directionLabel } from '@/utils/methodTaxonomy'
import { ZOOM_MEETING_TONES, isZoomMeetingStatus } from '@/utils/zoomMeetingStatus'

/** The practices list, with or without its query: where a way back may lead. */
const LIST_PATH = new RegExp(`^${CONSOLE_BASE}/practices(\\?|$)`)

const route = useRoute()
const router = useRouter()
const toast = useToast()
const practiceId = routeParam(route, 'id')

type Tab = 'participants' | 'zoom'
const tab = ref<Tab>('participants')

const practiceQuery = useQuery(() => adminPracticeQuery(practiceId))
const practice = computed(() => practiceQuery.data.value ?? null)
const { loading, failed } = screenQueryState(practiceQuery)
const errorText = computed(() => extractApiError(practiceQuery.error.value, t('common.loadError')))
// A 404 is "not found"; any other failure is a load error with Retry. Only a
// first load that failed shows either: a refetch over a practice shown keeps it.
const notFound = computed(
  () =>
    failed.value &&
    practiceQuery.error.value instanceof ApiResponseError &&
    practiceQuery.error.value.status === 404,
)

// The Zoom answer is loaded when its tab is opened and stays cached after.
const attendanceQuery = useQuery(() => ({
  ...adminPracticeAttendanceQuery(practiceId),
  enabled: tab.value === 'zoom',
}))
const zoom = computed(() => attendanceQuery.data.value ?? null)
const { failed: zoomFailed } = screenQueryState(attendanceQuery)

onFailedRequest(practiceQuery, (e) => {
  if (practiceQuery.data.value !== undefined)
    toast.error(extractApiError(e, t('console.practices.detail.loadFailed')))
})

// A failed refetch over Zoom data shown (a return to the app) is told too.
onFailedRequest(attendanceQuery, (e) => {
  if (attendanceQuery.data.value !== undefined)
    toast.error(extractApiError(e, t('console.practices.detail.zoom.loadFailed')))
})

function retry(): void {
  void practiceQuery.refetch()
}
function retryZoom(): void {
  void attendanceQuery.refetch()
}

/** A number of minutes with the shared unit word. */
function minutes(n: number): string {
  return `${n} ${t('common.duration.min')}`
}

const isPast = computed(() => practice.value?.status === 'past')

// Spread: ConsoleTable rows are plain records, the API items are interfaces.
const roster = computed(() => (practice.value?.roster ?? []).map((entry) => ({ ...entry })))
const noShowCount = computed(() => roster.value.filter((r) => r.status === 'no_show').length)
const freeSeats = computed<string | number>(() => {
  const p = practice.value
  return p?.capacity == null ? '∞' : Math.max(0, p.capacity - p.booked)
})

const tabOptions = computed<SegmentOption[]>(() => [
  {
    value: 'participants',
    label: `${t('console.practices.detail.tabs.participants')} · ${formatCount(roster.value.length)}`,
  },
  // The Zoom attendance is the zoom option's: without it there is no tab.
  ...(isOptionEnabled('zoom')
    ? [{ value: 'zoom', label: t('console.practices.detail.tabs.zoom') }]
    : []),
])

const rosterColumns = computed<ConsoleTableColumn[]>(() => [
  { key: 'name', label: t('console.practices.detail.participants.name') },
  { key: 'status', label: t('console.practices.detail.participants.status'), width: 180 },
])

// null: no ZoomMeeting row was ever made for the practice (backend router docstring).
const meetingStatus = computed<{ label: string; tone: ConsoleTone }>(() => {
  const status = zoom.value?.zoom_meeting_status
  if (status == null)
    return { label: t('console.practices.detail.zoom.status.none'), tone: 'muted' }
  return {
    label: labelOrRaw(status, isZoomMeetingStatus, (known) =>
      t(`console.practices.detail.zoom.status.${known}`),
    ),
    tone: isZoomMeetingStatus(status) ? ZOOM_MEETING_TONES[status] : 'muted',
  }
})

const zoomBookings = computed(() => (zoom.value?.bookings ?? []).map((b) => ({ ...b })))
const unmatched = computed(() => (zoom.value?.unmatched ?? []).map((u) => ({ ...u })))

// Under 1400 px the main column is too narrow for every Zoom column: the
// mechanism that decided a booking, and the leave time of a stray row, go.
const { medium } = useConsoleWidth()

const zoomColumns = computed<ConsoleTableColumn[]>(() => [
  { key: 'user_name', label: t('console.practices.detail.zoom.columns.name') },
  { key: 'status', label: t('console.practices.detail.zoom.columns.status'), width: 150 },
  {
    key: 'zoom_minutes_present',
    label: t('console.practices.detail.zoom.columns.minutes'),
    width: 130,
  },
  ...(medium.value
    ? []
    : [
        {
          key: 'attendance_decided_via',
          label: t('console.practices.detail.zoom.columns.via'),
          width: 200,
        },
      ]),
])

const unmatchedColumns = computed<ConsoleTableColumn[]>(() => [
  { key: 'user_email', label: t('console.practices.detail.zoom.unmatchedColumns.email') },
  {
    key: 'join_time',
    label: t('console.practices.detail.zoom.unmatchedColumns.joined'),
    width: 180,
  },
  ...(medium.value
    ? []
    : [
        {
          key: 'leave_time',
          label: t('console.practices.detail.zoom.unmatchedColumns.left'),
          width: 180,
        },
      ]),
  {
    key: 'duration_seconds',
    label: t('console.practices.detail.zoom.unmatchedColumns.duration'),
    width: 100,
  },
])

type DecidedVia = 'zoom_report' | 'legacy_proxy'

function isDecidedVia(via: string): via is DecidedVia {
  return via === 'zoom_report' || via === 'legacy_proxy'
}

// Null: nothing decided the booking yet; an unknown mechanism is shown as it came.
function decidedViaLabel(via: string | null): string {
  if (via === null) return '—'
  return labelOrRaw(via, isDecidedVia, (known) => t(`console.practices.detail.zoom.via.${known}`))
}

function whenOrDash(iso: string | null): string {
  return iso === null ? '—' : formatWhen(iso, practice.value?.timezone ?? 'UTC')
}

// Back to the list the admin came from, with its tab and page; after a deep
// link (no list before this screen) to the tab the practice belongs to.
function backToList(): void {
  const from = router.options.history.state.back
  if (typeof from === 'string' && LIST_PATH.test(from)) {
    router.back()
    return
  }
  void router.push({
    name: 'console-practices',
    query: { scope: isPast.value ? 'past' : 'upcoming' },
  })
}
</script>

<style scoped>
.practice-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--space-4);
  align-items: start;
}

.practice-detail__main {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.practice-detail__side {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.practice-detail__stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

/* Below 1200 px (CONSOLE_NARROW_MAX, utils/console/layout.ts) the menu is
   folded: the practice data goes under the main column. */
@media (max-width: 1199px) {
  .practice-detail {
    grid-template-columns: minmax(0, 1fr);
  }
}

.practice-detail__avatar :deep(.v-avatar__initials) {
  color: var(--velo-text-primary);
}

.practice-detail__name {
  overflow-wrap: anywhere;
}

.practice-detail__facts {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.practice-detail__fact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: var(--velo-size-40);
  border-bottom: 1px solid var(--velo-border-light);
  font-size: var(--velo-fs-14);
}

.practice-detail__fact:last-child {
  border-bottom: 0;
}

.practice-detail__fact dt {
  color: var(--velo-text-secondary);
}

.practice-detail__fact dd {
  margin: 0;
  text-align: right;
  color: var(--velo-text-primary);
  overflow-wrap: anywhere;
}

.practice-detail__error {
  color: var(--velo-error-text);
}
</style>
