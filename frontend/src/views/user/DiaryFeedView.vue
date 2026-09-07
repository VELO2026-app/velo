<!--
  VELO Frontend -- DiaryFeedView (Diary redesign, screen 40)

  The diary screen. Renders the unified feed as the alternating thread
  (DiaryTimeline), with a frosted composer pinned at the bottom and floating
  glass back/"..." buttons over the feed (no title -- owner 2026-09-07).
  Replaces the old tab-based DiaryView.

  Pagination: cursor-based infinite scroll. An IntersectionObserver sentinel
  at the bottom calls loadMoreFeed() when it scrolls into view (the project's
  other lists use a "show more" button, but the diary is a chat-like timeline
  where auto-load reads more naturally -- agreed deviation).

  Tap handling (this iteration = Variant A): editable cards (note/dream) show
  a "coming soon" toast; everything else is a no-op. The composer creates
  notes. When Variant B lands, only the tap handler here changes.
-->

<template>
  <div
    ref="screenEl"
    class="diary-feed"
    :class="{
      'diary-feed--composing': composing,
      'diary-feed--searching': searchOpen || searchActive,
    }"
    :style="composerStyle"
  >
    <!-- Header: floating glass buttons OVER the feed (owner 2026-09-07): the
         штора/top fade is gone and there is no title -- entries really pass
         beneath the buttons, the same overlay model the composer uses at the
         bottom. -->
    <header class="diary-feed__header">
      <!-- Back контекстный (operator 2026-06-04): если активен фильтр/поиск —
           стрелка СБРАСЫВАЕТ фильтр (возврат в полную ленту), иначе выходит из
           дневника. Отдельный «x» убран. [FE-42] кнопка «Назад» круглая ВЕЗДЕ
           (поправка владельца) — базовый вид VBackButton; здесь белым стеклом. -->
      <VBackButton
        class="diary-feed__back"
        variant="glass"
        :aria-label="filterActive ? 'Сбросить фильтр' : 'Выйти из дневника'"
        @click="onBack"
      />
      <!-- «...» под ней: обычный DS-вид (owner 2026-09-07, раунд 2: синее
           стекло убрано); раскрывается как раньше (вниз, в Фильтр и Поиск),
           поверх контента. -->
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
                toggleSearch()
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

    <!-- Feed row: runs the FULL height -- the header buttons and the composer
         are absolute overlays it passes beneath (owner 2026-09-07 for the
         header; the composer already was one), and the ONLY scrolling area.
         PROMPT №668 (ruling 6): the
         ruling-5 freeze (`:style` pinning this row's height while composing,
         `№667`) is GONE -- ruling 6 wants exactly the opposite of what ruling
         5 required: the feed must visibly ride up as the composer grows, like
         an ordinary message list, not stand still. Plain `flex: 1 1 auto`
         (in <style>) is the whole mechanism now; nothing here reacts to
         `composing` any more except the mask/dim rules below it. -->
    <div ref="scrollEl" class="diary-feed__body" @scroll="rememberBottomState">
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
             thread: history is loaded by scrolling UP. Both hang on a
             ZERO-HEIGHT rail (.diary-feed__topzone): the loader is an
             out-of-flow overlay, so it can never push the feed down while it
             appears/disappears mid-scroll (that bounce read as jumping
             content once the 800px prefetch lead landed loads during the
             fling). -->
        <div class="diary-feed__topzone">
          <div ref="sentinelEl" class="diary-feed__sentinel" />
          <div v-if="loadingMore" class="diary-feed__state diary-feed__state--more">
            <VLoader />
          </div>
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

    <!-- Composer -- ABSOLUTE OVERLAY over the scroll container (owner spec,
         Apple Liquid Glass). The feed REALLY scrolls under the glass: its
         entries pass beneath the pill and are blurred by the pill's
         backdrop-filter -- never faked with opacity. The overlay itself is
         pinned to the screen root and NOTHING about it animates on scroll. -->
    <div ref="composerEl" class="diary-feed__composer">
      <DiaryComposer
        v-if="writeTarget"
        :entry-type="writeTarget"
        @created="onComposerCreated"
        @composing-change="composing = $event"
      />
    </div>

    <!-- Undo bar: shown after deleting an entry (Figma screen 58) -->
    <div v-if="deletedEntryId" class="diary-feed__undo">
      <span class="diary-feed__undo-text">Запись удалена</span>
      <button type="button" class="diary-feed__undo-btn" :disabled="undoing" @click="onUndoDelete">
        Отменить
      </button>
    </div>

    <!-- [FE-7] OUTSIDE-TAP BLUR, tap-only by construction: the old absolute
         tap-catcher layer (PROMPT №668) sat in the TOUCH path with
         pointer-events:auto while composing -- and iOS picks the scroll
         target from the touchstart element, so every scroll gesture that
         began on the layer was dead on arrival (device-measured: "feed does
         not scroll with the keyboard open"). The layer is GONE; the blur now
         rides a CLICK capture on the root (clicks fire after the gesture, so
         scrolling is untouched -- a scrolled finger never clicks). Header and
         composer rows are exempt so their buttons keep working; see
         onRootClickCapture. -->

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

    <!-- Search scrim (owner 2026-09-07): while the search MODE is open the
         screen dims and soft-blurs -- FIXED to the viewport, so it also
         paints dark the strips the keyboard's rounded corners expose (they
         used to flash the white body bg). Any tap on it cancels: the mode
         closes and an active query is reset (owner ruling). -->
    <button
      v-if="searchOpen"
      type="button"
      class="diary-feed__search-scrim"
      aria-label="Отменить поиск"
      @click="onSearchScrimTap"
    ></button>

    <!-- Inline search (screen 44, owner 2026-09-07 round 3): no modal -- the
         "..." menu's «Поиск» unfolds a glass field to the right of the
         magnifier, full width, floating over the feed. Stays mounted while a
         search is active: with the header title gone, this bar is the only
         visible indicator of that filter. -->
    <div v-if="searchOpen || searchActive" class="diary-feed__search">
      <DiarySearchBar
        ref="searchBarEl"
        :initial="feedFilters.search ?? ''"
        @search="onApplySearch"
        @close="closeSearch"
      />
    </div>
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
import DiarySearchBar from '@/components/shared/DiarySearchBar.vue'
import { useDiaryStore } from '@/stores/diary'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/composables/useToast'
import { platform } from '@/platform'
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

  // Conversation with a master -> the thread itself. source_id IS the comms
  // thread id (backend diary/projections.py:635 passes source_id=thread_id
  // alongside the same value in the snapshot), so no snapshot read is needed
  // and this stays identical in shape to the branches above.
  if (item.kind === 'thread_started') {
    void router.push({
      name: 'user-chat',
      params: { id: item.source_id },
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

// -- "..." menu + filter modal / inline search (screens 42 / 43 / 44) ------

const showFilter = ref(false)
const searchOpen = ref(false)
const searchBarEl = ref<InstanceType<typeof DiarySearchBar> | null>(null)

// A live search keeps the bar mounted even when its "mode" is closed -- it is
// the only visible indicator of the filter (no header title any more).
const searchActive = computed(() => (feedFilters.value.search ?? '') !== '')

// View mode: thread/map ('map') vs flat column ('list'), toggled from the
// "..." menu. Default 'map' -- the thread (DiaryTimeline + DiaryThreadCard)
// is the diary's primary renderer (thread-events redesign, 2026-09-08); the
// flat DiaryList stays wired for the day the product restores it. Resets per
// mount (no persistence yet — add to the store later if cross-navigation
// memory is wanted).
const viewMode = ref<'list' | 'map'>('map')

// Переключатель list/map остаётся СКРЫТЫМ: дневник живёт в thread-виде, и
// пока продукт явно не вернёт плоский список, кнопки входа в него нет.
// КОД НЕ УДАЛЁН — DiaryList/toggleView целы за этим флагом.
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

// Write-mode state (DiaryComposer emits on focus/blur of its field) -- drives
// the tap-catcher and the composer's own compose-time styling. No longer
// dims or fogs anything (ruling 6, PROMPT №668).
const composing = ref(false)

// T5 -- where a new entry goes, from the active filter (pure fn, unit tested in
// utils/diaryComposeTarget.test.ts). null = a read-only filter is active, so the
// composer is hidden and the keyboard never opens.
const writeTarget = computed(() => diaryWriteTarget(activeCategories.value))

// Composer unmounts on blocked filters -- drop any lingering composing state
// (the tap-catcher and the composer's own compose-time styling key off it).
watch(writeTarget, (target) => {
  if (!target) composing.value = false
})

// [FE-7] Outside-tap blur without a touch wall (replaces the retired
// tap-catcher layer; see the template comment for why the layer had to go:
// iOS picks the scroll target from the touchstart element). A CLICK is the
// browser's own "that was a tap" verdict -- it never fires for a scroll
// gesture, so intercepting here cannot break scrolling. Document-level
// CAPTURE listener (template-bound capture on the root proved brittle in the
// test harness); scoped by the event's own path: only clicks that originate
// INSIDE .diary-feed and outside the header/composer/search rows. Teleported
// modals (filter, in body) are outside .diary-feed and stay untouched.
function onDocClickCapture(e: MouseEvent): void {
  if (!composing.value) return
  const target = e.target as HTMLElement | null
  if (!target?.closest('.diary-feed')) return
  if (target.closest('.diary-feed__header, .diary-feed__composer, .diary-feed__search')) return
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  e.stopPropagation()
  e.preventDefault()
}

onMounted(() => {
  document.addEventListener('click', onDocClickCapture, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClickCapture, true)
  // [TG-SURFACE] never strand a dark native Telegram backdrop after leaving
  // the screen mid-search.
  platform.setKeyboardSurface(false)
  // [owner pass] keep-bottom teardown, same lifecycle as the rest.
  feedResizeObserver?.disconnect()
  feedResizeObserver = null
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
})

function openFilter(): void {
  showFilter.value = true
}

// «Поиск» toggles the inline bar (owner 2026-09-07): unfold in place + focus.
function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) nextTick(() => searchBarEl.value?.focus())
}

function closeSearch(): void {
  searchOpen.value = false
}

// A tap on the scrim = cancel (owner 2026-09-07): close the mode AND reset
// an active search. With the query gone the bar unmounts, so the focused
// input goes with it and the keyboard closes by itself.
async function onSearchScrimTap(): Promise<void> {
  searchOpen.value = false
  if (searchActive.value) await diaryStore.runFeedSearch('')
}

// [TG-SURFACE] While the dark search scrim is up, Telegram's NATIVE
// under-webview surface goes dark too: the keyboard's rounded top corners
// expose it, and it lies OUTSIDE the WebView -- no in-page layer can paint
// there (device-confirmed 2026-09-07). Restored on close and on unmount
// (a route change mid-search must not strand a dark native backdrop).
watch(searchOpen, (open) => {
  platform.setKeyboardSurface(open)
})

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
  // A submit ends the search MODE -- the dim lifts and the results read
  // crisp. The bar itself stays while the query is live (searchActive keeps
  // it mounted -- the filter's only visible indicator).
  searchOpen.value = false
}

// -- Active-filter state ------------------------------------------------------
//
// No header title any more (owner 2026-09-07: only the floating buttons).
// The filtered state is carried by the feed content plus the back button's
// contextual aria-label/behaviour below.

// Any filter axis active = categories and/or date range and/or search.
const filterActive = computed(
  () =>
    activeCategories.value.length > 0 ||
    feedFilters.value.date_from !== undefined ||
    feedFilters.value.date_to !== undefined ||
    (feedFilters.value.search ?? '') !== '',
)

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
    rememberBottomState()
  } else {
    scrollToBottom()
  }
  await nextTick()
  setupObserver()
  // [owner pass] keep-bottom, attached once the initial position has settled
  // (its own first fire re-pins -- a no-op right after scrollToBottom, and a
  // correct re-pin when a restored offset happens to be near the bottom).
  attachKeepBottom()
  // [owner pass] live composer clearance: measure the pill's idle geometry
  // once, then keep it live through every growth/keyboard shift.
  attachComposerResize()
  refreshComposerClearance()
})

// -- Scroll helpers (chat-mode) ----------------------------------------------

function scrollToBottom(): void {
  // Going to the newest entry clears any saved offset (filters/search/compose
  // intentionally jump to the bottom).
  diaryStore.feedScrollTop = 0
  const el = scrollEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// -- Keep-bottom on geometry shifts (owner pass) -----------------------------
// The screen is sized to the LIVE viewport, so the feed's height changes with
// the keyboard: on a shrink the visible window loses its bottom edge and the
// LAST entry slides under the fold -- "saw it without the keyboard, must see
// it with the keyboard". The decision CANNOT read the post-shift geometry
// (the shrink alone exceeds any threshold), so the bottom-state is remembered
// from the reader's own scroll events and the resize consults the PRE-shift
// state: pinned -> re-pin, instant scrollTop only (never smooth -- a smooth
// scroll mid-keyboard-animation is a visible double jump); reading history
// -> untouched. Attached after the initial position settles (see onMounted).
const KEEP_BOTTOM_NEAR_PX = 160

let pinnedToBottom = true

function rememberBottomState(): void {
  const el = scrollEl.value
  if (!el) return
  pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= KEEP_BOTTOM_NEAR_PX
}

let feedResizeObserver: ResizeObserver | null = null

function attachKeepBottom(): void {
  if (feedResizeObserver || !scrollEl.value) return
  feedResizeObserver = new ResizeObserver(() => {
    // Geometry shifted (keyboard rides the root's height): re-measure the
    // composer clearance -- the pill is anchored to the root's bottom edge,
    // so its top moves with every height change of the screen itself -- and
    // re-pin a pinned reader.
    refreshComposerClearance()
    if (pinnedToBottom) scrollToBottom()
  })
  feedResizeObserver.observe(scrollEl.value)
}

// -- Composer clearance (owner fix, 2026-09-08) --------------------------------
// The pill is an ABSOLUTE overlay: its autogrow used to just expand upward
// OVER the feed and bury the newest entries under the glass -- the content
// above never moved. The feed's bottom padding is therefore LIVE: it is the
// measured distance from the screen's bottom edge to the pill's TOP (+8px
// breathing), recomputed whenever the pill resizes (autogrow, draft prefill,
// the composing offset) or the screen geometry shifts (keyboard). A reader
// pinned to the bottom is re-pinned on growth, so the newest entry rides up
// above the pill like an ordinary chat; an unpinned reader keeps their place
// (the padding grows BELOW the content, nothing they see moves).
const composerEl = ref<HTMLElement | null>(null)
const composerClearance = ref<number | null>(null)

const composerStyle = computed<{ '--diary-composer-clearance'?: string }>(() =>
  composerClearance.value !== null
    ? { '--diary-composer-clearance': `${composerClearance.value}px` }
    : {},
)

function refreshComposerClearance(): void {
  const rootRect = screenEl.value?.getBoundingClientRect()
  const pillRect = composerEl.value?.getBoundingClientRect()
  if (!rootRect || !pillRect) return
  const needed = rootRect.bottom - pillRect.top + 8
  if (needed > 0) composerClearance.value = needed
}

let composerResizeObserver: ResizeObserver | null = null

function attachComposerResize(): void {
  if (composerResizeObserver || !composerEl.value) return
  composerResizeObserver = new ResizeObserver(() => {
    const before = composerClearance.value
    refreshComposerClearance()
    if (
      before !== null &&
      composerClearance.value !== null &&
      composerClearance.value > before &&
      pinnedToBottom
    ) {
      void nextTick().then(scrollToBottom)
    }
  })
  composerResizeObserver.observe(composerEl.value)
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
// The screen root -- the coordinate frame the composer clearance is measured
// against (see refreshComposerClearance).
const screenEl = ref<HTMLElement | null>(null)
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
    {
      root: scrollEl.value,
      // Prefetch lead (owner: the scroll must be seamless). The sentinel is
      // the FIRST element, reached while scrolling UP, so only the TOP margin
      // matters: ~two screens (1500px) of lead means the older page is in
      // flight long before the reader reaches the seam -- combined with the
      // 40-event pages (stores/diary.ts) the thread effectively never runs
      // out mid-scroll. hasMore/loading below guard the lead to one page
      // ahead.
      rootMargin: '1500px 0px 0px 0px',
    },
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
   column that hands us its full height with no scroll of its own. Only the
   feed (.diary-feed__body) scrolls; the header buttons and the composer are
   absolute overlays the feed really passes beneath (owner 2026-09-07, which
   supersedes ruling 4's no-overlap-at-rest for the header; the composer was
   already an overlay). The background stays continuous behind all of it
   (nothing opaque cuts the runes backdrop). The scrollbar is hidden app-wide. */
/* PROMPT №663 (ruling 4 rebuild): a flex COLUMN, not an absolute-positioning
   host any more -- header / feed / composer are its three rows, in DOM
   order, none of them overlapping. While the keyboard is OPEN it is sized
   to the LIVE visible height (`--velo-vvh`, published by
   useViewportGeometry.ts), NOT 100% of the frozen ancestor (`AppFrame`'s
   `--velo-frozen-vh`): a normal-flow column
   sized to the FROZEN height would still put the composer at the frozen
   box's bottom while only the SHRUNKEN visible area is actually on screen --
   the same Android defect, merely restructured (this is the device-measured
   finding behind diary-behaviour-spec.md §4.1). [FE-44] corrects the REST
   state: the live-height binding now applies ONLY under
   `html.is-keyboard-open` (see the gated rule below) -- at rest the column
   is a plain 100% of the frozen ancestor, immune to a STALE `--velo-vvh`
   left over from a keyboard close whose resize event was missed (that
   staleness capped the whole screen at the keyboard-open height: mandala
   top, body-white bottom, the owner's screenshot). */
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
  /* The floating overlays' shared rail: the composer input's visible left
     edge (16px, owner's Apple Liquid Glass spec) -- and since 2026-09-08 the
     header button column's too: the owner aligns back/"..." to the INPUT's
     left edge, not the feed's 24px content rail. One source for both. */
  --diary-overlay-rail: 16px;
  height: 100%;
  /* Same value as the 100% above (AppFrame's content box = frozen-vh minus
     its safe-area padding), but as an INTERPOLABLE px calc: the FE-44 close
     transition animates between this and the keyboard-open height, and
     px<->percentage pairs don't interpolate. The 100% line above stays as
     the pre-JS-paint fallback. */
  height: calc(var(--velo-frozen-vh, 100%) - var(--velo-content-safe-top, 0px));
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* [FE-44] The live-height cap ONLY while the keyboard is open -- the class
   IS the keyboard state. When it drops (resize-driven publish, resetState on
   navigation, or the focusout recheck useViewportGeometry now runs), full
   height returns even if no closing resize event ever fires. No masking
   white blocks anywhere -- the background layer regains the full viewport
   on the same class removal. */
:global(html.is-keyboard-open) .diary-feed {
  height: calc(var(--velo-vvh, 100%) - var(--velo-content-safe-top, 0px));
}

/* [FE-44] The close expands at the keyboard's own speed (see the twin rule
   in global.css): while the closing class holds, the height transition
   interpolates from the capped value above to the at-rest px calc below. */
:global(html.is-keyboard-closing) .diary-feed {
  height: calc(var(--velo-frozen-vh, 100%) - var(--velo-content-safe-top, 0px));
  transition: height 250ms cubic-bezier(0.22, 0.61, 0.36, 1);
}

/* -- Header: floating glass overlay over the feed (owner 2026-09-07) --
   Supersedes ruling 4 for the header: NOT a normal-flow row any more. The
   column's left edge is aligned to the INPUT's visible left edge -- the
   composer pill's 16px rail, shared via --diary-overlay-rail (owner,
   2026-09-08; a flush x=0 and the feed's 24px content rail were both
   tried and rejected the same day) -- «Назад» (white glass, VBackButton's
   glass variant) above the "..." trigger in its usual solid DS look, which
   expands downward into Фильтр/Поиск exactly as before -- and the feed
   scrolls beneath both; the buttons frost what passes under them (the same
   overlay model the composer uses at the bottom). No title. The
   `z-index: var(--z-sticky)` survives for the PROMPT №665 reason: the
   tap-catcher is gone, but positioned/z-indexed overlays must not
   intercept taps meant for the buttons; `--z-sticky` (200) keeps them
   on top. */
.diary-feed__header {
  position: absolute;
  top: var(--velo-fog-headerless-top);
  left: var(--diary-overlay-rail);
  z-index: var(--z-sticky);
  display: flex;
  flex-direction: column;
  /* One vertical axis through both CENTRES (the buttons differ in width,
     44 vs 40): flex-start would sit the narrower "..." flush left, its
     centre 2px off the back button's. */
  align-items: center;
  gap: var(--space-3);
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

/* -- Feed row: the ONLY scrolling area, running the FULL height -- the header
   buttons (owner 2026-09-07) and the composer are absolute overlays the
   entries really pass beneath. PROMPT №668 (ruling 6): NOT dimmed in any
   state; the blur-on-outside-click (onRootClickCapture) is the non-visual
   click-blocker that replaced the fog. No `position`/`z-index` on this
   element itself -- a plain flex row. NO edge fade any more: the штора (the
   ruling-4 amendment's top fade, last survivor of the old 4-zone mask) is
   removed by the same owner ruling -- with the header floating OVER the feed
   the fade had nothing to transition into; content ends CRISP top and bottom
   alike (the bottom fade was already gone; the keyboard-time strip below the
   app is handled separately, global.css #app-bg cap). Kept as
   `.diary-feed__body` throughout every rebuild this cycle --
   DiaryFeedView.test.ts scopes nearly every assertion through it. */
.diary-feed__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* Only OUR compensation (onLoadMore) may move the offset on content
     growth: on engines where native scroll anchoring is on, the browser
     would adjust for the prepended history TOO and double the shift. */
  overflow-anchor: none;
  /* [FE-7] never chain this scroller's overscroll to the root -- the iOS
     gesture-pan the whole FE-7 fix exists to undo. */
  overscroll-behavior-y: contain;
  /* Top: just the shared headerless token. The corner buttons (back + menu)
     own the top-LEFT; the thread's first date node is CENTERED and ~170px
     wide, so it clears the ~68px button column horizontally and needs no
     full-height header clearance at rest -- the old ~150px clearance read
     as a big empty gap above the thread's first entry (owner removed it).
     Entries still pass UNDER the buttons while scrolling (overlay model);
     the searching state keeps its own taller clearance below the inline
     search row (see .diary-feed--searching below); the bottom pad is the
     LIVE composer clearance -- --diary-composer-clearance, measured from
     the pill's own top edge (100px fallback until first measure) -- so the
     pill's autogrow pushes the content up instead of burying it. */
  padding: var(--velo-fog-headerless-top) var(--velo-rail-pad-x)
    var(--diary-composer-clearance, 100px);
  scrollbar-width: none;
  -ms-overflow-style: none;
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

/* While the inline search row is up (open mode or a live query), the results
   must start BELOW the bar -- its own top stack + height (.diary-feed__search)
   -- not hide behind it. */
.diary-feed--searching .diary-feed__body {
  padding-top: calc(
    var(--velo-fog-headerless-top) + var(--velo-size-44) + var(--space-3) + var(--velo-size-40) +
      var(--space-2) + var(--velo-size-50) + var(--space-5)
  );
}

/* -- Search scrim: the modal-scrim token + a SOFT blur (owner 2026-09-07:
   "экран затемняется и чуть блюрится"). FIXED to the viewport (the #app-bg
   trick) and sized inset:0, so it paints dark EVERYTHING the web can see --
   including the strips the keyboard's rounded corners expose during the
   open/close animation, which used to flash body's white (FE-43/B29 defect
   class, glaring once the feed behind went dark). z-index --z-sticky (200):
   ABOVE the feed, composer and the header buttons -- while the search mode
   is up, any tap outside the bar cancels (onSearchScrimTap); the bar itself
   sits one step higher (.diary-feed__search below). Renders only in the
   search MODE; a submitted query keeps the feed crisp. */
.diary-feed__search-scrim {
  position: fixed;
  inset: 0;
  z-index: var(--z-sticky);
  border: none;
  padding: 0;
  background: var(--velo-scrim);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  cursor: default;
}

/* -- Inline search bar (owner 2026-09-07, round 3): the "..." menu's «Поиск»
   unfolds, in place, into [magnifier][glass field -> right rail] floating
   over the feed -- the field replaces the retired modal. Same overlay
   contract as the composer: absolute, static glass, the feed scrolls
   beneath. The left edge continues the header column's rail; vertically it
   sits where the expanded menu's search item was (below back 44 + gap +
   "..." 40 + the panel's own gap). One step ABOVE the scrim: the bar (field,
   go, x, recents) is the only tappable surface while the search mode is
   up. */
.diary-feed__search {
  position: absolute;
  left: var(--velo-rail-pad-x);
  right: var(--velo-rail-pad-x);
  top: calc(
    var(--velo-fog-headerless-top) + var(--velo-size-44) + var(--space-3) + var(--velo-size-40) +
      var(--space-2)
  );
  z-index: calc(var(--z-sticky) + 1);
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

/* Zero-height rail the top sentinel and the loading-older overlay hang on.
   It exists so the loader can be position:absolute WITHOUT giving the body
   (which deliberately stays a plain flex row, PROMPT №668) a positioning
   context of its own. */
.diary-feed__topzone {
  position: relative;
  height: 0;
}

.diary-feed__state--more {
  /* Out of the flow ON PURPOSE: an in-flow loader added/removed ~70px of
     height above the thread at fetch start/end -- with the prefetch lead
     (1500px) that happens mid-scroll and the feed visibly jumped down and
     back. Absolute keeps the spinner at the content top (where the seam is)
     with zero layout impact. */
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
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
   restored for the SAME reason as the header, and still needed after `№668`
   -- must outrank the tap-catcher's `--z-content`, or it would intercept
   taps meant for the send button and the field. */
.diary-feed__composer {
  /* [owner spec, Apple Liquid Glass] The overlay: absolute over the scroll
     container, 16px rails, 12px off the bottom, above the feed. The glass
     pill itself (see Composer.vue) does the frost -- this wrapper is pure
     positioning, transparent, and NOTHING here (bottom/blur/transform/
     opacity) ever animates: the glass is static, only the content moves
     under it. */
  position: absolute;
  left: var(--diary-overlay-rail);
  right: var(--diary-overlay-rail);
  /* Owner pass: 12px sat TOO tight against the screen edge -- restored the
     pre-spec clearance (16 + 20 + safe-area), where the pill rode before. */
  bottom: calc(var(--space-4) + 20px + env(safe-area-inset-bottom, 0px));
  z-index: 20;
}

/* [owner pass] Keyboard state: while typing the pill drops ~20px closer to
   the keyboard (36 -> 16 + safe-area) -- the rest clearance is screen-edge
   padding, the composing one is a hair over the keys. Two stable states,
   NO transition on bottom (the static-glass rule: nothing animates while
   content scrolls; the state flips once with the keyboard). */
.diary-feed--composing .diary-feed__composer {
  bottom: calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
}

/* While writing (keyboard up) drop the composer's extra bottom offset so the
   buttons sit closer to the keyboard -- the keyboard<->buttons gap then roughly
   matches the buttons<->field gap. Unaffected by the ruling-4 restructure --
   purely cosmetic, was never part of the positioning mechanism.
   PROMPT №668 (ruling 6): the composer's compose-time `position:absolute`
   (added `№667` so its growth wouldn't disturb the ruling-5 freeze) is
   REMOVED -- ruling 6 killed the freeze it existed to serve (see the note at
   `.diary-feed__body` above), so the composer is back to being what ruling 4
   already made it: an ordinary `flex: 0 0 auto` row, at every text length,
   composing or not. Its growth now DOES compete with `.diary-feed__body` for
   the column's flex space again -- deliberately: that competition IS how
   "the feed rides up as the composer grows" (ruling 6, requirement 2)
   happens, with zero new code. */
/* [owner spec] The composing padding-bottom override is RETIRED with the
   flex row itself: the composer is an absolute overlay now (16/16/12), and
   with the keyboard open the whole shrunk screen carries it -- no padding
   to adjust. */

/* -- [FE-7] Tap-catcher: RETIRED. The absolute layer sat in the touch path
   with pointer-events:auto while composing -- iOS resolves the scroll target
   from the touchstart element, so every scroll gesture over the layer died
   (the "feed does not scroll with the keyboard open" device bug). The
   outside-tap blur now rides a CLICK capture on the root
   (onRootClickCapture): clicks fire after the gesture, so scrolling is
   untouched. The whole №665/№668 history is preserved in git. */
</style>
