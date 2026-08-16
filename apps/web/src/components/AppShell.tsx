import { ExternalLink } from 'lucide-react'
import { Outlet } from 'react-router-dom'
import { useI18n } from '../lib/i18n'
import { KanbanGirl } from './KanbanGirl'

export function AppShell() {
  const { t } = useI18n()

  return (
    <div className="app-shell">
      <main>
        <Outlet />
      </main>

      <div className="site-bottom-link">
        <p>{t('unofficialNotice')}</p>
        <a href="https://www.deepseek.com/harness/" target="_blank" rel="noreferrer">
          {t('officialHarness')}
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>

      <KanbanGirl />
    </div>
  )
}
