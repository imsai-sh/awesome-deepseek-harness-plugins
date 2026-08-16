import { chromium } from 'playwright'

const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const desktopContext = await browser.newContext({ locale: 'zh-CN' })
const mobileContext = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
  permissions: ['clipboard-read', 'clipboard-write'],
})
const errors = []

async function openPage(viewport, path, { touch = false } = {}) {
  const context = touch ? mobileContext : desktopContext
  const page = await context.newPage()
  await page.setViewportSize(viewport)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`${page.url()}: ${message.text()}`)
    }
  })
  await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' })
  return page
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  )
  if (overflow) throw new Error(`${label} has horizontal overflow`)
}

async function assertMobileEnvironment(page, label) {
  const result = await page.evaluate(() => ({
    maxTouchPoints: navigator.maxTouchPoints,
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
  }))
  if (result.maxTouchPoints < 1) throw new Error(`${label} is not running with touch input`)
  if (!result.viewport.includes('width=device-width')) {
    throw new Error(`${label} is missing a device-width viewport declaration`)
  }
}

async function assertMinTouchTargets(page, label, selectors) {
  const undersized = await page.locator(selectors.join(', ')).evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = getComputedStyle(node)
        const box = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0
      })
      .map((node) => {
        // A stretched link wraps short text but takes its hit area from an
        // absolutely positioned ::after covering the whole card, so measuring
        // the anchor's own box would understate the real touch target.
        const overlay = getComputedStyle(node, '::after')
        const stretched = overlay.position === 'absolute' &&
          overlay.inset === '0px' &&
          node.offsetParent !== null
        const box = (stretched ? node.offsetParent : node).getBoundingClientRect()
        return {
          height: Math.round(box.height),
          label: node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 40) ?? node.tagName,
          width: Math.round(box.width),
        }
      })
      .filter(({ height, width }) => height < 44 || width < 44),
  )
  if (undersized.length > 0) {
    throw new Error(`${label} has touch targets smaller than 44px: ${JSON.stringify(undersized)}`)
  }
}

async function assertMinFontSize(page, label, selector, minimum) {
  const size = await page.locator(selector).first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
  if (size < minimum) throw new Error(`${label} uses ${size}px text; expected at least ${minimum}px`)
}

async function assertHorizontalTouchScroller(page, label, selector, { requireOverflow = true } = {}) {
  const result = await page.locator(selector).evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    touchAction: getComputedStyle(node).touchAction,
  }))
  if (result.scrollWidth <= result.clientWidth) {
    if (requireOverflow) {
      throw new Error(`${label} does not expose its overflowing controls through a local scroller`)
    }
    // Content fits without scrolling; nothing to pan.
    return
  }
  if (!result.touchAction.includes('pan-x')) {
    throw new Error(`${label} is missing horizontal touch panning`)
  }
}

async function assertSeo(page, label, canonicalPath, robots = 'index,follow') {
  const result = await page.evaluate(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
    h1Count: document.querySelectorAll('h1').length,
    h2Count: document.querySelectorAll('h2').length,
    shellLeftBehind: document.querySelectorAll('[data-seo-shell]').length,
    shellGuarded: (() => {
      const probe = document.createElement('div')
      probe.className = 'seo-shell'
      document.body.append(probe)
      const hidden = getComputedStyle(probe).display === 'none'
      probe.remove()
      return document.documentElement.classList.contains('has-js') && hidden
    })(),
    robots: document.querySelector('meta[name="robots"]')?.getAttribute('content'),
    title: document.title,
  }))
  // A noindexed permutation ships no canonical at all: pointing it at the
  // unfiltered page would pair a "do not index" with a "index that one instead".
  if (canonicalPath === null) {
    if (result.canonical !== undefined) {
      throw new Error(`${label} should not declare a canonical URL: ${result.canonical}`)
    }
  } else if (result.canonical !== `https://deepseek1024.com${canonicalPath}`) {
    throw new Error(`${label} has an incorrect canonical URL: ${result.canonical}`)
  }
  if (!result.description || result.description.length < 50) {
    throw new Error(`${label} is missing a useful meta description`)
  }
  if (result.h1Count !== 1) throw new Error(`${label} should render exactly one H1`)
  // The Worker injects a crawlable shell into #root for clients that cannot run
  // JavaScript. React replaces it on mount, and the inline head guard must have
  // kept it from ever painting in the meantime.
  if (result.shellLeftBehind !== 0) {
    throw new Error(`${label} still shows the pre-hydration SEO shell after mount`)
  }
  if (!result.shellGuarded) {
    throw new Error(`${label} would paint the SEO shell before React mounts`)
  }
  if (result.h2Count < 1) throw new Error(`${label} should name its content with at least one H2`)
  if (result.robots !== robots) throw new Error(`${label} has incorrect robots metadata`)
  if (!result.title || result.title === 'DeepSeek Harness Store') {
    throw new Error(`${label} is missing page-specific title metadata`)
  }
}

// The rankings view defaults to the 24h growth mode, which is legitimately
// empty until enough star-history snapshots exist (e.g. a freshly seeded local
// environment). Fall back to the stars mode so layout assertions can proceed.
async function waitForRankingList(page) {
  await page.locator('.ranking-section').waitFor()
  await page
    .locator('.ranking-section .package-list, .ranking-section .state-panel')
    .first()
    .waitFor()
  if ((await page.locator('.ranking-section .package-list').count()) === 0) {
    await page.locator('.ranking-section .segmented-control button').nth(1).click()
    await page.locator('.ranking-section .package-list').waitFor()
  }
}

async function assertLiveStats(page) {
  await page.waitForFunction(
    () => [...document.querySelectorAll('.hero-live-count')].every((node) => node.textContent !== '--'),
    undefined,
    { timeout: 10_000 },
  )
}

try {
  const defaultView = await openPage({ width: 1440, height: 1000 }, '/')
  await defaultView.locator('.ranking-section').waitFor()
  if (new URL(defaultView.url()).pathname !== '/') {
    throw new Error('root route changed the visible URL while rendering rankings')
  }
  await assertSeo(defaultView, 'default rankings', '/')
  await defaultView.close()

  const legacyCatalog = await openPage({ width: 1440, height: 1000 }, '/plugin?q=crosstalk')
  if (new URL(legacyCatalog.url()).pathname !== '/plugins' || new URL(legacyCatalog.url()).searchParams.get('q') !== 'crosstalk') {
    throw new Error('singular plugin route did not preserve its query while redirecting to /plugins')
  }
  await legacyCatalog.close()

  const desktop = await openPage({ width: 1440, height: 1000 }, '/plugins')
  await desktop.locator('.directory-section .package-list').waitFor()
  if ((await desktop.locator('.ranking-section').count()) !== 0) {
    throw new Error('desktop catalog unexpectedly renders rankings')
  }
  if ((await desktop.locator('.directory-section .sort-segments button').count()) !== 3) {
    throw new Error('directory sort controls should only contain stars, newest, and active')
  }
  await assertLiveStats(desktop)
  await assertSeo(desktop, 'desktop catalog', '/plugins')
  await assertNoHorizontalOverflow(desktop, 'desktop catalog')
  if (await desktop.locator('.hero-heading h1 a[href="https://deepseek1024.com/"]').getAttribute('aria-label') !== 'DeepSeek Harness Plugin 1024Store') {
    throw new Error('catalog hero does not show the linked DeepSeek Harness Plugin 1024Store title')
  }
  if (!(await desktop.locator('.hero-heading > p:last-child').textContent())?.includes('收录插件均先经 DSH 插件规范检查与过滤')) {
    throw new Error('catalog hero does not keep the shared plugin screening description')
  }
  if (!/^\d+ (秒|分钟|小时|天)前更新$/.test((await desktop.locator('.hero-updated').textContent())?.trim() ?? '')) {
    throw new Error('catalog tally does not show a relative update time')
  }
  const heroAlignment = await desktop.evaluate(() => {
    const heading = document.querySelector('.hero-heading')?.getBoundingClientRect()
    const actions = document.querySelector('.hero-stage > .hero-actions')?.getBoundingClientRect()
    const hero = document.querySelector('.catalog-hero')?.getBoundingClientRect()
    const navigation = document.querySelector('.catalog-content > .catalog-navigation')?.getBoundingClientRect()
    return {
      actionsTop: actions?.top,
      headingTop: heading?.top,
      heroBottom: hero?.bottom,
      heroControlCount: document.querySelectorAll('.catalog-hero .catalog-toolbar, .catalog-hero .catalog-view-tabs').length,
      legacyToplineCount: document.querySelectorAll('.hero-topline').length,
      navigationTop: navigation?.top,
    }
  })
  if (
    heroAlignment.legacyToplineCount !== 0
    || heroAlignment.heroControlCount !== 0
    || heroAlignment.actionsTop === undefined
    || heroAlignment.headingTop === undefined
    || heroAlignment.heroBottom === undefined
    || heroAlignment.navigationTop === undefined
    || Math.abs(heroAlignment.actionsTop - heroAlignment.headingTop) > 1
    || heroAlignment.navigationTop < heroAlignment.heroBottom
  ) {
    throw new Error(`hero and catalog controls have incorrect structure: ${JSON.stringify(heroAlignment)}`)
  }
  await desktop.close()

  const rankings = await openPage({ width: 1440, height: 1000 }, '/rankings')
  await rankings.locator('.ranking-section').waitFor()
  if ((await rankings.locator('.directory-section').count()) !== 0) {
    throw new Error('desktop rankings unexpectedly renders the directory')
  }
  if ((await rankings.locator('.ranking-section .segmented-control button').count()) !== 4) {
    throw new Error('rankings should only expose the four GitHub activity modes')
  }
  if (await rankings.locator('.ranking-section .segmented-control button').first().getAttribute('aria-pressed') !== 'true') {
    throw new Error('rankings should default to the 24h growth mode')
  }
  if ((await rankings.locator('header a[href="https://www.deepseek.com/harness/"]').count()) !== 0) {
    throw new Error('official Harness link should not be rendered in the header')
  }
  if ((await rankings.locator('.site-bottom-link a[href="https://www.deepseek.com/harness/"]').count()) !== 1) {
    throw new Error('official Harness link is missing from the page bottom')
  }
  if (!(await rankings.locator('.site-bottom-link p').textContent())?.includes('DeepSeek')) {
    throw new Error('unofficial project notice is missing from the page bottom')
  }
  if ((await rankings.locator('.catalog-hero .github-link[href="https://github.com/imsai-sh/awesome-deepseek-harness-plugins"]').count()) !== 1) {
    throw new Error('GitHub repository link is missing from the catalog banner')
  }
  if ((await rankings.locator('.catalog-hero .hero-submit[href="https://github.com/imsai-sh/awesome-deepseek-harness-plugins"][target="_blank"]').count()) !== 1) {
    throw new Error('submit button does not link to the GitHub repository')
  }
  if ((await rankings.locator('.catalog-hero .hero-brand').count()) !== 0) {
    throw new Error('removed top-left banner title is still rendered')
  }
  if ((await rankings.locator('.site-header').count()) !== 0) {
    throw new Error('the removed standalone site header is still rendered')
  }
  if (await rankings.locator('.hero-heading h1 a[href="https://deepseek1024.com/"]').getAttribute('aria-label') !== 'DeepSeek Harness Plugin 1024Store') {
    throw new Error('ranking hero does not keep the shared store title')
  }
  if (!(await rankings.locator('.hero-heading > p:last-child').textContent())?.includes('收录插件均先经 DSH 插件规范检查与过滤')) {
    throw new Error('ranking hero does not keep the shared plugin screening description')
  }
  if ((await rankings.locator('.catalog-hero .hero-lockup-mark img[src="/deepseek1024.png"]').count()) !== 1) {
    throw new Error('hero poster mark is missing the store icon')
  }
  if ((await rankings.locator('footer, .reset-button').count()) !== 0) {
    throw new Error('removed footer or refresh control is still rendered')
  }
  await assertSeo(rankings, 'desktop rankings', '/')
  await rankings.locator('.ranking-section .segmented-control button').last().click()
  await rankings.locator('.ranking-section .package-row').first().waitFor()
  if ((await rankings.locator('.ranking-section .package-row').count()) !== 100) {
    throw new Error('GitHub activity rankings did not render the top 100 packages')
  }
  if ((await rankings.locator('a[href^="/plugins/"]').count()) === 0) {
    throw new Error('catalog cards do not use the canonical plural plugins path')
  }
  // Search filters client-side from the cached catalog; no network round trip.
  await rankings.locator('input[type="search"]').fill('crosstalk')
  await rankings.waitForFunction(
    () => document.querySelectorAll('.ranking-section .package-row').length === 1,
    undefined,
    { timeout: 5_000 },
  )
  if ((await rankings.locator('.ranking-section .package-row').count()) !== 1) {
    throw new Error('ranking search did not filter the visible ranking')
  }
  await assertNoHorizontalOverflow(rankings, 'desktop rankings')
  await rankings.close()

  const mobile = await openPage({ width: 390, height: 844 }, '/plugins', { touch: true })
  await mobile.locator('.directory-section .package-list').waitFor()
  await assertLiveStats(mobile)

  // Regression guards for instant filtering: the directory renders
  // incrementally instead of mounting every plugin at once, and switching
  // filters derives from the cached catalog without another network request.
  let catalogRequests = 0
  mobile.on('request', (request) => {
    if (request.url().includes('/api/v1/plugins')) catalogRequests += 1
  })
  const initialRows = await mobile.locator('.directory-section .package-row').count()
  if (initialRows !== 100) {
    throw new Error(`directory mounted ${initialRows} rows at once; expected the first 100 rows`)
  }
  await mobile.locator('.load-more-row button').waitFor()
  await mobile.locator('.load-more-row button').scrollIntoViewIfNeeded()
  await mobile.waitForTimeout(500)
  if ((await mobile.locator('.directory-section .package-row').count()) !== initialRows) {
    throw new Error('directory loaded more rows automatically before the button was clicked')
  }
  await mobile.locator('.load-more-row button').click()
  await mobile.waitForFunction(
    (before) => document.querySelectorAll('.directory-section .package-row').length > before,
    initialRows,
    { timeout: 5_000 },
  )
  await mobile.locator('.category-filter button').nth(2).click()
  await mobile.waitForFunction(
    () => document.querySelectorAll('.category-filter button')[2]?.classList.contains('selected'),
    undefined,
    { timeout: 5_000 },
  )
  if (catalogRequests > 0) {
    throw new Error('filter interactions refetched the catalog; expected client-side derivation')
  }
  await mobile.locator('.category-filter button').first().click()
  await mobile.waitForURL((url) => !url.searchParams.has('category'))
  await assertMobileEnvironment(mobile, 'mobile catalog')
  await assertNoHorizontalOverflow(mobile, 'mobile catalog')
  await assertMinTouchTargets(mobile, 'mobile catalog', [
    '.catalog-hero .github-link',
    '.catalog-hero .hero-submit',
    '.catalog-hero .hero-language button',
    '.catalog-view-tabs a',
    '.category-filter button',
    '.segmented-control button',
    '.package-row .icon-button',
    '.package-row .row-link',
    '.load-more-row .button',
  ])
  await assertMinFontSize(mobile, 'mobile search input', 'input[type="search"]', 16)
  await assertMinFontSize(mobile, 'mobile package title', '.row-title', 14)
  await assertMinFontSize(mobile, 'mobile package description', '.row-identity p', 12)
  await assertMinFontSize(mobile, 'mobile package metrics', '.row-metrics > span', 11)
  await assertMinFontSize(mobile, 'mobile hero description', '.hero-heading > p:last-child', 14)
  await assertMinFontSize(mobile, 'mobile hero tally label', '.hero-tally-label', 11)
  await assertHorizontalTouchScroller(mobile, 'mobile category filters', '.category-filter')

  await mobile.locator('.category-filter button').nth(1).click()
  await mobile.waitForURL((url) => url.searchParams.has('category'))
  await mobile.locator('.category-filter button').first().click()
  await mobile.waitForURL((url) => !url.searchParams.has('category'))

  await mobile.locator('input[type="search"]').fill('crosstalk')
  await mobile.waitForURL((url) => url.searchParams.get('q') === 'crosstalk')
  await mobile.waitForFunction(
    () => document.querySelector('meta[name="robots"]')?.getAttribute('content') === 'noindex,follow',
    undefined,
    { timeout: 5_000 },
  )
  await assertSeo(mobile, 'filtered mobile catalog', null, 'noindex,follow')
  // The URL and the robots meta flip a render before the filtered list does, so
  // counting rows immediately races the re-render rather than testing the search.
  await mobile.locator('.directory-section .package-row').first().waitFor({ timeout: 10_000 })
    .catch(() => { throw new Error('search returned no package rows') })
  await mobile.locator('.directory-section .package-row .icon-button').first().click()
  await mobile.locator('.directory-section .package-row .icon-button[aria-label="已复制"]').waitFor()
  await mobile.locator('.catalog-hero .language-switch button').last().click()
  await mobile.waitForFunction(() => document.documentElement.lang === 'en')
  await assertNoHorizontalOverflow(mobile, 'English mobile catalog')
  await mobile.locator('.catalog-hero .language-switch button').first().click()
  await mobile.waitForFunction(() => document.documentElement.lang === 'zh-CN')

  // The visual row is also the primary mobile navigation target. Exercise a
  // point in its padding, away from the title link and copy button, so this
  // fails if only those small controls are clickable.
  const firstMobileRow = mobile.locator('.directory-section .package-row').first()
  const firstMobileDetailPath = await firstMobileRow.locator('.row-link').getAttribute('href')
  if (!firstMobileDetailPath) throw new Error('mobile package row is missing its detail path')
  const detailPopupPromise = mobile.waitForEvent('popup')
  await firstMobileRow.click({ position: { x: 8, y: 8 } })
  const detailPopup = await detailPopupPromise
  await detailPopup.waitForLoadState('domcontentloaded')
  if (new URL(detailPopup.url()).pathname !== firstMobileDetailPath) {
    throw new Error(`mobile package row opened the wrong detail page: ${detailPopup.url()}`)
  }
  await detailPopup.close()
  await mobile.close()

  const mobileRankings = await openPage({ width: 390, height: 844 }, '/rankings', { touch: true })
  await waitForRankingList(mobileRankings)
  await assertMobileEnvironment(mobileRankings, 'mobile rankings')
  await assertNoHorizontalOverflow(mobileRankings, 'mobile rankings')
  await assertMinTouchTargets(mobileRankings, 'mobile rankings', [
    '.catalog-view-tabs a',
    '.segmented-control button',
    '.package-row .row-link',
  ])
  await assertHorizontalTouchScroller(
    mobileRankings,
    'mobile GitHub ranking modes',
    '.ranking-mode-group:last-child .segmented-control',
    // Four modes fit within 390px; the scroller only engages when they overflow.
    { requireOverflow: false },
  )
  await mobileRankings.locator('.ranking-section .segmented-control button').last().click()
  if (await mobileRankings.locator('.ranking-section .segmented-control button').last().getAttribute('aria-pressed') !== 'true') {
    throw new Error('mobile ranking controls could not select an offscreen mode')
  }
  await mobileRankings.close()

  const detail = await openPage({ width: 1440, height: 1000 }, '/plugins/openma-ai/deepseek-harness-tui')
  await detail.locator('.detail-header').waitFor()
  await detail.locator('.install-activity-section').waitFor()
  // Only the OFFICIAL DeepSeek Harness CLI command is shown for now; the
  // wrapper CLI must not appear anywhere on the page (regression: the
  // registry install field was once overwritten with the wrapper command).
  const installCommand = await detail
    .locator('.install-section .install-command code')
    .first()
    .textContent()
  if (!installCommand?.trim().startsWith('dsh plugin --profile')) {
    throw new Error(`detail install command is not the official CLI command: ${installCommand}`)
  }
  if ((await detail.locator('.detail-layout').textContent())?.includes('@dsh-1024store/cli')) {
    throw new Error('detail page still shows the wrapper CLI command')
  }
  await assertSeo(detail, 'desktop detail', '/plugins/openma-ai/deepseek-harness-tui')
  await assertNoHorizontalOverflow(detail, 'desktop detail')
  await detail.locator('.detail-brand').click()
  await detail.waitForURL((url) => url.pathname === '/')
  await detail.locator('.ranking-section').waitFor()
  await detail.close()

  const scoped = await openPage({ width: 390, height: 844 }, '/plugins/zhaoolee/notes', { touch: true })
  await scoped.locator('.detail-header').waitFor()
  await assertMobileEnvironment(scoped, 'mobile package detail')
  await assertNoHorizontalOverflow(scoped, 'scoped package detail')
  await assertMinTouchTargets(scoped, 'mobile package detail', [
    '.detail-brand',
    '.detail-utility .language-switch button',
    '.back-link',
    '.detail-actions .button',
    '.install-command-prominent .icon-button',
    '.site-bottom-link a',
  ])
  await assertMinFontSize(scoped, 'mobile detail prose', '.detail-description', 15)
  await assertMinFontSize(scoped, 'mobile README prose', '.markdown-body', 15)
  await assertMinFontSize(scoped, 'mobile package facts', '.package-facts dd', 13)
  const detailOrder = await scoped.evaluate(() => ({
    install: document.querySelector('.install-section')?.getBoundingClientRect().top,
    installActivity: document.querySelector('.install-activity-section')?.getBoundingClientRect().top,
    primary: document.querySelector('.detail-primary')?.getBoundingClientRect().top,
    readme: document.querySelector('.readme-section')?.getBoundingClientRect().top,
    sidebar: document.querySelector('.package-sidebar')?.getBoundingClientRect().top,
  }))
  if (
    detailOrder.install === undefined
    || detailOrder.installActivity === undefined
    || detailOrder.primary === undefined
    || detailOrder.sidebar === undefined
    || detailOrder.readme === undefined
    || !(
      detailOrder.primary <= detailOrder.install
      && detailOrder.install < detailOrder.installActivity
      && detailOrder.installActivity < detailOrder.sidebar
      && detailOrder.sidebar < detailOrder.readme
    )
  ) {
    throw new Error(`mobile detail content priority is incorrect: ${JSON.stringify(detailOrder)}`)
  }
  await scoped.locator('.install-command-prominent .icon-button').click()
  await scoped.locator('.install-command-prominent .icon-button[aria-label="已复制"]').waitFor()
  await scoped.locator('.detail-brand').click()
  await scoped.waitForURL((url) => url.pathname === '/')
  await scoped.locator('.ranking-section').waitFor()
  await scoped.close()

  const compactMobile = await openPage({ width: 320, height: 568 }, '/rankings', { touch: true })
  await waitForRankingList(compactMobile)
  await assertNoHorizontalOverflow(compactMobile, 'compact mobile rankings')
  if (await compactMobile.locator('.catalog-hero .hero-language').isVisible()) {
    throw new Error('compact mobile header did not hide the secondary language control')
  }
  await assertMinTouchTargets(compactMobile, 'compact mobile header', [
    '.catalog-hero .github-link',
    '.catalog-hero .hero-submit',
    '.catalog-view-tabs a',
    '.package-row .row-link',
  ])
  await compactMobile.close()

  // 看板娘（桌宠）回归：固定在视口内不越界、触屏按钮 ≥44px、
  // 投喂 → 气泡、玩耍 → 气泡。鲸鱼娘常驻（无隐藏入口）。
  // 看板娘带持续 3D 摆动动画，Playwright 的稳定检查会一直等，交互统一用 force。
  const pet = await openPage({ width: 390, height: 844 }, '/rankings', { touch: true })
  await waitForRankingList(pet)
  await pet.locator('.kanban-girl').waitFor()
  const petBounds = await pet.evaluate(() => {
    const rect = document.querySelector('.kanban-girl')?.getBoundingClientRect()
    return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null
  })
  if (
    !petBounds
    || petBounds.left < 0
    || petBounds.top < 0
    || petBounds.right > 390
    || petBounds.bottom > 844
  ) {
    throw new Error(`mobile kanban girl leaves the viewport: ${JSON.stringify(petBounds)}`)
  }
  await pet.locator('.kanban-girl').tap({ force: true })
  await pet.locator('.kanban-girl-menu .kanban-girl-action').first().waitFor()
  await assertMinTouchTargets(pet, 'mobile kanban girl actions', [
    '.kanban-girl-menu .kanban-girl-action',
  ])
  await pet.locator('.kanban-girl-menu .kanban-girl-action').first().tap({ force: true })
  await pet.locator('.kanban-girl-bubble').waitFor()
  await pet.locator('.kanban-girl-menu .kanban-girl-action').nth(1).tap({ force: true })
  await pet.locator('.kanban-girl-bubble').waitFor()
  await pet.close()

  if (errors.length > 0) throw new Error(`browser errors:\n${errors.join('\n')}`)
  console.log('Visual smoke check passed: desktop, touch-enabled 390px mobile, compact 320px mobile, search, copy actions, local scrollers, and package details.')
} finally {
  await desktopContext.close()
  await mobileContext.close()
  await browser.close()
}
