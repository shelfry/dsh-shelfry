import { describe, expect, it } from 'vitest'
import { en, ja, zh } from '../src/client/locales.ts'

// The ja dictionary is maintained against zh, the key-set source of truth
// (en is typed Record<MarketKey, string>, so tsc already proves en complete).
// A missing ja key silently falls back to another language in the UI, and a
// dropped placeholder silently loses the value it was meant to show — both
// are exactly the failures a reader cannot report precisely, so pin them here.
describe('ja locale dictionary', () => {
  it('covers exactly the zh key set', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps every placeholder of the zh source, in every entry', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(placeholders(ja[key]), key).toEqual(placeholders(zh[key]))
    }
  })

  it('is not a copy of either existing dictionary', () => {
    // A handful of entries legitimately coincide (proper nouns, symbols,
    // empty strings); the dictionary as a whole must actually be translated.
    const shared = Object.keys(zh).filter(k => ja[k] === zh[k] || ja[k] === en[k])
    expect(shared.length).toBeLessThan(Object.keys(zh).length / 10)
  })
})
