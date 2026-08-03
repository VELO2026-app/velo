<!--
  VELO Frontend -- DiaryFeedView (Diary redesign, screen 40)

  The diary screen. Renders the unified feed as the alternating thread
  (DiaryTimeline), with a frosted composer pinned at the bottom and a header
  ("Дневник" + "..." menu stub). Replaces the old tab-based DiaryView.

  Pagination: cursor-based infinite scroll. An IntersectionObserver sentinel
  at the bottom calls loadMoreFeed() when it scrolls into view (the project's
  other lists use a "show more" button, but the diary is a chat-like timeline
  where auto-load reads more naturally -- agreed deviation).

  Tap handling (this iteration = Variant A): editable cards (note/dream) show
  a "coming soon" toast; everything else is a no-op. The composer creates
  notes. When Variant B lands, only the tap handler here changes.
-->

<template>
  <div class="diary-feed" :class="{ 'diary-feed--composing': composing }">
    <!-- Header -->
    <header class="diary-feed__header">
      <!-- Left: exit back-pill (immersive diary has no tab bar; this returns
           to the tab-bar screens) + plain category title (no backing, per the
           approved design). The reset-filter cross appears only while a filter
           is active. -->
      <div class="diary-feed__left">
        <!-- Back контекстный (operator 2026-06-04): если активен фильтр/поиск —
             стрелка СБРАСЫВАЕТ фильтр (возврат в полную ленту), иначе выходит из
             дневника. Отдельный «x» убран. -->
        <VBackButton
          class="diary-feed__back"
          :aria-label="filterActive ? 'Сбросить фильтр' : 'Выйти из дневника'"
          @click="onBack"
        />
        <h1 class="diary-feed__title">{{ feedTitle }}</h1>
      </div>
      <VMenu>
        <!-- Trigger glyph: vertical dots that rotate to horizontal while the
             menu is open (a state cue, approved animation). The shared default
             trigger is horizontal dots; the diary overrides it here. -->
        <template #trigger="{ open }">
          <svg
            class="diary-feed__dots"
            :class="{ 'diary-feed__dots--open': open }"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </template>
        <template #default="{ close }">
          <!-- Filter (funnel) + Search (magnifier). "Связи" (Relationships)
               is an AI feature outside the MVP and is intentionally omitted. -->
          <VMenuItem
            ariaLabel="Фильтр"
            @click="
              () => {
                openFilter()
                close()
              }
            "
          >
            <svg
              class="diary-feed__menu-glyph"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M2.6837 0.00961881C2.74925 0.00947299 2.8148 0.00929349 2.88035 0.00908329C3.0601 0.00860681 3.23985 0.0086164 3.41961 0.00870843C3.61362 0.00872437 3.80764 0.00829368 4.00165 0.0079239C4.38164 0.00727632 4.76162 0.0070616 5.14161 0.0070181C5.45054 0.00698101 5.75947 0.00682064 6.06841 0.00657342C6.94461 0.00588656 7.82081 0.00552665 8.69701 0.00558515C8.76785 0.00558983 8.76785 0.00558983 8.84011 0.0055946C8.91104 0.00559938 8.91104 0.00559938 8.98339 0.00560426C9.74952 0.00563596 10.5156 0.00488964 11.2818 0.00378972C12.0687 0.00266882 12.8557 0.00213059 13.6427 0.00219796C14.0844 0.00222384 14.5261 0.00201023 14.9678 0.00117002C15.3438 0.00045917 15.7199 0.000290626 16.096 0.000819737C16.2878 0.00107413 16.4796 0.00107998 16.6714 0.000402163C16.8472 -0.000212791 17.023 -9.82255e-05 17.1988 0.000580334C17.2622 0.000699753 17.3255 0.0005596 17.3889 0.000123226C18.1142 -0.00453843 18.7455 0.206624 19.2807 0.709219C19.7222 1.14669 19.9937 1.7506 20 2.37075C19.9953 3.16685 19.8044 3.7876 19.2378 4.36068C19.0128 4.57909 18.7811 4.78419 18.5367 4.9806C18.3001 5.17181 18.0806 5.37979 17.8593 5.58833C17.7375 5.70303 17.6133 5.81432 17.4865 5.9235C17.3959 6.00211 17.3069 6.08244 17.2179 6.16285C17.0768 6.29014 16.9345 6.41589 16.7913 6.54068C16.6987 6.62198 16.6072 6.70436 16.5158 6.78688C16.3747 6.91417 16.2325 7.03992 16.0892 7.16471C15.9967 7.24601 15.9052 7.32839 15.8137 7.41091C15.6725 7.53833 15.5302 7.66423 15.3867 7.78904C15.2965 7.86838 15.2078 7.94922 15.119 8.03006C14.9889 8.14769 14.8564 8.25975 14.7192 8.36889C14.5202 8.53033 14.3314 8.70132 14.1439 8.87591C14.1159 8.90168 14.0879 8.92745 14.0591 8.954C13.8341 9.16553 13.6214 9.39192 13.5003 9.68033C13.4884 9.70783 13.4765 9.73533 13.4642 9.76366C13.3938 9.9648 13.3898 10.1606 13.3901 10.3718C13.39 10.4048 13.3899 10.4377 13.3898 10.4717C13.3895 10.5821 13.3894 10.6925 13.3894 10.8029C13.3892 10.8821 13.389 10.9613 13.3888 11.0405C13.3883 11.2111 13.388 11.3817 13.3877 11.5522C13.3873 11.8222 13.3865 12.0922 13.3857 12.3622C13.3833 13.1299 13.3811 13.8976 13.3799 14.6653C13.3791 15.0893 13.378 15.5133 13.3764 15.9373C13.3756 16.1616 13.375 16.3858 13.3749 16.61C13.3748 16.8211 13.3742 17.0323 13.3732 17.2434C13.3729 17.3206 13.3728 17.3978 13.3729 17.4751C13.374 18.2111 13.2781 18.8407 12.7459 19.3942C12.2456 19.8745 11.7351 20.0105 11.0586 19.9994C10.316 19.9715 9.75998 19.4525 9.19896 19.0196C8.99843 18.8651 8.79508 18.7148 8.59075 18.5654C8.34136 18.3826 8.09435 18.1984 7.857 17.9999C7.82768 17.9763 7.79837 17.9527 7.76817 17.9283C7.1346 17.3977 6.75426 16.6114 6.65602 15.7971C6.63822 15.5821 6.6419 15.3661 6.64173 15.1504C6.64155 15.0953 6.64135 15.0402 6.64113 14.985C6.64069 14.8668 6.64036 14.7486 6.64011 14.6304C6.63969 14.4432 6.6389 14.2559 6.63804 14.0687C6.63563 13.5365 6.63352 13.0042 6.63223 12.472C6.63151 12.1777 6.63038 11.8833 6.6288 11.589C6.62798 11.4335 6.62737 11.278 6.62728 11.1226C6.6272 10.9763 6.62657 10.83 6.62555 10.6837C6.62514 10.6049 6.6253 10.5262 6.62548 10.4475C6.62027 9.87404 6.457 9.4492 6.0482 9.04167C5.90184 8.89931 5.75105 8.76207 5.59585 8.62941C5.50312 8.54972 5.41245 8.46795 5.32176 8.38595C5.11413 8.19878 4.90486 8.01385 4.69176 7.83292C4.43508 7.61471 4.18294 7.39307 3.93637 7.16349C3.80164 7.03806 3.6651 6.91538 3.52592 6.79495C3.43455 6.71526 3.34456 6.63411 3.25457 6.55286C3.13831 6.44796 3.02162 6.34369 2.90353 6.24085C2.75161 6.10853 2.60212 5.97361 2.45255 5.83864C2.36941 5.76403 2.28571 5.69019 2.20147 5.61682C2.08338 5.51398 1.96669 5.40971 1.85044 5.3048C1.64132 5.11629 1.43122 4.92932 1.21495 4.74903C0.844046 4.43863 0.510547 4.13721 0.275664 3.70816C0.263101 3.68537 0.250538 3.66258 0.237594 3.6391C0.0532714 3.28184 -0.00387262 2.91969 0.000200931 2.52104C0.000524597 2.47995 0.000848262 2.43886 0.00118174 2.39653C0.007941 2.08492 0.0423299 1.82717 0.17328 1.54112C0.201033 1.47853 0.201033 1.47853 0.229347 1.41467C0.544551 0.770653 1.06364 0.34746 1.73342 0.0980527C2.04425 -0.0053246 2.35992 0.00893704 2.6837 0.00961881ZM1.88944 1.97014C1.73785 2.18068 1.6842 2.37283 1.69442 2.63318C1.76046 2.96335 1.98549 3.168 2.23164 3.37772C2.32484 3.45768 2.41548 3.54006 2.50618 3.62285C2.6379 3.74194 2.77218 3.85566 2.91085 3.96655C3.14743 4.15776 3.36696 4.36574 3.58823 4.57428C3.71004 4.68898 3.83427 4.80028 3.96105 4.90945C4.05167 4.98806 4.14063 5.06839 4.22966 5.1488C4.34591 5.25371 4.4626 5.35797 4.58069 5.46081C4.73261 5.59313 4.8821 5.72805 5.03167 5.86302C5.11481 5.93763 5.19852 6.01147 5.28276 6.08484C5.40084 6.18769 5.51753 6.29195 5.63379 6.39686C5.84142 6.58403 6.05068 6.76897 6.26379 6.94989C6.52147 7.16895 6.77497 7.39109 7.02184 7.62232C7.12501 7.7188 7.22918 7.81115 7.3402 7.89843C7.92877 8.40124 8.26275 9.24911 8.32504 10.0045C8.33075 10.1867 8.33065 10.3688 8.33057 10.551C8.33069 10.606 8.33083 10.6609 8.33098 10.7159C8.33129 10.8337 8.33149 10.9515 8.33162 11.0694C8.33185 11.2561 8.3325 11.4429 8.33323 11.6297C8.33348 11.6938 8.33372 11.758 8.33397 11.8221C8.33409 11.8542 8.33422 11.8863 8.33434 11.9194C8.33598 12.3538 8.33727 12.7881 8.33775 13.2225C8.33808 13.5161 8.33896 13.8097 8.34046 14.1033C8.34122 14.2584 8.34171 14.4134 8.34152 14.5684C8.34133 14.7144 8.34188 14.8604 8.34296 15.0064C8.34335 15.0847 8.34299 15.163 8.34259 15.2413C8.34804 15.777 8.47393 16.1905 8.84778 16.5753C9.14522 16.8647 9.48421 17.1056 9.81873 17.3497C9.99434 17.4781 10.1685 17.608 10.3409 17.7406C10.3775 17.7688 10.4142 17.797 10.4519 17.826C10.5228 17.8807 10.5935 17.9355 10.6641 17.9905C10.9563 18.2279 10.9563 18.2279 11.3113 18.3144C11.475 18.2638 11.5572 18.185 11.6403 18.0389C11.659 17.9216 11.6664 17.8268 11.6645 17.71C11.6647 17.6774 11.665 17.6448 11.6652 17.6113C11.6658 17.5024 11.665 17.3936 11.6642 17.2847C11.6643 17.2065 11.6646 17.1284 11.6649 17.0502C11.6654 16.8819 11.6652 16.7136 11.6646 16.5453C11.6637 16.2787 11.6641 16.0122 11.6648 15.7456C11.6657 15.2753 11.6655 14.8051 11.665 14.3348C11.6643 13.6283 11.6645 12.9218 11.6658 12.2152C11.6662 11.9508 11.6661 11.6863 11.6654 11.4218C11.6651 11.2564 11.6652 11.0911 11.6655 10.9257C11.6656 10.8496 11.6654 10.7735 11.665 10.6974C11.66 9.669 11.88 8.70741 12.6084 7.94246C12.7104 7.84286 12.8148 7.74772 12.9237 7.65573C13.0177 7.57603 13.1091 7.49366 13.2005 7.41091C13.3416 7.28361 13.4838 7.15787 13.6271 7.03308C13.7196 6.95177 13.8111 6.86939 13.9026 6.78688C14.0436 6.65958 14.1859 6.53384 14.3292 6.40905C14.4217 6.32774 14.5132 6.24536 14.6046 6.16285C14.7457 6.03555 14.8879 5.90981 15.0312 5.78502C15.1237 5.70371 15.2152 5.62133 15.3067 5.53882C15.5143 5.35164 15.7236 5.16671 15.9367 4.98578C16.1934 4.76758 16.4455 4.54593 16.6921 4.31635C16.8268 4.19092 16.9633 4.06824 17.1025 3.94781C17.1939 3.86812 17.2839 3.78698 17.3739 3.70573C17.4936 3.5978 17.6135 3.49028 17.7347 3.38396C17.7596 3.36204 17.7845 3.34012 17.8102 3.31754C17.8548 3.27948 17.9003 3.24235 17.9467 3.20663C18.1641 3.03924 18.269 2.8637 18.3075 2.59661C18.3231 2.35302 18.2537 2.18256 18.1247 1.97989C17.8986 1.75382 17.664 1.69233 17.352 1.692C17.3262 1.69192 17.3005 1.69184 17.2739 1.69176C17.1872 1.69154 17.1005 1.6916 17.0138 1.69165C16.9511 1.69155 16.8884 1.69143 16.8258 1.6913C16.6533 1.69099 16.4808 1.69092 16.3084 1.69089C16.1224 1.69082 15.9365 1.69052 15.7506 1.69026C15.344 1.68973 14.9374 1.68949 14.5307 1.68932C14.2769 1.68921 14.023 1.68905 13.7692 1.68887C13.0666 1.6884 12.3639 1.688 11.6613 1.68786C11.6163 1.68786 11.5713 1.68785 11.525 1.68784C11.4574 1.68783 11.4574 1.68783 11.3884 1.68781C11.297 1.6878 11.2056 1.68778 11.1143 1.68776C11.0463 1.68775 11.0463 1.68775 10.9769 1.68773C10.2424 1.68758 9.50794 1.6869 8.77345 1.68599C8.01959 1.68507 7.26573 1.68458 6.51187 1.68453C6.08851 1.6845 5.66516 1.68427 5.2418 1.68357C4.88133 1.68297 4.52085 1.68277 4.16038 1.68309C3.97644 1.68324 3.79251 1.6832 3.60857 1.68266C3.44015 1.68216 3.27175 1.68221 3.10333 1.68268C3.04243 1.68276 2.98154 1.68264 2.92065 1.6823C2.35722 1.67893 2.35722 1.67893 1.88944 1.97014Z"
                fill="currentColor"
              />
            </svg>
          </VMenuItem>
          <VMenuItem
            ariaLabel="Поиск"
            @click="
              () => {
                openSearch()
                close()
              }
            "
          >
            <svg
              class="diary-feed__menu-glyph diary-feed__menu-glyph--magnifier"
              viewBox="0 0 13.6562 22.999"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                d="M6.82812 0C10.5992 0 13.6562 3.05706 13.6562 6.82812C13.6562 10.2319 11.1654 13.0519 7.90723 13.5693V21.9209C7.90723 22.5162 7.42439 22.9989 6.8291 22.999C6.23367 22.999 5.75098 22.5163 5.75098 21.9209V13.5703C2.49181 13.0537 0 10.2326 0 6.82812C0 3.05706 3.05706 0 6.82812 0ZM6.82812 2C4.16163 2 2 4.16163 2 6.82812C2 9.49462 4.16163 11.6562 6.82812 11.6562C9.49462 11.6562 11.6562 9.49462 11.6562 6.82812C11.6562 4.16163 9.49462 2 6.82812 2Z"
                fill="currentColor"
              />
            </svg>
          </VMenuItem>
          <!-- View toggle (list <-> thread map). ВРЕМЕННО СКРЫТО флагом
               SHOW_VIEW_TOGGLE: thread-вид сырой, прячем кнопку (и тем самым
               вход в режим) до доработки. Код цел. Glyph + aria reflect the
               TARGET view (what tapping switches to). -->
          <VMenuItem
            v-if="SHOW_VIEW_TOGGLE"
            :ariaLabel="viewMode === 'list' ? 'Показать картой' : 'Показать списком'"
            @click="
              () => {
                toggleView()
                close()
              }
            "
          >
            <!-- Glyph reflects the TARGET view (what tapping switches to).
                 On map -> show the "list" glyph (Group 2506: three dots in a
                 column); on list -> show the "map/cards" glyph (Group 2529:
                 stacked layers). Both from the designer's icon set. -->
            <svg
              v-if="viewMode === 'map'"
              class="diary-feed__menu-glyph"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <circle cx="4.75" cy="5" r="1.5" fill="currentColor" />
              <circle cx="4.75" cy="10" r="1.5" fill="currentColor" />
              <circle cx="4.75" cy="15" r="1.5" fill="currentColor" />
              <path
                d="M8.5 5h7M8.5 10h7M8.5 15h7"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
            <svg
              v-else
              class="diary-feed__menu-glyph"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <rect
                x="3"
                y="3"
                width="14"
                height="10"
                rx="2.5"
                stroke="currentColor"
                stroke-width="1.8"
              />
              <path d="M5.5 16h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            </svg>
          </VMenuItem>
        </template>
      </VMenu>
    </header>

    <!-- Feed row: takes its own space between the header and composer rows
         (ruling 4/PROMPT №663 -- no longer an absolutely-positioned full-bleed
         layer). PROMPT №665: the write-mode scrim moved OUT to a full-viewport
         fixed layer (see .diary-feed__scrim below, now a sibling of this
         element) -- this row no longer hosts anything but its own scroll
         content, so the extra non-scrolling wrapper + inner `.diary-feed__scroll`
         split from №663 is gone; this element IS the scrolling area again.
         PROMPT №667 (ruling 5): while composing, `:style` pins this row's
         height to its own pre-composing value (see `frozenFeedHeight` in
         <script>) so the composer's growth cannot resize -- and therefore
         cannot visibly move anything behind -- the fog. Unset (undefined)
         at rest, so nothing here differs from ruling 4's behaviour then. -->
    <div
      ref="scrollEl"
      class="diary-feed__body"
      :style="
        frozenFeedHeight !== null
          ? { height: `${frozenFeedHeight}px`, flex: '0 0 auto' }
          : undefined
      "
    >
      <!-- Initial loading -->
      <div v-if="initialLoading" class="diary-feed__state">
        <VLoader size="lg" />
      </div>

      <!-- Error (only when nothing loaded yet) -->
      <VEmptyState
        v-else-if="feedError && items.length === 0"
        icon="warning"
        title="Не удалось загрузить дневник"
        description="Проверьте соединение и попробуйте ещё раз"
      >
        <template #action>
          <VButton variant="primary" @click="reload">Повторить</VButton>
        </template>
      </VEmptyState>

      <!-- Empty -->
      <VEmptyState
        v-else-if="items.length === 0"
        title="Дневник пуст"
        description="Здесь появятся ваши записи, практики, check-ins и отзывы"
      >
        <template #icon><IconDiaryBook :size="64" /></template>
      </VEmptyState>

      <!-- Thread (chat-mode: oldest at top, newest at bottom) -->
      <template v-else>
        <!-- Infinite-scroll sentinel + "loading older" indicator sit ABOVE the
             thread: history is loaded by scrolling UP. -->
        <div ref="sentinelEl" class="diary-feed__sentinel" />
        <div v-if="loadingMore" class="diary-feed__state diary-feed__state--more">
          <VLoader />
        </div>

        <!-- Wrapper pins a short feed to the bottom (margin-top:auto) so few
             entries sit next to the composer, chat-style. При активном
             фильтре/поиске прижатие отключается (--top) — результаты идут
             СВЕРХУ, а не уезжают в середину/низ (operator 2026-06-04). -->
        <div class="diary-feed__thread" :class="{ 'diary-feed__thread--top': filterActive }">
          <DiaryList v-if="viewMode === 'list'" :items="items" :timezone="timezone" @tap="onTap" />
          <DiaryTimeline v-else :items="items" :timezone="timezone" @tap="onTap" />
        </div>
      </template>
    </div>

    <!-- Undo bar: shown after deleting an entry (Figma screen 58) -->
    <div v-if="deletedEntryId" class="diary-feed__undo">
      <span class="diary-feed__undo-text">Запись удалена</span>
      <button type="button" class="diary-feed__undo-btn" :disabled="undoing" @click="onUndoDelete">
        Отменить
      </button>
    </div>

    <!-- Composer. Hidden on read-only filters (practices / checkins / feedbacks);
         entry routes to Дневник (note) or Сонник (dream) per the active filter. -->
    <div class="diary-feed__composer">
      <DiaryComposer
        v-if="writeTarget"
        :entry-type="writeTarget"
        @created="onComposerCreated"
        @composing-change="composing = $event"
      />
    </div>

    <!-- Write-mode fog -- PROMPT №665: a full-VIEWPORT layer (position:fixed,
         see its own style block below), not scoped to `.diary-feed` or the
         402px frame -- covers the whole screen edge to edge, including the
         side gutters on a device wider than the design frame (the owner's
         own "visible side edges" report, resolved as a by-product). Placed
         here in markup for readability; its own z-index (below the header/
         composer, above everything else) is what actually orders it, not DOM
         position. Compose tap-catcher: also captures taps while writing to
         block accidental feed navigation and dismiss the keyboard on an
         outside tap (unchanged mechanism, non-focusable -> native blur). -->
    <div
      class="diary-feed__scrim"
      :class="{ 'diary-feed__scrim--on': composing }"
      aria-hidden="true"
    />

    <!-- Category filter (screen 42), opened from the "..." menu -->
    <DiaryFilterModal
      :open="showFilter"
      :categories="activeCategories"
      :date-from="feedFilters.date_from"
      :date-to="feedFilters.date_to"
      :timezone="timezone"
      @apply="onApplyFilter"
      @close="showFilter = false"
    />

    <!-- Text search (screen 44), opened from the "..." menu -->
    <DiarySearchModal
      :open="showSearch"
      :initial="feedFilters.search ?? ''"
      @search="onApplySearch"
      @close="showSearch = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import { VLoader, VEmptyState, VButton, VBackButton, VMenu, VMenuItem } from '@/components/ui'
import { IconDiaryBook } from '@/components/icons'
import DiaryTimeline from '@/components/shared/DiaryTimeline.vue'
import DiaryList from '@/components/shared/DiaryList.vue'
import DiaryComposer from '@/components/shared/DiaryComposer.vue'
import DiaryFilterModal from '@/components/shared/DiaryFilterModal.vue'
import DiarySearchModal from '@/components/shared/DiarySearchModal.vue'
import { useDiaryStore } from '@/stores/diary'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { diaryWriteTarget } from '@/utils/diaryComposeTarget'
import type { DiaryFeedItem, DiaryFeedCategory } from '@/api/types'

const router = useRouter()
const route = useRoute()
const diaryStore = useDiaryStore()
const authStore = useAuthStore()
const toast = useToast()

const { feedItems, feedLoading, feedError, feedHasMore, feedFilters } = storeToRefs(diaryStore)

const items = computed<DiaryFeedItem[]>(() => feedItems.value)
const timezone = computed(() => authStore.user?.timezone ?? 'UTC')

// Loading split: first page (full-screen loader) vs subsequent pages (inline).
const initialLoading = computed(() => feedLoading.value && items.value.length === 0)
const loadingMore = computed(() => feedLoading.value && items.value.length > 0)

// -- Tap handling ------------------------------------------------------------

function onTap(payload: { item: DiaryFeedItem; editable: boolean }): void {
  // Remember the current timeline position so returning from the entry/detail
  // restores it instead of snapping back to "today" (the bottom).
  if (scrollEl.value) diaryStore.feedScrollTop = scrollEl.value.scrollTop
  const item = payload.item
  if (payload.editable) {
    // note/dream -- open the full entry screen (view/edit/delete). The card's
    // source_id is the DiaryEntry id.
    void router.push({
      name: 'user-diary-entry',
      params: { id: item.source_id },
    })
    return
  }

  // Read-only detail for check-in / feedback (source_id is the row id).
  if (item.kind === 'checkin' || item.kind === 'feedback') {
    void router.push({
      name: 'user-diary-detail',
      params: { type: item.kind, id: item.source_id },
    })
    return
  }

  // Practice outcome -> existing practice detail page (source_id is the
  // practice id, per project_practice_outcome).
  if (item.kind === 'practice_outcome') {
    void router.push({
      name: 'practice-detail',
      params: { id: item.source_id },
    })
    return
  }

  // Banner kinds (booking_confirmed/cancelled/rescheduled) are not tappable.
}

// -- "..." menu + filter / search modals (screens 42 / 43 / 44) --------------

const showFilter = ref(false)
const showSearch = ref(false)

// View mode: flat column ('list') vs thread/map ('map'), toggled from the
// "..." menu. Default 'list' — the redesign's primary, more readable view;
// 'map' is the alternating thread (DiaryTimeline). Resets per mount (no
// persistence yet — add to the store later if cross-navigation memory is wanted).
const viewMode = ref<'list' | 'map'>('list')

// ВРЕМЕННО СКРЫТО (operator 2026-06-04): компактный thread-вид ('map' /
// DiaryTimeline) выглядит сыро. Прячем переключатель в «···»-меню — без кнопки
// режим недоступен пользователю, viewMode остаётся 'list'. КОД НЕ УДАЛЁН —
// вернёмся к доработке thread-вида позже (см. .handoff дорожную карту).
const SHOW_VIEW_TOGGLE = false

async function toggleView(): Promise<void> {
  viewMode.value = viewMode.value === 'list' ? 'map' : 'list'
  // Chat-mode: both renderers order oldest->newest, so re-pin to the newest
  // (bottom) after the layout swaps to keep the user's place sensible.
  await nextTick()
  scrollToBottom()
}

// Exit the immersive diary back to the tab-bar screens (there is no tab bar
// inside the diary). Default target is the dashboard.
function exitDiary(): void {
  void router.push('/user/dashboard')
}

// Back контекстный (operator 2026-06-04): активен фильтр/поиск -> сбрасываем
// (возврат в полную ленту), иначе выходим из дневника на дашборд.
function onBack(): void {
  if (filterActive.value) {
    void clearFilter()
  } else {
    exitDiary()
  }
}

// Current categories from the store, used to seed the filter modal's draft.
const activeCategories = computed<DiaryFeedCategory[]>(() => feedFilters.value.categories ?? [])

// Compose dim state (DiaryComposer emits on focus/blur of its field).
const composing = ref(false)

// T5 -- where a new entry goes, from the active filter (pure fn, unit tested in
// utils/diaryComposeTarget.test.ts). null = a read-only filter is active, so the
// composer is hidden and the keyboard never opens.
const writeTarget = computed(() => diaryWriteTarget(activeCategories.value))

// Composer unmounts on blocked filters -- drop any lingering dim scrim.
watch(writeTarget, (target) => {
  if (!target) composing.value = false
})

function openFilter(): void {
  showFilter.value = true
}

function openSearch(): void {
  showSearch.value = true
}

async function onApplyFilter(payload: {
  categories: DiaryFeedCategory[]
  date_from?: string
  date_to?: string
}): Promise<void> {
  // setFeedFilters resets the feed to the first page with the new filter set.
  await diaryStore.setFeedFilters({
    categories: payload.categories,
    date_from: payload.date_from,
    date_to: payload.date_to,
  })
  await nextTick()
  // Результаты фильтра идут СВЕРХУ (top-align), а полная лента — чат-низ.
  if (filterActive.value) scrollToTop()
  else scrollToBottom()
}

async function onApplySearch(query: string): Promise<void> {
  // runFeedSearch trims; an empty string clears the search. Both reload the
  // feed from the first page.
  await diaryStore.runFeedSearch(query)
  await nextTick()
  if (filterActive.value) scrollToTop()
  else scrollToBottom()
}

// -- Active-filter header + reset (minimal indicator) ------------------------
//
// When a filter is active the header shows it and offers a one-tap reset
// (the cross), so the user is never confused about whether the feed is
// filtered. The title is swapped to the category name ONLY when exactly one
// category is selected (screens "Check-ins" / "Feedbacks" / "Сонник" ...);
// otherwise it stays "Дневник" but the cross still appears.

const CATEGORY_TITLE: Record<DiaryFeedCategory, string> = {
  entries: 'Дневник',
  dreams: 'Сонник',
  feedbacks: 'Feedbacks',
  checkins: 'Check-ins',
  practices: 'Практики',
}

// Any filter axis active = categories and/or date range and/or search.
const filterActive = computed(
  () =>
    activeCategories.value.length > 0 ||
    feedFilters.value.date_from !== undefined ||
    feedFilters.value.date_to !== undefined ||
    (feedFilters.value.search ?? '') !== '',
)

// Title text (approved design): the active category name alone replaces the
// title (e.g. "Check-ins" / "Сонник"). Only when exactly ONE category is
// selected; "entries" IS the root, so it stays "Дневник"; zero / multiple
// categories also stay plain "Дневник" (the reset cross still shows that a
// filter is active).
const feedTitle = computed(() => {
  const cats = activeCategories.value
  const only = cats.length === 1 ? cats[0] : undefined
  if (only !== undefined && only !== 'entries') {
    return CATEGORY_TITLE[only]
  }
  return 'Дневник'
})

async function clearFilter(): Promise<void> {
  // Full reset: categories + date range + search (clearFeedFilters reloads
  // the feed from the first page).
  await diaryStore.clearFeedFilters()
  await nextTick()
  scrollToBottom()
}

// -- Undo bar (after deleting an entry on EntryView) -------------------------
//
// EntryView soft-deletes then navigates back here with ?deleted=<entryId>.
// We surface an "Запись удалена / Отменить" bar (Figma screen 58); tapping
// Отменить restores the entry. The bar auto-dismisses after a few seconds.

const UNDO_DURATION_MS = 6000
const deletedEntryId = ref<string | null>(null)
const undoing = ref(false)
let undoTimer: ReturnType<typeof setTimeout> | null = null

function clearUndoTimer(): void {
  if (undoTimer) {
    clearTimeout(undoTimer)
    undoTimer = null
  }
}

function dismissUndo(): void {
  clearUndoTimer()
  deletedEntryId.value = null
}

// Strip the ?deleted param without adding a history entry.
function stripDeletedQuery(): void {
  if (route.query.deleted !== undefined) {
    const query = { ...route.query }
    delete query.deleted
    void router.replace({ query })
  }
}

watch(
  () => route.query.deleted,
  (val) => {
    const id = Array.isArray(val) ? val[0] : val
    if (!id) return
    deletedEntryId.value = id
    stripDeletedQuery()
    clearUndoTimer()
    undoTimer = setTimeout(dismissUndo, UNDO_DURATION_MS)
  },
  { immediate: true },
)

async function onUndoDelete(): Promise<void> {
  const id = deletedEntryId.value
  if (!id || undoing.value) return
  undoing.value = true
  const result = await diaryStore.restoreEntry(id)
  undoing.value = false
  dismissUndo()
  if (result.ok) {
    await nextTick()
    scrollToBottom()
  } else {
    toast.error(result.error)
  }
}

// -- Data load ---------------------------------------------------------------

async function reload(): Promise<void> {
  await diaryStore.refreshFeed()
}

onMounted(async () => {
  await diaryStore.fetchFeed()
  await nextTick()
  // Returning from an entry/detail: restore the saved timeline position.
  // First open (no saved offset): pin to the newest entry (bottom). Do this
  // BEFORE attaching the observer so the top sentinel (now out of view) does
  // not immediately fire and load an older page.
  if (diaryStore.feedScrollTop > 0 && scrollEl.value) {
    scrollEl.value.scrollTop = diaryStore.feedScrollTop
  } else {
    scrollToBottom()
  }
  await nextTick()
  setupObserver()
})

// -- Scroll helpers (chat-mode) ----------------------------------------------

function scrollToBottom(): void {
  // Going to the newest entry clears any saved offset (filters/search/compose
  // intentionally jump to the bottom).
  diaryStore.feedScrollTop = 0
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// Top-align: результаты фильтра/поиска показываем СВЕРХУ (с top-align враппера),
// чтобы они не уезжали в середину/низ экрана (operator 2026-06-04).
function scrollToTop(): void {
  diaryStore.feedScrollTop = 0
  const el = scrollEl.value
  if (el) el.scrollTop = 0
}

// Composer just created a note: the store refreshed the feed to the newest
// page, so jump to the bottom to reveal it.
async function onComposerCreated(): Promise<void> {
  await nextTick()
  scrollToBottom()
}

// -- Infinite scroll ---------------------------------------------------------

const scrollEl = ref<HTMLElement | null>(null)
const sentinelEl = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

// -- Ruling 5 (PROMPT №667): freeze the feed row while composing ------------
//
// Owner, ruling 5: we covered it with the fog, so it must stand still --
// nailed down until the entry is sent. Verbatim original in the spec.
// (diary-behaviour-spec.md §1). MEASURED cause: the composer grows upward by
// taking space from `.diary-feed__body`'s `flex: 1 1 auto` -- every candidate
// for the visible jump (the edge-fade mask's percentage stops riding the
// row's moving bottom edge, the fog's backdrop-filter re-sampling shifted
// content, scroll anchoring) is a CONSEQUENCE of that one box resizing.
// Freezing it removes the cause without needing to know which consequence
// the owner actually saw.
//
// WHAT IS FROZEN: `.diary-feed__body`'s own rendered height, captured via
// getBoundingClientRect() at the exact instant `composing` flips true --
// this is BEFORE the composer has grown at all (focus alone doesn't grow
// it; growth only happens on later `input` events), so the captured value
// is the row's ordinary, unremarkable at-rest height. `watch()` runs
// pre-flush (Vue's default), i.e. before this same reactive tick's DOM
// patch, so the measurement is taken against the OLD (still flex:1,
// composer still flex:0 0 auto) layout, not a half-transitioned one.
//
// FROZEN TO: that captured number, verbatim, as an explicit `height` +
// `flex: 0 0 auto` inline style -- overriding the CSS class's `flex: 1 1
// auto` so the flex algorithm cannot redistribute space into this row once
// the composer (below) leaves the flex flow. Because the captured height
// already equals what flex would have computed a moment earlier, applying
// it is a NO-OP at the instant it takes effect: same box, same pixels, only
// pinned instead of computed -- the same "AT REST byte-identical" proof
// shape this codebase already uses elsewhere (e.g. AppFrame's frozen-vh
// fallback chain).
//
// THAWS: the moment `composing` goes false (blur, outside tap, or Send via
// DiaryComposer's own post-send blur, ruling 3) -- the inline style is
// removed entirely, and `.diary-feed__body` returns to plain `flex: 1 1
// auto`, exactly its ruling-4 at-rest behaviour, unchanged by any of this.
//
// The composer itself gains `position:absolute` ONLY while composing (see
// `.diary-feed--composing .diary-feed__composer` in <style>) so its growth
// no longer competes for the frozen row's space at all -- it overlays the
// (now motionless, fogged, unread) bottom of the feed instead. Still
// anchored `bottom:0` of the SAME live-height `.diary-feed` column
// (untouched, still `--velo-vvh`-based), so ruling 5's requirement that the
// composer stays above the keyboard at every text length is unaffected --
// only WHERE it takes its space from changes, not what it's anchored to.
const frozenFeedHeight = ref<number | null>(null)

watch(composing, (isComposing) => {
  frozenFeedHeight.value = isComposing
    ? (scrollEl.value?.getBoundingClientRect().height ?? null)
    : null
})

function setupObserver(): void {
  if (observer || !sentinelEl.value) return
  observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0]
      if (entry?.isIntersecting && feedHasMore.value && !feedLoading.value) {
        void onLoadMore()
      }
    },
    { root: scrollEl.value, rootMargin: '120px' },
  )
  observer.observe(sentinelEl.value)
}

// Load an older page (triggered by scrolling UP to the top sentinel) and
// preserve the viewport: older cards are prepended at the top, so without
// compensation the content would jump. Measure height around the load and
// shift scrollTop by the delta.
async function onLoadMore(): Promise<void> {
  const el = scrollEl.value
  const prevHeight = el?.scrollHeight ?? 0
  const prevTop = el?.scrollTop ?? 0
  await diaryStore.loadMoreFeed()
  // The feed survives a failed page (the rung is initial-load-only, :172), but
  // this fires from a scroll sentinel -- there is no button left sitting there
  // to look broken, so without a toast the user just scrolls into nothing and
  // is told nothing at all.
  if (diaryStore.feedLoadMoreError) toast.error(diaryStore.feedLoadMoreError)
  await nextTick()
  if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
}

// The sentinel only exists once items render; re-attach when it appears.
watch(sentinelEl, (el) => {
  if (el && !observer) setupObserver()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  clearUndoTimer()
})
</script>

<style scoped>
/* Chat-style layout. The parent (MobileLayout main in `fill` mode) is a flex
   column that hands us its full height with no scroll of its own. We fill that
   height and split it into three rows: header, scrolling feed, composer. Only
   the feed (.diary-feed__body) scrolls -- header and composer stay put. The
   background stays continuous across all three rows (nothing opaque cuts the
   runes backdrop in the header/composer rows' own transparent gaps).
   PROMPT №663 (ruling 4 rebuild) CORRECTS this block and the one below it,
   which described the PRE-rebuild model as current fact: the three rows no
   longer overlap ("the feed flows under them" is no longer true -- see the
   `.diary-feed` comment right below for what replaced it), and the islands
   are glass ONLY on the individual pill elements, not a claim about the feed
   sliding under them any more. The scrollbar is hidden app-wide. */
/* PROMPT №663 (ruling 4 rebuild): a flex COLUMN, not an absolute-positioning
   host any more -- header / feed / composer are its three rows, in DOM
   order, none of them overlapping. Sized to the LIVE visible height
   (`--velo-vvh`, published by useViewportGeometry.ts), NOT 100% of the
   frozen ancestor (`AppFrame`'s `--velo-frozen-vh`): a normal-flow column
   sized to the FROZEN height would still put the composer at the frozen
   box's bottom while only the SHRUNKEN visible area is actually on screen --
   the same Android defect, merely restructured (this is the device-measured
   finding behind diary-behaviour-spec.md §4.1). Falls back to 100% (of the
   frozen ancestor, same as before) until the var publishes, mirroring
   AppFrame.vue's own `height: 100lvh; height: var(--velo-frozen-vh, 100lvh)`
   fallback pattern. Second-order effect this is expected to produce
   (REASONED, not yet device-confirmed): if the document is never taller than
   what's actually visible, the browser has nothing to auto-scroll into view,
   so the native pan that currently carries the header off the top edge
   should not trigger at all -- ruling 2 satisfied structurally rather than by
   a compensating rule. */
/* PROMPT №664: `--velo-vvh` is the RAW visual-viewport height -- it does NOT
   know about AppFrame's safe-area `padding-top` the way a PERCENTAGE height
   would (a percentage always resolves against the parent's content box,
   which already excludes that padding; an absolute px var does not).
   AppFrame's own content box is `--velo-vvh` (at rest) minus
   `--velo-content-safe-top` (0 in-chat, ~70px in Telegram fullscreen,
   useSafeArea.ts) -- binding straight to `--velo-vvh` reintroduced exactly
   this screen's own defect class in fullscreen: the column would be the
   FULL viewport tall while starting `--velo-content-safe-top` px down, so
   its bottom -- the composer -- would overshoot the actually-visible bottom
   by that same amount, clipped by `.mobile-layout__main--fill`'s
   `overflow:hidden`. Subtracting the var (published by AppFrame.vue
   alongside its padding) fixes it in BOTH modes: in-chat
   `--velo-content-safe-top` is 0, so `calc(vvh - 0px)` = `vvh`, BYTE-IDENTICAL
   to before this line existed (this is the mode all five of the owner's
   device screenshots were taken in, which is why the bug did not show up in
   them); fullscreen it correctly evaluates to `vvh - ~70px`, matching
   AppFrame's own reduced content box instead of overshooting it. */
.diary-feed {
  position: relative;
  height: 100%;
  height: calc(var(--velo-vvh, 100%) - var(--velo-content-safe-top, 0px));
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* -- Header: its own row, top of the column (ruling 4) --
   Transparent container; only the back-pill / title / "..." trigger are
   opaque ("keeping the glass" -- ruling 4 is about POSITION, not about
   filling this row). Aligned to the same 33px side rail as the composer row,
   so the title pill sits over the composer field's left edge and "..." over
   the send button. PROMPT №665: `position:relative` + `z-index: var(--z-sticky)`
   RESTORED -- needed again now that the write-mode fog is a full-viewport
   `position:fixed` layer (see `.diary-feed__scrim` below): without its own
   stacking order this row has no z-index of its own and a positioned,
   z-indexed sibling (the fog) would paint above it regardless of DOM order.
   `--z-sticky` (200) sits above the fog's `--z-content` (1). */
.diary-feed__header {
  position: relative;
  z-index: var(--z-sticky);
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* +20px top so the islands clear the Telegram chrome / screen edge. */
  padding: calc(var(--space-3) + 20px) var(--velo-rail-pad-x) var(--space-3);
}

/* PROMPT №663: the compensating `top: var(--velo-vv-offset)` rule that used
   to live here (added PROMPT №658) is REMOVED, not merely inert -- once the
   header is a normal-flow row instead of `position:absolute;top:0`, `top`
   does not apply to it at all, so there is no property left for a formula to
   get wrong. This is ruling 2 (the header never moves) delivered by removing
   the only rule that could ever move it, not by a smarter version of that
   rule. See the file-level `.diary-feed` comment above for the live-height
   reasoning this depends on. */

.diary-feed__title {
  font-family: var(--font-heading);
  font-size: var(--text-base);
  letter-spacing: 0.36px;
  color: var(--velo-text-primary);
}

/* Left group: exit back-pill + plain category title (no backing). PROMPT
   №663: the click-through trick (`pointer-events:none` container +
   `pointer-events:auto` on the pill) is GONE -- it existed so the feed could
   be tapped/scrolled through the header's empty gaps while the header
   floated over it. Under ruling 4 the feed no longer extends into this row
   at all, so there is nothing behind those gaps to reach any more. */
.diary-feed__left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

/* "..." trigger glyph: vertical dots that rotate to horizontal while the menu
   is open (approved animation, counter-clockwise). Soft ease-out so it glides
   to a stop rather than snapping (operator-tuned: 500ms soft ease-out). */
.diary-feed__dots {
  transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.diary-feed__dots--open {
  transform: rotate(-90deg);
}

/* Glyphs for the filter / search items inside the "..." menu (VMenu). The
   round button + popover styles now live in VMenu / VMenuItem. */
.diary-feed__menu-glyph {
  width: 18px;
  height: 18px;
}

/* The Figma magnifier path is drawn upright; rotate to the design angle. */
.diary-feed__menu-glyph--magnifier {
  width: 12px;
  height: 20px;
  transform: rotate(30deg);
}

/* -- Feed row: takes its own space between the header and composer rows
   (ruling 4/PROMPT №663), and the ONLY scrolling area. PROMPT №665: the
   write-mode scrim moved OUT to a full-viewport `position:fixed` layer (see
   `.diary-feed__scrim` below) -- the non-scrolling wrapper `№663` introduced
   PURELY to host that scrim (so it wouldn't scroll away with the cards) no
   longer has a tenant, so it is REMOVED, not kept as scaffolding: this
   element (`.diary-feed__body`, kept as the class name -- DiaryFeedView.test.ts
   scopes nearly every assertion through it) now IS the scrolling row directly,
   same as before №663 introduced the split. No `position`/`z-index` needed --
   a plain flex row, nothing paints inside it that needs to escape it any more.
   The old 4-zone mask (hard-transparent bands sized to hide cards passing
   UNDER the floating header/composer islands) stays RETIRED -- ruling 4 means
   nothing passes under them -- replaced by the ruling-4 amendment's plain,
   symmetric edge fade: appearance only, no overlap, no keyboard-derived value. */
.diary-feed__body {
  flex: 1 1 auto;
  min-height: 0;
  transition: opacity 0.28s ease;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-5) var(--velo-rail-pad-x);
  scrollbar-width: none;
  -ms-overflow-style: none;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--space-5),
    #000 calc(100% - var(--space-5)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--space-5),
    #000 calc(100% - var(--space-5)),
    transparent 100%
  );
  /* Chat-mode: a flex column so the thread wrapper can pin a short feed to the
     bottom (next to the composer). When the feed overflows, this has no effect
     and the area scrolls normally. */
  display: flex;
  flex-direction: column;
}
.diary-feed__body::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

/* Pins a short feed to the bottom; a long one scrolls normally (margin-top
   collapses once content fills the column). */
.diary-feed__thread {
  margin-top: auto;
}

/* При активном фильтре/поиске отключаем прижатие к низу — результаты идут
   сверху (иначе мало записей уезжает в середину/низ экрана). */
.diary-feed__thread--top {
  margin-top: 0;
}

.diary-feed__state {
  display: flex;
  justify-content: center;
  padding: var(--space-10) 0;
}

.diary-feed__state--more {
  padding: var(--space-5) 0;
}

.diary-feed__sentinel {
  height: 1px;
}

/* -- Undo bar (delete confirmation, Figma screen 58) --
   Floats just above the composer island in the overlay layout. */
.diary-feed__undo {
  position: absolute;
  left: var(--velo-rail-pad-x);
  right: var(--velo-rail-pad-x);
  bottom: calc(110px + env(safe-area-inset-bottom, 0px));
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  /* Deletion tone (Figma "запись удалена.svg"): pink fill + pink border +
     rose text, distinct from the neutral glass chrome. */
  background: var(--velo-glass-pink-40);
  border: 1px solid var(--velo-pink-300);
  border-radius: var(--radius-md);
  backdrop-filter: blur(15px);
  -webkit-backdrop-filter: blur(15px);
}

.diary-feed__undo-text {
  font-family: var(--font-body);
  font-size: var(--text-sm);
  color: var(--velo-pink-700);
}

.diary-feed__undo-btn {
  flex-shrink: 0;
  border: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--velo-pink-700);
  cursor: pointer;
  transition: opacity var(--transition-fast);
}

.diary-feed__undo-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.diary-feed__undo-btn:not(:disabled):hover {
  opacity: 0.8;
}

/* -- Composer: its own row, bottom of the column (ruling 4) --
   Transparent container; the field + send button are the only opaque/glass
   pixels ("keeping the glass"). The diary hides the tab bar, so the
   safe-area inset is added here to clear the home indicator. Same 33px side
   rail as the header row. PROMPT №663: no longer `position:absolute` and no
   longer click-through (same reasoning as the header -- see its own
   comment). PROMPT №665: `position:relative` + `z-index: var(--z-sticky)`
   restored for the SAME reason as the header -- must outrank the
   full-viewport fog's `--z-content`, or the fog would paint over the send
   button and the field. */
.diary-feed__composer {
  position: relative;
  z-index: var(--z-sticky);
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
  /* +20px bottom so the composer buttons clear the screen edge / Telegram chrome. */
  padding: var(--space-3) var(--velo-rail-pad-x)
    calc(var(--space-4) + 20px + env(safe-area-inset-bottom, 0px));
}

/* While writing (keyboard up) drop the composer's extra bottom offset so the
   buttons sit closer to the keyboard -- the keyboard<->buttons gap then roughly
   matches the buttons<->field gap. Unaffected by the ruling-4 restructure --
   purely cosmetic, was never part of the positioning mechanism.
   PROMPT №667 (ruling 5): ALSO takes the composer out of the flex flow while
   composing (`position:absolute`, still `bottom:0` of the SAME live-height
   `.diary-feed` column -- untouched), so its growth stops competing with
   `.diary-feed__body` for flex space at all. That row is frozen to its
   pre-composing height in the SAME instant (see `frozenFeedHeight` in
   <script>), and the two changes land together: at the moment composing
   begins the composer hasn't grown yet, so its natural height still equals
   exactly what the frozen row already reserved for it -- zero overlap at
   that instant, matching ruling 4's at-rest contract one frame longer than
   strictly required. Only actual typing-driven growth beyond that (which
   necessarily happens after the ~200ms fog fade-in has already covered the
   feed) pushes the composer's own top edge up INTO the now-frozen row's
   box -- permitted by ruling 5 ("the feed is covered and dimmed -- it is
   not being read"), never visible as bare overlap. AT REST (not composing)
   this rule does not match -- `.diary-feed__composer` stays exactly the
   `position:relative;flex:0 0 auto` row from PROMPT №663/№665, unchanged. */
.diary-feed--composing .diary-feed__composer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding-bottom: calc(var(--space-4) + 5px + env(safe-area-inset-bottom, 0px));
}

/* PROMPT №663: the `bottom: calc(--velo-frozen-vh - --velo-vvh -
   --velo-vv-offset)` rule that used to live here (T24-1, corrected №657) is
   REMOVED, not merely inert. It computed where the LIVE keyboard's top edge
   was, every animation frame, so it could shift a composer pinned to a
   FROZEN box's bottom back into the live visible area. Once the composer is
   a normal-flow row inside a column sized to the live visible height itself
   (`.diary-feed`, above), it is ALREADY at the live visible bottom -- there
   is nothing left to compute. Device measurement (diary-behaviour-spec.md
   §4.1) showed the formula never even mattered in practice: `is-keyboard-open`
   never matched on the owner's Android at all (see useViewportGeometry.ts,
   restBaselineDelta), so this rule had never once fired. */

/* -- Compose write-mode tap-catcher + fog --
   T24-2 (owner reversal, 2026-07-31) removed the frosted-glass wash here,
   read as "remove everything." PROMPT №657 (owner-ruled): that removal went
   too far -- restore the fog. The owner's own words are the spec: entering
   the diary looks normal while scrolling; the moment you start writing, the
   CONTENT is muted by fog (white + blur) while the header buttons stay
   untouched; entries stay faintly perceptible, never competing with the
   text; the field above the keyboard is written in calmly. EXACT
   pre-existing tokens (--velo-write-frost / --velo-write-blur,
   rgba(255,255,255,0.20) / 10px, operator-tuned 2026-06-05, commit
   2b28f2c7) -- already documented in variables.css as serving "scrim +
   composer field," already used unchanged on the composer field itself
   (.composer--composing .composer__field below). No new token minted.

   PROMPT №665 (owner, prod `82011b2d`): the previous scoping (`.diary-feed__body`,
   then a non-scrolling wrapper at №663) was still bounded by the 402px
   `.diary-feed` frame and stopped above/below the header/composer rows --
   the owner's ask is a layer covering the ENTIRE visible screen edge to
   edge, with only the header pill and composer field left visible on top
   (his word: unbounded, no frame at all). This is now `position:fixed;inset:0` -- a full-viewport
   layer, following the SAME shape as `#app-bg` (global.css "Photo background
   layer", index.html): a `position:fixed` box escapes into the INITIAL
   containing block (the true viewport) and is immune to any ancestor's own
   size/scroll, AS LONG AS no ancestor establishes a new containing block for
   fixed positioning (`transform`/`filter`/`backdrop-filter`/`will-change`/
   `contain`). VERIFIED BY GREP, not assumed: `AppFrame.vue`, `MobileLayout.vue`
   and `UserShell.vue` carry none of those properties (only VTabBar/
   VAdminTabBar do, and neither is an ancestor of the diary, which hides the
   tab bar) -- so this element stays a plain descendant in the Vue tree,
   rendered from THIS component (which owns the `composing` state it reads),
   rather than teleported to `<body>` like `#app-bg` or `VModal` -- simpler,
   and no less safe given the grep. Does NOT touch `#app-bg`, `#app`, `html`
   or `body` themselves (BG-ROOT stays untouched). Covering the whole
   viewport rather than the 402px frame also fogs the side gutters on a
   device wider than `--velo-screen-width` (the owner's device measured
   427 CSS px) -- resolving the "visible side edges" report as a by-product,
   not a separate fix.
   STACKING: `z-index: var(--z-content)` (1) -- above the feed content and
   `#app-bg` (z:-1), below the header/composer rows, which now carry
   `z-index: var(--z-sticky)` (200) of their own (see their comments) for
   exactly this reason. Tapping it (still non-focusable) blurs the field ->
   dismisses the keyboard, in addition to blocking accidental feed
   navigation -- unchanged. */
.diary-feed__scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-content);
  pointer-events: none;
}
.diary-feed__scrim--on {
  pointer-events: auto;
  background: var(--velo-write-frost);
  -webkit-backdrop-filter: blur(var(--velo-write-blur));
  backdrop-filter: blur(var(--velo-write-blur));
}

/* Feed content fades (70%) while writing (operator-tuned 2026-06-05, SAME
   commit as the scrim's frost values above -- 2b28f2c7 tuned both together,
   measured via `git log -S`, not assumed). COEXISTS with the scrim fog by
   design, not by default -- fade + frost together, one tuned pair, never
   either alone (spec §3's standing prohibition). PROMPT №665: retargeted back
   to `.diary-feed__body` now that the scrim is no longer nested inside it
   (it moved to a full-viewport sibling, above) -- dimming this element no
   longer risks dimming the scrim's own wash, since they are not related by
   ancestry any more. */
.diary-feed--composing .diary-feed__body {
  opacity: 0.7;
}
</style>
