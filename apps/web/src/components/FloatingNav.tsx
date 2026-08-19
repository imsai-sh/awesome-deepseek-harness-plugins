import { Code, Home, MessagesSquare } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useI18n } from '../lib/i18n'

/**
 * The site's cross-section navigation, floating clear of the page.
 *
 * The catalog and the rankings are two views of one page and keep their own
 * in-page tabs; what had no home was everything *beside* that page — the
 * community and the API reference. Rather than restructure the layout around a
 * rail, this hovers next to it, so the home page keeps the shape it had.
 *
 * `end` on the home entry matters: without it `/` prefix-matches every route and
 * all three items read as active at once.
 */
const DESTINATIONS = [
  { to: '/', end: true, icon: Home, label: 'navHome' },
  { to: '/community', end: false, icon: MessagesSquare, label: 'community' },
  { to: '/docs/api', end: false, icon: Code, label: 'navApi' },
] as const

// An embedded build can set VITE_HIDE_COMMUNITY=true to drop the community
// entry when it ships the catalog as a standalone mobile shell with no room for
// the discussion section. Unset (the default) keeps every destination.
const HIDE_COMMUNITY = import.meta.env.VITE_HIDE_COMMUNITY === 'true'

export function FloatingNav() {
  const { t } = useI18n()

  const destinations = DESTINATIONS.filter(({ to }) => !(HIDE_COMMUNITY && to === '/community'))

  return (
    <nav className="floating-nav" aria-label={t('siteActions')}>
      {destinations.map(({ to, end, icon: Icon, label }) => (
        <NavLink key={to} to={to} end={end} className="floating-nav-item">
          <Icon size={16} aria-hidden="true" />
          <span>{t(label)}</span>
        </NavLink>
      ))}
    </nav>
  )
}
