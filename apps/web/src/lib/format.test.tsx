import { describe, expect, it } from 'vitest'
import { formatExactNumber, formatNumber } from './format'

describe('formatNumber', () => {
  it('stays exact below ten thousand', () => {
    expect(formatNumber(9_999, 'zh')).toBe('9,999')
    expect(formatNumber(9_999, 'en')).toBe('9,999')
  })

  it('compacts metric magnitudes from ten thousand up', () => {
    expect(formatNumber(10_033, 'zh')).toBe('1万')
    expect(formatNumber(91_005, 'zh')).toBe('9.1万')
    expect(formatNumber(10_033, 'en')).toBe('10K')
  })
})

describe('formatExactNumber', () => {
  it('never compacts a catalog count', () => {
    expect(formatExactNumber(10_033, 'zh')).toBe('10,033')
    expect(formatExactNumber(10_033, 'en')).toBe('10,033')
    expect(formatExactNumber(999, 'zh')).toBe('999')
  })
})
