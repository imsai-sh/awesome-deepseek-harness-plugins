import type { Language } from './api'

export function formatDate(value: string, language: Language): string {
  const dateOnly = value.length === 10
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    // Date-only strings have no clock time to localize; keep them in UTC so the
    // calendar date never shifts for viewers west of UTC.
    ...(dateOnly ? { timeZone: 'UTC' } : {}),
  }).format(date)
}

export function formatDateTime(value: string, language: Language): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

export function formatNumber(value: number, language: Language): string {
  return new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

/**
 * Counts of catalog items are always exact — "10,033" tells the reader
 * something "1万" cannot, and the surfaces that show them have room for the
 * digits. Metric magnitudes (stars, installs, downloads) stay on
 * formatNumber's compact notation, which suits dense rows.
 */
export function formatExactNumber(value: number, language: Language): string {
  return new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en').format(value)
}

export function formatRelativeUpdate(
  value: string,
  language: Language,
  now = Date.now(),
): string | null {
  const updatedAt = new Date(value).getTime()
  if (Number.isNaN(updatedAt)) return null

  const elapsedSeconds = Math.max(0, Math.floor((now - updatedAt) / 1000))
  const units = elapsedSeconds < 60
    ? { count: elapsedSeconds, en: 'second' }
    : elapsedSeconds < 60 * 60
      ? { count: Math.floor(elapsedSeconds / 60), en: 'minute' }
      : elapsedSeconds < 24 * 60 * 60
        ? { count: Math.floor(elapsedSeconds / (60 * 60)), en: 'hour' }
        : { count: Math.floor(elapsedSeconds / (24 * 60 * 60)), en: 'day' }

  if (language === 'zh') {
    const zhUnit = units.en === 'second'
      ? '秒'
      : units.en === 'minute'
        ? '分钟'
        : units.en === 'hour'
          ? '小时'
          : '天'
    return `${units.count} ${zhUnit}前更新`
  }

  return `Updated ${units.count} ${units.en}${units.count === 1 ? '' : 's'} ago`
}
