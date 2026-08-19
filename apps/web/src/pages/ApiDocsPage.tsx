import { ExternalLink, KeyRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { LanguageSwitch } from '../components/LanguageSwitch'
import { publicAsset } from '../lib/assets'
import { useI18n } from '../lib/i18n'
import { apiDocsNodes, collectionCopy, graph, siteNodes } from '../../worker/seo-templates'
import { usePageSeo } from '../lib/usePageSeo'

const PUBLIC_API_ORIGIN = 'https://api.deepseek1024.com'

const SEARCH_EXAMPLE = `curl "${PUBLIC_API_ORIGIN}/v1/plugins/search?q=telegram&limit=5"

curl -H "Authorization: Bearer dsh_live_your_api_key" \\
  "${PUBLIC_API_ORIGIN}/v1/plugins/search?q=telegram&sortBy=recent"`

const REGISTRY_EXAMPLE = `# First pull: the full catalog, metered.
curl -i "${PUBLIC_API_ORIGIN}/v1/registry"

# Store the ETag, then poll — 304 responses never consume quota.
ETAG=$(curl -sI "${PUBLIC_API_ORIGIN}/v1/registry" | awk '/^etag:/ { print $2 }' | tr -d '\\r')
curl -i -H "If-None-Match: $ETAG" "${PUBLIC_API_ORIGIN}/v1/registry"`

const RESPONSE_EXAMPLE = `{
  "query": "telegram",
  "page": 1,
  "limit": 20,
  "sortBy": "stars",
  "total": 1,
  "totalPages": 1,
  "results": [
    {
      "id": "ben7am1n/dsh-telegram",
      "name": "dsh-telegram",
      "owner": "ben7am1n",
      "url": "https://github.com/ben7am1n/dsh-telegram",
      "category": "integrations",
      "description": { "en": "…", "zh": "…" },
      "stars": 42,
      "installCount": 7,
      "growth24h": 3,
      "added": "2026-08-12",
      "pushedAt": "2026-08-15T09:30:00Z",
      "install": "dsh plugin --profile web add github:ben7am1n/dsh-telegram"
    }
  ]
}`

const ERROR_ROWS = [
  { code: 'INVALID_API_KEY', status: '401', meaning: 'apiDocsErrInvalidKey' },
  { code: 'MISSING_QUERY', status: '400', meaning: 'apiDocsErrMissingQuery' },
  { code: 'INVALID_CATEGORY', status: '400', meaning: 'apiDocsErrInvalidCategory' },
  { code: 'RATE_LIMITED', status: '429', meaning: 'apiDocsErrRateLimited' },
  { code: 'DAILY_QUOTA_EXCEEDED', status: '429', meaning: 'apiDocsErrDailyQuota' },
  { code: 'INTERNAL_ERROR', status: '500', meaning: 'apiDocsErrInternal' },
  { code: 'SERVICE_UNAVAILABLE', status: '503', meaning: 'apiDocsErrServiceUnavailable' },
] as const

const PARAM_ROWS = [
  { name: 'q', type: 'string', description: 'apiDocsParamQ' },
  { name: 'page', type: 'number', description: 'apiDocsParamPage' },
  { name: 'limit', type: 'number', description: 'apiDocsParamLimit' },
  { name: 'sortBy', type: 'string', description: 'apiDocsParamSortBy' },
  { name: 'category', type: 'string', description: 'apiDocsParamCategory' },
] as const

export function ApiDocsPage() {
  const { language, t } = useI18n()
  const copy = collectionCopy('apiDocs', language)

  usePageSeo({
    title: copy.title,
    description: copy.description,
    path: '/docs/api',
    language,
    schema: graph([...siteNodes(), ...apiDocsNodes(copy, language)]),
  })

  return (
    <div className="page-container api-docs-page">
      <div className="detail-utility">
        <Link className="detail-brand" to="/" aria-label="DeepSeek Harness Store homepage">
          <img className="brand-mark" src={publicAsset('deepseek1024-icon.png')} alt="" aria-hidden="true" />
          <span>DeepSeek Harness <strong>{t('market')}</strong></span>
        </Link>
        <LanguageSwitch />
      </div>

      <header className="api-docs-header">
        <h1>{t('apiDocsTitle')}</h1>
        <p>{t('apiDocsIntro')}</p>
        <p className="api-docs-base">
          {t('apiDocsBaseUrl')}: <code>{PUBLIC_API_ORIGIN}</code>
        </p>
      </header>

      <section className="api-docs-contact" aria-labelledby="api-docs-contact-heading">
        <div>
          <h2 id="api-docs-contact-heading">{t('apiDocsContactHeading')}</h2>
          <p>{t('apiDocsContactBody')}</p>
        </div>
        <a
          className="button button-secondary api-docs-contact-link"
          href="https://www.imsai.cc/"
          target="_blank"
          rel="noreferrer"
        >
          {t('apiDocsContactLink')}
          <ExternalLink size={15} aria-hidden="true" />
        </a>
      </section>

      <section className="api-docs-section">
        <h2>{t('apiDocsAuthHeading')}</h2>
        <p>{t('apiDocsAuthBody')}</p>
        <pre className="api-code"><code>{'Authorization: Bearer dsh_live_your_api_key'}</code></pre>
        <Link className="button button-primary api-docs-key-button" to="/account">
          <KeyRound size={16} aria-hidden="true" />
          {t('apiDocsGetKey')}
        </Link>
      </section>

      <section className="api-docs-section">
        <h2>{t('apiDocsRateHeading')}</h2>
        <p className="api-endpoint"><code>{t('apiDocsSearchEndpoint')}</code></p>
        <div className="api-table-scroll">
          <table className="api-table">
            <thead>
              <tr>
                <th>{t('apiDocsRatePlan')}</th>
                <th>{t('apiDocsPerDay')}</th>
                <th>{t('apiDocsPerMinute')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('apiDocsRateAnonymous')}</td>
                <td>50</td>
                <td>10</td>
              </tr>
              <tr>
                <td>{t('apiDocsRateAuthenticated')}</td>
                <td>500</td>
                <td>30</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="api-endpoint"><code>{t('apiDocsRegistryEndpoint')}</code></p>
        <div className="api-table-scroll">
          <table className="api-table">
            <thead>
              <tr>
                <th>{t('apiDocsRatePlan')}</th>
                <th>{t('apiDocsPerDay')}</th>
                <th>{t('apiDocsPerMinute')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('apiDocsRateAnonymous')}</td>
                <td>500</td>
                <td>20</td>
              </tr>
              <tr>
                <td>{t('apiDocsRateAuthenticated')}</td>
                <td>5000</td>
                <td>100</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>{t('apiDocsRateHeaders')}</p>
      </section>

      <section className="api-docs-section">
        <h2>{t('apiDocsEndpointsHeading')}</h2>

        <p className="api-endpoint"><code>{t('apiDocsRegistryEndpoint')}</code></p>
        <p>{t('apiDocsRegistryDescription')}</p>
        <h3>{t('apiDocsExampleHeading')}</h3>
        <pre className="api-code"><code>{REGISTRY_EXAMPLE}</code></pre>

        <p className="api-endpoint"><code>{t('apiDocsSearchEndpoint')}</code></p>
        <p>{t('apiDocsSearchDescription')}</p>

        <h3>{t('apiDocsParamsHeading')}</h3>
        <div className="api-table-scroll">
          <table className="api-table">
            <thead>
              <tr>
                <th>{t('apiDocsParamName')}</th>
                <th>{t('apiDocsParamType')}</th>
                <th>{t('apiDocsParamDescription')}</th>
              </tr>
            </thead>
            <tbody>
              {PARAM_ROWS.map((row) => (
                <tr key={row.name}>
                  <td><code>{row.name}</code></td>
                  <td>{row.type}</td>
                  <td>{t(row.description)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3>{t('apiDocsExampleHeading')}</h3>
        <pre className="api-code"><code>{SEARCH_EXAMPLE}</code></pre>

        <h3>{t('apiDocsResponseHeading')}</h3>
        <pre className="api-code"><code>{RESPONSE_EXAMPLE}</code></pre>
      </section>

      <section className="api-docs-section">
        <h2>{t('apiDocsErrorsHeading')}</h2>
        <div className="api-table-scroll">
          <table className="api-table">
            <thead>
              <tr>
                <th>{t('apiDocsErrorCode')}</th>
                <th>{t('apiDocsErrorStatus')}</th>
                <th>{t('apiDocsErrorMeaning')}</th>
              </tr>
            </thead>
            <tbody>
              {ERROR_ROWS.map((row) => (
                <tr key={row.code}>
                  <td><code>{row.code}</code></td>
                  <td>{row.status}</td>
                  <td>{t(row.meaning)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

    </div>
  )
}
