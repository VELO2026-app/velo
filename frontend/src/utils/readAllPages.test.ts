// readAllPages: an offset-paged list read to its total, stopped by an empty
// page or the cap (FE-260).
import { describe, expect, it, vi } from 'vitest'
import { ALL_PAGES_MAX, ALL_PAGES_SIZE, readAllPages } from '@/utils/readAllPages'

function server(rows: number, total = rows) {
  const all = Array.from({ length: rows }, (_, i) => i)
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
    expect(all.items).toEqual(Array.from({ length: 250 }, (_, i) => i))
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

  it('a failed page fails the read', async () => {
    const read = vi.fn().mockRejectedValue(new Error('down'))

    await expect(readAllPages(read)).rejects.toThrow('down')
  })
})
