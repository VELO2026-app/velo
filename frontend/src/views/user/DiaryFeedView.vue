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
        <!-- PROMPT №655: the debug-panel gesture target. Had no click behaviour
             before this (plain click-through label, see .diary-feed__title's
             pointer-events below) -- nothing existing is overridden. -->
        <h1 class="diary-feed__title" @click="onTitleTap">{{ feedTitle }}</h1>
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

    <!-- Feed body: the ONLY scrolling area, between fixed header and composer -->
    <div ref="scrollEl" class="diary-feed__body">
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

    <!-- Compose tap-catcher: invisible (T24-2 removed the frost/dim), but
         still captures taps while writing to block accidental feed navigation
         and dismiss the keyboard on an outside tap. -->
    <div
      class="diary-feed__scrim"
      :class="{ 'diary-feed__scrim--on': composing }"
      aria-hidden="true"
    />

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

    <!-- TEMPORARY -- PROMPT №654/655 (T24-1/B29 device diagnostic). Gated by a
         hidden gesture (5 taps on the title within 2s, see onTitleTap),
         persisted in localStorage -- default OFF, no role/link/setting.
         Read-only, plain position:fixed. Remove in the follow-up commit named
         in this one's body. -->
    <DiaryKeyboardDebugPanel v-if="debugPanelOn" />
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
import DiaryKeyboardDebugPanel from '@/components/shared/DiaryKeyboardDebugPanel.vue'
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

// -- TEMPORARY debug-panel gesture (PROMPT №655/656, T24-1/B29 device
// diagnostic) -- 3 taps on the title within TAP_WINDOW_MS toggles
// DiaryKeyboardDebugPanel. No role/link/setting -- persisted in localStorage
// so it survives opening the composer, the keyboard, and a reload. Default
// OFF; a user who never performs the gesture sees exactly what they see
// today. Remove alongside the panel itself (see the follow-up commit named
// in №654's body).
//
// №656: the 5-tap/2000ms version shipped in №655 produced NOTHING observable
// on the owner's device -- taps that land or don't were indistinguishable
// from each other because nothing confirmed a tap was even registering.
// Loosened (5 -> 3 taps, 2000 -> 3000ms) and given a toast on every counted
// tap plus a clear on/off toast at trigger, so a failed attempt is now
// visibly different from a working one: silence means the tap genuinely
// isn't reaching the element (a pointer-events/hit-region problem to chase
// next), a toast that stops advancing mid-count means the WINDOW is still
// too tight, not that nothing is happening at all.
const DEBUG_PANEL_STORAGE_KEY = 'velo:diary-kbd-debug'
const TAP_WINDOW_MS = 3000
const TAPS_TO_TOGGLE = 3
const debugPanelOn = ref(localStorage.getItem(DEBUG_PANEL_STORAGE_KEY) === '1')
let debugTapTimes: number[] = []

function onTitleTap(): void {
  const now = Date.now()
  debugTapTimes = debugTapTimes.filter((t) => now - t < TAP_WINDOW_MS)
  debugTapTimes.push(now)
  if (debugTapTimes.length < TAPS_TO_TOGGLE) {
    toast.info(`${debugTapTimes.length}/${TAPS_TO_TOGGLE}`)
    return
  }
  debugTapTimes = []
  debugPanelOn.value = !debugPanelOn.value
  localStorage.setItem(DEBUG_PANEL_STORAGE_KEY, debugPanelOn.value ? '1' : '0')
  toast.success(debugPanelOn.value ? 'Диагностика: ВКЛ' : 'Диагностика: ВЫКЛ')
}

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
   height and split it into three rows: fixed header, scrolling feed, fixed
   composer. Only the feed (.diary-feed__body) scrolls -- header and composer
   stay put, so the composer is always pinned just above the tab bar on both
   short and long feeds. The background stays continuous across all three rows
   (overlay look preserved: nothing opaque cuts the runes backdrop). */
/* Immersive overlay layout (G-1 glass islands). The feed scrolls edge-to-edge
   under floating glass islands: NO opaque bars. The header (title pill + "...")
   and the composer are transparent containers whose only solid pixels are the
   glass islands themselves; the feed flows under them, blurred only where an
   island sits on top. The scrollbar is hidden app-wide. */
.diary-feed {
  position: relative;
  height: 100%;
  min-height: 0;
}

/* -- Header: transparent overlay, islands only (top row) --
   Aligned to the same 33px side rail as the composer row, so the title pill
   sits over the composer field's left edge and "..." over the send button. */
.diary-feed__header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* +20px top so the islands clear the Telegram chrome / screen edge. */
  padding: calc(var(--space-3) + 20px) var(--velo-rail-pad-x) var(--space-3);
  /* Container is click-through; only the islands inside catch taps. */
  pointer-events: none;
}
.diary-feed__header > * {
  pointer-events: auto;
}

.diary-feed__title {
  font-family: var(--font-heading);
  font-size: var(--text-base);
  letter-spacing: 0.36px;
  color: var(--velo-text-primary);
  /* PROMPT №655/656: re-enable taps for the debug-panel gesture (onTitleTap)
     -- the title had no prior interactive behaviour, it was plain
     click-through text like the rest of .diary-feed__left (see that rule's
     own comment). The feed still scrolls under it exactly as before, this
     only stops taps landing ON the title's box from falling through to the
     feed underneath. */
  pointer-events: auto;
  /* №656: the word alone (its glyph box) was too small a target on a phone --
     padding + equal negative margin enlarges the tappable area without
     moving the visible text or the surrounding flex layout (10px < the 14px
     --space-3 gap to the back button, so the two hit areas never touch). */
  padding: 10px;
  margin: -10px;
}

/* Left island group: exit back-pill + plain category title (no backing). The
   group itself is click-through so the feed scrolls under the title text; only
   the back-pill and reset cross re-enable taps. */
.diary-feed__left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  pointer-events: none;
}

/* The shared VBackButton sits inside the click-through left group, so re-enable
   taps on it (the rest of the group stays click-through). */
.diary-feed__back {
  pointer-events: auto;
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

/* -- Body: the ONLY scrolling area, edge-to-edge UNDER the islands --
   Fills the whole frame; top/bottom padding (40 / 80, G-1 spec) keeps the first
   and last card reachable from under the header / composer islands. Scrollbar
   hidden (app-wide rule). */
.diary-feed__body {
  position: absolute;
  inset: 0;
  /* Own stacking context (z 0) so feed cards never paint above the compose
     scrim (which sits at z 1, just below the chrome islands). */
  z-index: 0;
  transition: opacity 0.28s ease;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 120px var(--velo-rail-pad-x) 140px;
  scrollbar-width: none;
  -ms-overflow-style: none;
  /* 4-zone fog (operator spec 50 / 70 / 70 / 70 -- +10 per zone after the
     islands were nudged +20 off the edges), top -> bottom:
       50  hard transparent (behind the title island)
       70  fade  -- the feed emerges from full transparency
       ..  fully visible content
       70  fade  -- dissolves as it slides under the composer
       70  hard transparent (behind the composer island)
     Top padding 120 = 50+70, bottom padding 140 = 70+70. */
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent 50px,
    #000 120px,
    #000 calc(100% - 140px),
    transparent calc(100% - 70px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    transparent 50px,
    #000 120px,
    #000 calc(100% - 140px),
    transparent calc(100% - 70px),
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

/* -- Composer: transparent overlay container, the pill is the only island --
   Floats over the edge-to-edge feed (no opaque bar). The diary hides the tab
   bar, so the safe-area inset is added here to clear the home indicator.
   pointer-events: the container is click-through; the composer pill catches
   taps. Same 33px side rail as the header islands. */
.diary-feed__composer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-sticky);
  display: flex;
  justify-content: center;
  /* +20px bottom so the composer buttons clear the screen edge / Telegram chrome. */
  padding: var(--space-3) var(--velo-rail-pad-x)
    calc(var(--space-4) + 20px + env(safe-area-inset-bottom, 0px));
  pointer-events: none;
}
.diary-feed__composer > * {
  pointer-events: auto;
}

/* While writing (keyboard up) drop the composer's extra bottom offset so the
   buttons sit closer to the keyboard -- the keyboard<->buttons gap then roughly
   matches the buttons<->field gap. */
.diary-feed--composing .diary-feed__composer {
  padding-bottom: calc(var(--space-4) + 5px + env(safe-area-inset-bottom, 0px));
}

/* T24-1: reposition the composer above the LIVE keyboard, not the frozen
   box's own bottom edge. `.diary-feed__composer` is bottom:0 of `.diary-feed`
   (position:relative), whose own height inherits the frozen `--velo-frozen-vh`
   box (global.css BG-FREEZE) all the way down -- immune by construction to any
   live viewport signal. That's correct at rest, but on a platform where the
   keyboard actually shrinks the visible surface (not just overlays it), the
   frozen box now overflows the real screen and bottom:0 lands beyond what's
   visible. `--velo-vvh` (live) and `html.is-keyboard-open` are the signal
   useBackgroundStabilizer already publishes for exactly this; global.css
   explicitly excludes fill-mode screens (this one) from the shared
   `.velo-kbd-scroll` mechanism because they "own their keyboard handling
   directly" -- this is the diary doing that. `frozen - vvh` is the shrink
   amount; shifting `bottom` up by it re-anchors the composer to the live
   bottom edge instead of the frozen one. AT REST (no is-keyboard-open) this
   selector never matches -> layout is byte-identical to before. Does NOT
   touch #app/html/body (BG-ROOT stays untouched) -- scoped to this one
   diary-owned element only. */
html.is-keyboard-open .diary-feed--composing .diary-feed__composer {
  bottom: calc(var(--velo-frozen-vh, 100%) - var(--velo-vvh, 100%));
}

/* -- Compose write-mode tap-catcher --
   T24-2 (owner reversal, 2026-07-31, supersedes the 2026-07-29 ruling): the
   feed must stay VISIBLE while writing -- the frosted-glass wash + blur over
   the feed is REMOVED. What stays: this element's TAP-CATCHING role, which is
   independent of how it looks. position:absolute (was fixed, bg-freeze batch)
   so it covers `.diary-feed` edge-to-edge WITHOUT tracking the visual viewport
   (`.diary-feed` is position:relative, so inset:0 resolves against that stable
   box). While writing it is fully transparent but still captures taps: blocks
   accidental feed navigation, and tapping it (a non-focusable element) blurs
   the field -> dismisses the keyboard (in addition to the explicit ⌄ button).
   z 1 keeps it above the feed but BELOW the sticky header/composer islands. */
.diary-feed__scrim {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}
.diary-feed__scrim--on {
  /* Capture taps while writing (see comment above) -- purely functional now,
     nothing to fade in visually. */
  pointer-events: auto;
}

/* Feed content fades (70%) while writing, so it reads as background behind the
   composer field (operator-tuned 2026-06-05). Independent of the T24-2 frost
   removal above -- the owner did not name this fade, so it is kept as-is. */
.diary-feed--composing .diary-feed__body {
  opacity: 0.7;
}
</style>
