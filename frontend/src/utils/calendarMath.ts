import { DateTime } from 'luxon'

// =============================================================================
// VELO Frontend -- Calendar math (wall-date arithmetic, no timezones)
// =============================================================================
//
// Чистая календарная математика для month-grid'ов: длины месяцев, сдвиги,
// дни недели. Работает с (year, month 1..12, day) и НЕ создаёт Date —
// поэтому таймзона не участвует вовсе (правило no-restricted-syntax).
// =============================================================================

/** Длина месяца (month 1..12). */
export function daysInMonth(year: number, month: number): number {
  return DateTime.fromObject({ year, month }, { zone: 'utc' }).daysInMonth!
}

/** День недели 1-го числа: 0 = понедельник .. 6 = воскресенье (сетка Monday-first). */
export function firstWeekdayMonFirst(year: number, month: number): number {
  const weekday = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' }).weekday // 1=Пн..7=Вс
  return weekday - 1
}

/** (year, month), сдвинутый на delta месяцев; год нормализуется через границу. */
export function shiftMonthParts(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const shifted = DateTime.fromObject({ year, month, day: 1 }, { zone: 'utc' }).plus({
    months: delta,
  })
  return { year: shifted.year, month: shifted.month }
}

/** YYYY-MM-DD календарного дня (ключ сетки; wall-дата, без зоны). */
export function dayKeyOf(year: number, month: number, day: number): string {
  return DateTime.fromObject({ year, month, day }, { zone: 'utc' }).toFormat('yyyy-MM-dd')
}

/** YYYY-MM-DD для Date в локальной зоне (эквивалент en-CA-форматирования). */
export function dayKeyOfDate(d: Date): string {
  return DateTime.fromJSDate(d).toFormat('yyyy-MM-dd')
}

/** 1-е число месяца, в котором лежит `d` (локальная полночь этого числа). */
export function firstOfMonth(d: Date): Date {
  return DateTime.fromJSDate(d).startOf('month').toJSDate()
}

/** `d`, сдвинутый на delta месяцев и нормализованный к 1-му числу месяца. */
export function shiftMonthDate(d: Date, delta: number): Date {
  return DateTime.fromJSDate(d).plus({ months: delta }).startOf('month').toJSDate()
}
