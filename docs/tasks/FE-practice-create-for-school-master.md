# FE: включить создание практики для мастера школы

**Стопер:** задача бэкенда «BE: создание практики для другого мастера
(`master_id` на POST /practices)» — см. `docs/tasks/BE-practice-create-for-school-master.md`.
Пока она не смержена, создавать практики можно только от себя.

## Что уже сделано (заглушка, в стенде)

- Обе точки входа передают контекст:
  - страница мастера → `master-practice-new` c `?masterId=`;
  - страница школы → `master-practice-new` c `?groupId=`.
- `CreatePracticeView` читает query, тянет имя мастера (`getPublicMaster`)
  или мастеров школы (`getCuratorGroupMembers(kind=master)`, видимые,
  сам вызывающий исключён — он уже есть как «Я») и рисует секцию «Мастер».
- Заглушка честная: при выборе чужого мастера — `Banner`-предупреждение и
  **disabled сабмит** (иначе практика молча создалась бы от имени куратора).
  «Я» и заход без контекста работают как раньше.

## Что сделать после бэка

1. Регенерировать `frontend/src/api/generated.ts`
   (`backend/scripts/generate_ts_types.py` — поле `master_id` появится в
   `CreatePracticeRequest`).
2. `CreatePracticeView.vue`:
   - снять `:disabled="targetsForeignMaster"` с кнопки сабмита и
     `v-if="targetsForeignMaster"` с `Banner`;
   - в теле сабмита (рядом с `currency: 'eur'`) отправлять
     `master_id: delegatedMaster?.id ?? (selectedMasterId || undefined)`.
3. Тесты `CreatePracticeView.test.ts`, describe
   «§1.6 delegation: the master context (stub)»: заменить ожидания
   «warns and blocks» на «ships its id» (`sentBody().master_id`),
   добавить проверку 403-пути (мок createPractice кидает запрещёнку →
   тост с ошибкой, форма не падает).
4. Проверить в TG: карточка мастера → «Создать практику» → секция
   «Мастер» с именем; страница школы → пикер мастеров школы; создание
   для мастера реально принадлежит ему (см. список практик школы).
