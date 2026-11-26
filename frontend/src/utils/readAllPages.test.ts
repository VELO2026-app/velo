// readAllPages: an offset-paged list read to its total, stopped by an empty
// page or the cap (FE-260).
import { describe, expect, it, vi } from 'vitest'
import { ALL_PAGES_MAX, ALL_PAGES_SIZE, readAllPages } from '@/utils/readAllPages'

const row = (i: number) => ({ id: `r${i}` })

function server(rows: number, total = rows) {
  const all = Array.from({ length: rows }, (_, i) => row(i))
  return vi.fn(async (limit: number, offset: number) => ({
    items: all.slice(offset, offset + limit),
    total,
  }))
}

describe('readAllPages', () => {
  it('reads page after page to the total, in order', async () => {
    const read = server(250)

    const all = await readAllPages(read)

    expect(read.mock.calls).toEqual([
      [ALL_PAGES_SIZE, 0],
      [ALL_PAGES_SIZE, 100],
      [ALL_PAGES_SIZE, 200],
    ])
    expect(all.items).toEqual(Array.from({ length: 250 }, (_, i) => row(i)))
    expect(all).toMatchObject({ total: 250, complete: true })
  })

  it('an empty list is one request and complete', async () => {
    const read = server(0)

    expect(await readAllPages(read)).toEqual({ items: [], total: 0, complete: true })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('stops on an empty page when the total ran ahead of the rows', async () => {
    const read = server(30, 500)

    const all = await readAllPages(read)

    expect(read).toHaveBeenCalledTimes(2)
    expect(all).toMatchObject({ total: 500, complete: true })
    expect(all.items).toHaveLength(30)
  })

  it('stops at the cap and says the list is not complete', async () => {
    const read = server(ALL_PAGES_MAX * ALL_PAGES_SIZE + 5)

    const all = await readAllPages(read)

    expect(read).toHaveBeenCalledTimes(ALL_PAGES_MAX)
    expect(all.items).toHaveLength(ALL_PAGES_MAX * ALL_PAGES_SIZE)
    expect(all.complete).toBe(false)
  })

  it('a row added mid-read shifts one onto the next page: it is kept once', async () => {
    // Newest first: after the first page, a new row lands at the top, so the
    // second page (offset 100) starts with the last row of the first one.
    let rows = Array.from({ length: 150 }, (_, i) => row(i))
    const read = vi.fn(async (limit: number, offset: number) => {
      const answer = { items: rows.slice(offset, offset + limit), total: rows.length }
      if (offset === 0) rows = [row(-1), ...rows]
      return answer
    })

    const all = await readAllPages(read)

    expect(all.items.map((r) => r.id)).toEqual(Array.from({ length: 150 }, (_, i) => `r${i}`))
    expect(all).toMatchObject({ total: 151, complete: true })
  })

  it('a failed page fails the read', async () => {
    const read = vi.fn().mockRejectedValue(new Error('down'))

    await expect(readAllPages(read)).rejects.toThrow('down')
  })
})
