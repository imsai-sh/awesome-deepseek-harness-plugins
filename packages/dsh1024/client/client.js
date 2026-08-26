window.__ModuleLoader__.load({ id: "dsh1024", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

const React = require('react')
const h = React.createElement
const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React
const NS = 'dsh1024'

const SITE_URL = 'https://deepseek1024.com/'
const BRAND_ICON_URL = '/dsh1024/icon'
const DEFAULT_EMBED_URL = SITE_URL + 'embed/store?bridge=dsh1024-v1'
const BRIDGE_PROTOCOL = 'dsh1024-bridge'
const BRIDGE_VERSION = 1
const READY_TIMEOUT_MS = 5_000
const PLUGIN_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/
// A page-supplied install command: `dsh plugin …` out of inert tokens. The
// local endpoint re-validates before forwarding it to the official CLI.
const INSTALL_COMMAND_RE = /^dsh plugin(?: [A-Za-z0-9@:/._#+=-]+)+$/

const zh = {
  tab: '1024 Store', connected: '商店已连接', connecting: '正在连接商店', unavailable: '商店无法嵌入',
  loading: '正在刷新商店…',
  reload: '重新加载', openSite: '在浏览器打开', checkUpdate: '检查更新', updating: '更新中…',
  updateNow: '更新到', upToDate: '已是最新', current: '当前版本',
  fallbackTitle: '商店页面未能加载', fallbackBody: '可以重试、在系统浏览器打开主站，或检查本地壳更新。',
  updateFailed: '更新检查失败', operationFailed: '操作失败', restart: '更新已安装，重启 DeepSeek Harness 后生效。',
  settings: '商店设置', sidebarEntrySetting: '在左侧栏显示 1024 Store 入口',
  confirmInstall: '确认从 1024 Store 安装', confirmUpdate: '确认更新 1024 Store 到', cancelled: '用户取消了安装。',
  busy: '已有插件操作正在进行。', installed: '安装完成，重启 DeepSeek Harness 后生效。',
  uninstalled: '卸载完成，重启 DeepSeek Harness 后生效。',
  plugins: '个插件', close: '关闭',
}

const en = {
  tab: '1024 Store', connected: 'Store connected', connecting: 'Connecting to store', unavailable: 'Store could not be embedded',
  loading: 'Refreshing store…',
  reload: 'Reload', openSite: 'Open in browser', checkUpdate: 'Check for updates', updating: 'Updating…',
  updateNow: 'Update to', upToDate: 'Up to date', current: 'Current version',
  fallbackTitle: 'The store page did not load', fallbackBody: 'Reload it, open the website in your browser, or check for a local shell update.',
  updateFailed: 'Update check failed', operationFailed: 'Operation failed', restart: 'Update installed. Restart DeepSeek Harness to apply it.',
  confirmInstall: 'Install from 1024 Store', confirmUpdate: 'Update 1024 Store to', cancelled: 'Installation was cancelled.',
  settings: 'Store settings', sidebarEntrySetting: 'Show the 1024 Store entry in the sidebar',
  busy: 'Another plugin operation is already running.', installed: 'Installed. Restart DeepSeek Harness to apply it.',
  uninstalled: 'Uninstalled. Restart DeepSeek Harness to apply it.',
  plugins: 'plugins', close: 'Close',
}

let catalogCount = null
const catalogCountListeners = new Set()

function publishCatalogCount(count) {
  if (!Number.isInteger(count) || count < 0 || count === catalogCount) return
  catalogCount = count
  for (const listener of catalogCountListeners) listener()
}

function subscribeCatalogCount(listener) {
  catalogCountListeners.add(listener)
  return () => catalogCountListeners.delete(listener)
}

function readCatalogCount() {
  return catalogCount
}

// The panel's "show sidebar entry" switch takes effect immediately: the
// preference is persisted by the local endpoint and published here so the
// mounted SidebarEntry can hide or reappear without a restart.
let sidebarEntryVisible = null
const sidebarEntryListeners = new Set()

function publishSidebarEntry(visible) {
  if (typeof visible !== 'boolean' || visible === sidebarEntryVisible) return
  sidebarEntryVisible = visible
  for (const listener of sidebarEntryListeners) listener()
}

function subscribeSidebarEntry(listener) {
  sidebarEntryListeners.add(listener)
  return () => sidebarEntryListeners.delete(listener)
}

function readSidebarEntryVisible() {
  return sidebarEntryVisible
}

function useCatalogCount() {
  return useSyncExternalStore(subscribeCatalogCount, readCatalogCount, readCatalogCount)
}

const CSS = `
.dsm-shell{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);display:grid;grid-template-rows:auto minmax(0,1fr);height:clamp(520px,calc(100vh - 170px),860px);min-height:0;min-width:0;overflow:hidden}
.dsm-shellbar{align-items:center;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);display:flex;gap:10px;min-height:48px;padding:7px 10px}
.dsm-brand{align-items:center;display:flex;gap:9px;min-width:0}.dsm-brand-logo{display:block;flex:0 0 32px;height:32px;object-fit:contain;width:32px}.dsm-title{align-items:baseline;display:flex;font-size:14px;font-weight:720;gap:5px;line-height:1.2;white-space:nowrap}.dsm-title em{color:var(--dsw-alias-brand-primary);font-style:normal}
.dsm-grow{flex:1}.dsm-version{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
.dsm-settings{position:relative}.dsm-settings-pop{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.18);min-width:240px;padding:10px 12px;position:absolute;right:0;top:calc(100% + 6px);z-index:5}.dsm-settings-row{align-items:center;cursor:pointer;display:flex;font-size:12.5px;gap:8px;line-height:1.4}.dsm-settings-row input{accent-color:var(--dsw-alias-brand-primary);height:15px;width:15px}
.dsm-icon,.dsm-command{appearance:none;align-items:center;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:7px;color:inherit;cursor:pointer;display:inline-flex;font:inherit;font-size:12px;gap:6px;justify-content:center;min-height:32px;padding:0 9px;white-space:nowrap}.dsm-icon{font-size:16px;padding:0;width:32px}.dsm-command[data-kind=primary]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:680}.dsm-icon:hover,.dsm-command:hover{background:var(--dsw-alias-button-ghost-active-fill)}.dsm-command[data-kind=primary]:hover{filter:brightness(.94)}.dsm-icon:disabled,.dsm-command:disabled{cursor:not-allowed;opacity:.5}
.dsm-stage{min-height:0;position:relative}.dsm-frame{background:var(--dsw-alias-bg-layer-1);border:0;height:100%;width:100%}.dsm-loading{align-items:center;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);display:flex;font-size:12px;gap:9px;inset:0;justify-content:center;position:absolute;z-index:1}.dsm-spinner{animation:dsm-spin .8s linear infinite;border:2px solid var(--dsw-alias-border-l3);border-radius:50%;border-top-color:var(--dsw-alias-brand-primary);height:18px;width:18px}@keyframes dsm-spin{to{transform:rotate(360deg)}}.dsm-toast{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;box-shadow:0 8px 28px rgba(0,0,0,.2);font-size:12px;left:50%;max-width:min(520px,calc(100% - 24px));overflow-wrap:anywhere;padding:9px 12px;position:absolute;top:12px;transform:translateX(-50%);z-index:2}
.dsm-fallback{align-items:center;background:var(--dsw-alias-bg-layer-1);display:flex;inset:0;justify-content:center;overflow:auto;padding:22px;position:absolute}.dsm-fallback-inner{max-width:520px;text-align:center;width:100%}.dsm-fallback-mark{align-items:center;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;display:inline-flex;font-size:22px;height:48px;justify-content:center;width:48px}.dsm-fallback h3{font-size:17px;letter-spacing:0;margin:14px 0 7px}.dsm-fallback p{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin:0 auto}.dsm-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:18px}.dsm-update-state{border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin-top:18px;padding-top:14px}.dsm-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}.dsm-success{color:#16845b}
.dsm-rail{align-items:center;appearance:none;background:none;border:0;border-radius:8px;color:inherit;cursor:pointer;display:flex;font:inherit;font-size:13px;gap:9px;min-height:40px;padding:0 8px;width:100%}.dsm-rail:hover{background:var(--dsw-alias-button-ghost-active-fill)}.dsm-rail[data-wide=false]{border-radius:50%;height:40px;justify-content:center;padding:0;width:40px}.dsm-rail-icon{align-items:center;display:flex;flex:0 0 28px;height:28px;justify-content:center;position:relative;width:28px}.dsm-rail-icon img{display:block;height:27px;object-fit:contain;width:27px}.dsm-rail-status-dot{background:var(--dsw-alias-label-tertiary);border-radius:50%;display:block;flex:0 0 7px;height:7px;width:7px}.dsm-rail-status-dot.is-icon{border:2px solid var(--dsw-alias-bg-layer-1);bottom:-1px;height:9px;position:absolute;right:-1px;width:9px}.dsm-rail-status-dot[data-connected=true]{background:#22a06b}.dsm-rail-copy{align-items:center;display:flex;flex:1;gap:7px;min-width:0}.dsm-rail-label{font-weight:650;overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap}.dsm-rail-count{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsm-pop-backdrop{background:rgba(15,18,24,.32);inset:0;position:fixed;z-index:2147483000}.dsm-pop{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 20px 64px rgba(0,0,0,.3);display:flex;height:min(820px,calc(100vh - 64px));left:50%;overflow:hidden;position:fixed;top:50%;transform:translate(-50%,-50%);width:min(1080px,calc(100vw - 64px));z-index:2147483001}.dsm-pop[hidden]{display:none}.dsm-pop .dsm-shell{border:0;border-radius:0;height:100%;width:100%}
@media(max-width:640px){.dsm-shell{border-left:0;border-right:0;border-radius:0;height:calc(100vh - 120px);min-height:480px}.dsm-shellbar{gap:7px;padding:7px 8px}.dsm-version{display:none}.dsm-command{min-height:38px}.dsm-fallback{padding:16px}.dsm-pop{border:0;border-radius:0;height:100vh;height:100dvh;left:0;top:0;transform:none;width:100vw}.dsm-pop .dsm-shell{height:100vh;height:100dvh}.dsm-title{font-size:13px}}
@media(prefers-reduced-motion:reduce){.dsm-spinner{animation:none}}
`

function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('dsh1024-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh1024-style'
  style.setAttribute('data-plugin', NS)
  style.setAttribute('data-plugin-css', NS)
  style.textContent = CSS
  document.head.appendChild(style)
}

injectStyles()

function responseJson(response) {
  return response.json().catch(() => ({})).then(body => ({ status: response.status, body }))
}

function bridgeMessage(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function publicInstalledPlugin(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.id !== 'string' || !PLUGIN_ID_RE.test(value.id)
    || typeof value.name !== 'string' || typeof value.owner !== 'string'
    || typeof value.url !== 'string' || typeof value.category !== 'string'
    || typeof value.install !== 'string' || typeof value.added !== 'string') return null
  const stringMap = candidate => candidate !== null && typeof candidate === 'object'
    && !Array.isArray(candidate) && Object.values(candidate).every(item => typeof item === 'string')
  if (!stringMap(value.description) || typeof value.description.en !== 'string' || typeof value.description.zh !== 'string'
    || !stringMap(value.categoryLabel) || typeof value.categoryLabel.en !== 'string' || typeof value.categoryLabel.zh !== 'string') return null
  if (value.stars !== null && typeof value.stars !== 'number') return null
  return {
    id: value.id, name: value.name, owner: value.owner, url: value.url,
    category: value.category, categoryLabel: value.categoryLabel,
    description: value.description, install: value.install, added: value.added,
    stars: value.stars,
  }
}

function validBridgeRequest(message) {
  const base = message?.protocol === BRIDGE_PROTOCOL
    && message.version === BRIDGE_VERSION
    && message.type === 'request'
    && typeof message.requestId === 'string'
    && message.requestId.length > 0
    && message.requestId.length <= 128
  if (!base) return false
  if (message.action === 'installed') return message.pluginId === undefined
  if (message.action === 'status') return message.pluginId === undefined
  if (message.action === 'uninstall') {
    return typeof message.pluginId === 'string'
      && message.pluginId.length <= 201
      && PLUGIN_ID_RE.test(message.pluginId)
  }
  if (message.action === 'catalog-cache-read') return message.catalogPage === undefined
  if (message.action === 'catalog-cache-write') {
    return message.catalogPage !== null && typeof message.catalogPage === 'object'
      && !Array.isArray(message.catalogPage)
  }
  return message.action === 'install'
    && typeof message.pluginId === 'string'
    && message.pluginId.length <= 201
    && PLUGIN_ID_RE.test(message.pluginId)
    // The page may hand over the full official install command it displays;
    // the local endpoint re-validates the shape before executing anything.
    && (message.command === undefined
      || (typeof message.command === 'string' && message.command.length <= 1024 && INSTALL_COMMAND_RE.test(message.command)))
}

function MarketShell({ locale, onClose, activation }) {
  const localeSnapshot = useSyncExternalStore(
    listener => locale.subscribe(listener),
    () => locale.getSnapshot(),
  )
  const copy = String(localeSnapshot.active).toLowerCase().startsWith('zh') ? zh : en
  const iframeRef = useRef(null)
  const portRef = useRef(null)
  const readyTimerRef = useRef(null)
  const operationBusyRef = useRef(false)
  const activationRef = useRef(activation)
  const activationPendingRef = useRef(false)
  const [frameKey, setFrameKey] = useState(0)
  const [embedUrl, setEmbedUrl] = useState(null)
  const [connection, setConnection] = useState('connecting')
  const [updateInfo, setUpdateInfo] = useState(null)
  const [updateError, setUpdateError] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [operationMessage, setOperationMessage] = useState('')
  const toastTimerRef = useRef(null)
  // Toasts announce, they do not linger: auto-dismiss after a few seconds,
  // with each new message restarting the clock.
  const showToast = useCallback(message => {
    setOperationMessage(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = message === '' ? null : window.setTimeout(() => {
      toastTimerRef.current = null
      setOperationMessage('')
    }, 8000)
  }, [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [updateArmed, setUpdateArmed] = useState(false)
  const sidebarVisible = useSyncExternalStore(subscribeSidebarEntry, readSidebarEntryVisible, readSidebarEntryVisible)

  const saveSidebarEntry = useCallback(visible => {
    // Optimistic: the entry reacts immediately, and a failed write rolls back.
    const previous = readSidebarEntryVisible()
    publishSidebarEntry(visible)
    fetch('/dsh1024/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sidebarEntry: visible }),
    })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200 || body.ok !== true) throw new Error(body.error || ('HTTP ' + status))
      })
      .catch(() => { if (previous !== null) publishSidebarEntry(previous) })
  }, [])

  useEffect(() => {
    if (!settingsOpen) return undefined
    const onPointerDown = event => {
      if (event.target.closest && event.target.closest('.dsm-settings')) return
      setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [settingsOpen])

  const closeBridge = useCallback(() => {
    if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
    readyTimerRef.current = null
    portRef.current?.close()
    portRef.current = null
  }, [])

  const checkUpdate = useCallback(() => {
    setCheckingUpdate(true)
    setUpdateError('')
    return fetch('/dsh1024/update', { cache: 'no-store' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200) throw new Error(body.error || 'HTTP ' + status)
        setUpdateInfo(body)
      })
      .catch(error => setUpdateError(copy.updateFailed + ': ' + String(error)))
      .finally(() => setCheckingUpdate(false))
  }, [copy])

  useEffect(() => { checkUpdate() }, [checkUpdate])
  useEffect(() => closeBridge, [closeBridge])
  useEffect(() => {
    if (activation === undefined) return
    if (activation !== activationRef.current) {
      activationRef.current = activation
      activationPendingRef.current = true
    }
    const port = portRef.current
    if (!activationPendingRef.current || connection !== 'connected' || port === null) return
    activationPendingRef.current = false
    port.postMessage({ protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, type: 'activate' })
  }, [activation, connection])
  useEffect(() => {
    let active = true
    fetch('/dsh1024/embed-config', { cache: 'no-store' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (!active) return
        const candidate = status === 200 && typeof body.url === 'string' ? body.url : DEFAULT_EMBED_URL
        setEmbedUrl(candidate)
        if (status === 200 && typeof body.sidebarEntry === 'boolean') publishSidebarEntry(body.sidebarEntry)
      })
      .catch(() => { if (active) setEmbedUrl(DEFAULT_EMBED_URL) })
    return () => { active = false }
  }, [])

  const runInstall = useCallback((message, port) => {
    const reply = payload => port.postMessage({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...payload,
    })
    if (operationBusyRef.current) {
      reply({ ok: false, error: copy.busy })
      return
    }
    // No window.confirm here: a blocking native dialog inside the panel can
    // be suppressed or hidden by the host environment, which froze this
    // handler mid-flight and left the page's install button spinning forever.
    // The page owns the confirmation UI (a two-step button that shows the
    // exact command); this shell just executes what it is asked.
    operationBusyRef.current = true
    setOperationMessage('')
    fetch('/dsh1024/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message.command === undefined
        ? { id: message.pluginId }
        : { id: message.pluginId, command: message.command }),
    })
      .then(responseJson)
      .then(({ status, body }) => {
        // The full command output travels back to the page either way, so the
        // store can show the user exactly what ran and what it printed.
        const output = {
          stdout: typeof body.stdout === 'string' ? body.stdout.slice(-8192) : '',
          stderr: typeof body.stderr === 'string' ? body.stderr.slice(-8192) : '',
          exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
        }
        if (status !== 200 || !body.ok) {
          const detail = String(body.error || body.stderr || body.stdout || ('HTTP ' + status)).trim().slice(-800)
          showToast(copy.operationFailed + ': ' + detail)
          reply({ ok: false, error: detail, ...output })
          return
        }
        showToast(copy.installed)
        reply({ ok: true, ...output })
      })
      .catch(error => {
        const detail = String(error).trim().slice(-800)
        showToast(copy.operationFailed + ': ' + detail)
        reply({ ok: false, error: detail })
      })
      .finally(() => {
        operationBusyRef.current = false
      })
  }, [copy, showToast])

  const runUninstall = useCallback((message, port) => {
    const reply = payload => port.postMessage({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...payload,
    })
    if (operationBusyRef.current) {
      reply({ ok: false, error: copy.busy })
      return
    }
    operationBusyRef.current = true
    setOperationMessage('')
    fetch('/dsh1024/uninstall', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: message.pluginId }),
    })
      .then(responseJson)
      .then(({ status, body }) => {
        const output = {
          stdout: typeof body.stdout === 'string' ? body.stdout.slice(-8192) : '',
          stderr: typeof body.stderr === 'string' ? body.stderr.slice(-8192) : '',
          exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
          command: typeof body.command === 'string' ? body.command : undefined,
        }
        if (status !== 200 || !body.ok) {
          const detail = String(body.error || body.stderr || body.stdout || ('HTTP ' + status)).trim().slice(-800)
          showToast(copy.operationFailed + ': ' + detail)
          reply({ ok: false, error: detail, ...output })
          return
        }
        showToast(copy.uninstalled)
        reply({ ok: true, ...output })
      })
      .catch(error => {
        const detail = String(error).trim().slice(-800)
        showToast(copy.operationFailed + ': ' + detail)
        reply({ ok: false, error: detail })
      })
      .finally(() => {
        operationBusyRef.current = false
      })
  }, [copy, showToast])

  const readStatus = useCallback((message, port) => {
    const reply = payload => port.postMessage({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...payload,
    })
    fetch('/dsh1024/status', { cache: 'no-store' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200) throw new Error('HTTP ' + status)
        reply({
          ok: true,
          status: {
            active: body.active === true,
            action: typeof body.action === 'string' ? body.action : null,
            target: typeof body.target === 'string' ? body.target : '',
            seconds: typeof body.seconds === 'number' ? body.seconds : 0,
            lastLine: typeof body.lastLine === 'string' ? body.lastLine : '',
          },
        })
      })
      .catch(error => reply({ ok: false, error: String(error).trim().slice(-300) }))
  }, [])

  const readInstalled = useCallback((message, port) => {
    const reply = payload => port.postMessage({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...payload,
    })
    fetch('/dsh1024/installed', { cache: 'no-store' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200 || !Array.isArray(body.pluginIds) || !Array.isArray(body.plugins)) {
          throw new Error(body.error || ('HTTP ' + status))
        }
        const pluginIds = body.pluginIds.filter(id =>
          typeof id === 'string' && id.length <= 201 && PLUGIN_ID_RE.test(id))
        const installedIds = new Set(pluginIds)
        const plugins = body.plugins
          .map(publicInstalledPlugin)
          .filter(plugin => plugin !== null && installedIds.has(plugin.id))
        reply({ ok: true, pluginIds, plugins })
      })
      .catch(error => reply({ ok: false, error: String(error).trim().slice(-800) }))
  }, [])

  const readCatalogPageCache = useCallback((message, port) => {
    const reply = payload => port.postMessage({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...payload,
    })
    fetch('/dsh1024/catalog-page-cache', { cache: 'no-store' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200) throw new Error(body.error || ('HTTP ' + status))
        reply({ ok: true, catalogPage: body.page ?? null })
      })
      .catch(error => reply({ ok: false, error: String(error).trim().slice(-800) }))
  }, [])

  const writeCatalogPageCache = useCallback((message, port) => {
    const reply = payload => port.postMessage({
      protocol: BRIDGE_PROTOCOL,
      version: BRIDGE_VERSION,
      type: 'result',
      requestId: message.requestId,
      ...payload,
    })
    fetch('/dsh1024/catalog-page-cache', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: message.catalogPage }),
    })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200 || body.ok !== true) throw new Error(body.error || ('HTTP ' + status))
        reply({ ok: true })
      })
      .catch(error => reply({ ok: false, error: String(error).trim().slice(-800) }))
  }, [])

  const connectFrame = useCallback(() => {
    closeBridge()
    setConnection('connecting')
    const frameWindow = iframeRef.current?.contentWindow
    if (embedUrl === null || frameWindow === undefined || frameWindow === null || typeof MessageChannel === 'undefined') {
      setConnection('failed')
      return
    }
    const channel = new MessageChannel()
    portRef.current = channel.port1
    channel.port1.onmessage = event => {
      const message = bridgeMessage(event.data)
      if (message?.protocol !== BRIDGE_PROTOCOL || message.version !== BRIDGE_VERSION) return
      if (message.type === 'ready' && Array.isArray(message.capabilities)
        && message.capabilities.includes('install') && message.capabilities.includes('installed')) {
        if (readyTimerRef.current !== null) window.clearTimeout(readyTimerRef.current)
        readyTimerRef.current = null
        setConnection('connected')
        return
      }
      if (!validBridgeRequest(message)) {
        // Never drop a request silently: an unanswered request leaves the
        // page's install button spinning until its own timeout fires.
        if (message.type === 'request' && typeof message.requestId === 'string') {
          channel.port1.postMessage({
            protocol: BRIDGE_PROTOCOL,
            version: BRIDGE_VERSION,
            type: 'result',
            requestId: message.requestId,
            ok: false,
            error: 'unsupported bridge request',
          })
        }
        return
      }
      if (message.action === 'install') runInstall(message, channel.port1)
      else if (message.action === 'uninstall') runUninstall(message, channel.port1)
      else if (message.action === 'installed') readInstalled(message, channel.port1)
      else if (message.action === 'status') readStatus(message, channel.port1)
      else if (message.action === 'catalog-cache-read') readCatalogPageCache(message, channel.port1)
      else writeCatalogPageCache(message, channel.port1)
    }
    channel.port1.onmessageerror = () => setConnection('failed')
    channel.port1.start()
    readyTimerRef.current = window.setTimeout(() => setConnection('failed'), READY_TIMEOUT_MS)
    // The port is transferred only to the configured origin. It is the sole
    // capability that lets the remote page request a local operation.
    frameWindow.postMessage(
      { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, type: 'connect' },
      new URL(embedUrl).origin,
      [channel.port2],
    )
  }, [closeBridge, embedUrl, readCatalogPageCache, readInstalled, readStatus, runInstall, runUninstall, writeCatalogPageCache])

  useEffect(() => {
    if (embedUrl === null) return undefined
    const embedOrigin = new URL(embedUrl).origin
    const onFrameInit = event => {
      const message = bridgeMessage(event.data)
      if (
        event.origin !== embedOrigin
        || event.source !== iframeRef.current?.contentWindow
        || message?.protocol !== BRIDGE_PROTOCOL
        || message.version !== BRIDGE_VERSION
        || message.type !== 'init'
      ) return
      connectFrame()
    }
    window.addEventListener('message', onFrameInit)
    return () => window.removeEventListener('message', onFrameInit)
  }, [connectFrame, embedUrl])

  const frameLoaded = useCallback(() => {
    closeBridge()
    setConnection('connecting')
    readyTimerRef.current = window.setTimeout(() => setConnection('failed'), READY_TIMEOUT_MS)
  }, [closeBridge])

  const reloadFrame = useCallback(() => {
    closeBridge()
    setOperationMessage('')
    setConnection('connecting')
    setFrameKey(value => value + 1)
  }, [closeBridge])

  const selfUpdate = useCallback(() => {
    if (!updateInfo?.latestVersion || updating) return
    // Two-step confirmation on the button itself; a blocking window.confirm
    // can be suppressed by the host environment and freeze the flow.
    if (!updateArmed) {
      setUpdateArmed(true)
      window.setTimeout(() => setUpdateArmed(false), 5000)
      return
    }
    setUpdateArmed(false)
    setUpdating(true)
    setUpdateError('')
    fetch('/dsh1024/self-update', { method: 'POST' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status !== 200 || !body.ok) throw new Error(body.error || body.stderr || body.stdout || ('HTTP ' + status))
        if (body.updated) setRestartRequired(true)
        if (body.update) setUpdateInfo(body.update)
      })
      .catch(error => setUpdateError(copy.operationFailed + ': ' + String(error).trim().slice(-800)))
      .finally(() => setUpdating(false))
  }, [copy, updateArmed, updateInfo, updating])

  const renderUpdateAction = () => updateInfo?.updateAvailable
    ? h('button', { className: 'dsm-command', 'data-kind': 'primary', type: 'button', disabled: updating, onClick: selfUpdate },
        updating ? copy.updating : (updateArmed ? copy.confirmUpdate + ' v' + updateInfo.latestVersion : copy.updateNow + ' v' + updateInfo.latestVersion))
    : null

  return h('div', { className: 'dsm-shell' },
    h('header', { className: 'dsm-shellbar' },
      h('div', { className: 'dsm-brand' },
        h('img', { className: 'dsm-brand-logo', src: BRAND_ICON_URL, alt: '', 'aria-hidden': true }),
        h('span', { className: 'dsm-title' },
          h('span', null, 'DeepSeek Harness Plugin'), h('em', null, '1024Store'))),
      h('span', { className: 'dsm-grow' }),
      updateInfo && h('span', { className: 'dsm-version' }, 'v' + updateInfo.currentVersion),
      renderUpdateAction(),
      h('div', { className: 'dsm-settings' },
        h('button', {
          className: 'dsm-icon', type: 'button', title: copy.settings, 'aria-label': copy.settings,
          'aria-expanded': settingsOpen, onClick: () => setSettingsOpen(value => !value),
        }, h('svg', {
          width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }),
          h('circle', { cx: 12, cy: 12, r: 3 }))),
        settingsOpen && h('div', { className: 'dsm-settings-pop', role: 'menu' },
          h('label', { className: 'dsm-settings-row' },
            h('input', {
              type: 'checkbox',
              checked: sidebarVisible !== false,
              onChange: event => saveSidebarEntry(event.target.checked),
            }),
            h('span', null, copy.sidebarEntrySetting)))),
      h('button', { className: 'dsm-icon', type: 'button', title: copy.reload, 'aria-label': copy.reload, onClick: reloadFrame }, '↻'),
      h('button', { className: 'dsm-icon', type: 'button', title: copy.openSite, 'aria-label': copy.openSite, onClick: () => window.open(SITE_URL, '_blank', 'noopener,noreferrer') }, '↗'),
      onClose && h('button', { className: 'dsm-icon', type: 'button', title: copy.close, 'aria-label': copy.close, onClick: onClose }, '×')),
    h('div', { className: 'dsm-stage' },
      embedUrl !== null && h('iframe', {
        className: 'dsm-frame', key: frameKey, ref: iframeRef, src: embedUrl,
        title: copy.tab, onLoad: frameLoaded,
        onError: () => setConnection('failed'),
        sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
      }),
      connection === 'connecting' && h('div', { className: 'dsm-loading', role: 'status', 'aria-label': copy.loading },
        h('span', { className: 'dsm-spinner', 'aria-hidden': true })),
      connection !== 'failed' && (operationMessage || restartRequired) && h('div', {
        className: 'dsm-toast ' + (operationMessage.startsWith(copy.operationFailed) ? 'dsm-error' : 'dsm-success'),
        role: 'status',
      }, operationMessage || copy.restart),
      connection === 'failed' && h('section', { className: 'dsm-fallback', role: 'alert' },
        h('div', { className: 'dsm-fallback-inner' },
          h('span', { className: 'dsm-fallback-mark', 'aria-hidden': true }, '↗'),
          h('h3', null, copy.fallbackTitle),
          h('p', null, copy.fallbackBody),
          h('div', { className: 'dsm-actions' },
            h('button', { className: 'dsm-command', type: 'button', onClick: reloadFrame }, copy.reload),
            h('button', { className: 'dsm-command', type: 'button', onClick: () => window.open(SITE_URL, '_blank', 'noopener,noreferrer') }, copy.openSite),
            h('button', { className: 'dsm-command', type: 'button', disabled: checkingUpdate, onClick: checkUpdate }, checkingUpdate ? '…' : copy.checkUpdate),
            renderUpdateAction()),
          h('div', { className: 'dsm-update-state' },
            updateInfo && h('div', null, copy.current + ' v' + updateInfo.currentVersion,
              updateInfo.checked && !updateInfo.updateAvailable ? ' · ' + copy.upToDate : ''),
            updateError && h('div', { className: 'dsm-error' }, updateError),
            restartRequired && h('div', { className: 'dsm-success' }, copy.restart),
            operationMessage && h('div', { className: operationMessage.startsWith(copy.operationFailed) ? 'dsm-error' : 'dsm-success' }, operationMessage))))))
}

function SidebarEntry({ wide, locale }) {
  const t = locale.bind(NS)
  const localeSnapshot = useSyncExternalStore(
    listener => locale.subscribe(listener),
    () => locale.getSnapshot(),
  )
  const copy = String(localeSnapshot.active).toLowerCase().startsWith('zh') ? zh : en
  const count = useCatalogCount()
  const entryRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [activation, setActivation] = useState(0)
  // The sidebar entry hides when the user switches it off (panel settings or
  // plugin config); the settings tabs stay either way. Subscribed, so the
  // panel switch takes effect immediately. Any fetch failure keeps the entry.
  const visiblePreference = useSyncExternalStore(subscribeSidebarEntry, readSidebarEntryVisible, readSidebarEntryVisible)
  useEffect(() => {
    if (readSidebarEntryVisible() !== null) return
    fetch('/dsh1024/embed-config', { cache: 'no-store' })
      .then(responseJson)
      .then(({ status, body }) => {
        if (status === 200 && typeof body.sidebarEntry === 'boolean') publishSidebarEntry(body.sidebarEntry)
      })
      .catch(() => {})
  }, [])
  const label = t('tab')
  const formattedCount = count === null
    ? ''
    : new Intl.NumberFormat(String(localeSnapshot.active).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US').format(count)
  const countLabel = count === null ? '' : formattedCount + ' ' + copy.plugins
  const title = count === null ? label : label + ' · ' + countLabel + ' · ' + copy.connected

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = event => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const closeMarket = useCallback(() => {
    setOpen(false)
    window.setTimeout(() => entryRef.current?.focus(), 0)
  }, [])

  const toggleMarket = useCallback(() => {
    if (!open) {
      setMounted(true)
      setActivation(value => value + 1)
    }
    setOpen(value => !value)
  }, [open])

  if (visiblePreference === false) return null

  return h(React.Fragment, null,
    h('button', {
      ref: entryRef,
      className: 'dsm-rail', type: 'button', 'data-wide': wide !== false,
      title, 'aria-label': title, 'aria-expanded': open,
      onClick: toggleMarket,
    },
      h('span', { className: 'dsm-rail-icon', 'aria-hidden': true },
        h('img', { src: BRAND_ICON_URL, alt: '' }),
        wide === false && count !== null && h('span', { className: 'dsm-rail-status-dot is-icon', 'data-connected': true })),
      wide !== false && h('span', { className: 'dsm-rail-copy' },
        h('span', { className: 'dsm-rail-label' }, label),
        count !== null && h(React.Fragment, null,
          h('span', { className: 'dsm-rail-count' }, countLabel),
          h('span', { className: 'dsm-rail-status-dot', 'data-connected': true, 'aria-hidden': true })))),
    mounted && h(React.Fragment, null,
      open && h('div', { className: 'dsm-pop-backdrop', onClick: closeMarket }),
      h('div', {
        className: 'dsm-pop', hidden: !open, role: open ? 'dialog' : undefined,
        'aria-modal': open ? true : undefined, 'aria-label': label,
      }, h(MarketShell, { locale, onClose: closeMarket, activation }))))
}

exports.name = 'dsh1024/client'
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh1024: dictionaries')
  const t = ctx.locale.bind(NS)
  fetch('/dsh1024/registry', { cache: 'no-store' })
    .then(responseJson)
    .then(({ status, body }) => {
      // `total` is the full catalog size; the capped API serves at most an
      // install-ranked head of it in `plugins`, which is all `count` measures.
      if (status === 200 && body.registry) publishCatalogCount(body.registry.total ?? body.registry.count)
      if (status !== 200 || body.source !== 'cache') return null
      return fetch('/dsh1024/registry?revalidate=1', { cache: 'no-store' })
        .then(responseJson)
        .then(({ status: refreshStatus, body: refreshBody }) => {
          if (refreshStatus === 200 && refreshBody.registry) publishCatalogCount(refreshBody.registry.total ?? refreshBody.registry.count)
        })
    })
    .catch(() => {})

  ctx.slots.inject('settings.plugins.tab', () => {
    let disposeEntry = () => {}
    const register = () => {
      disposeEntry = ctx.slots.register({
        name: 'settings.plugins.tab', id: '1024store', order: 20,
        label: () => t('tab') + (catalogCount === null ? '' : ' (' + catalogCount + ')'), locale: NS,
      }, () => h(MarketShell, { locale: ctx.locale }))
    }
    register()
    const unsubscribe = subscribeCatalogCount(() => { disposeEntry(); register() })
    return () => { unsubscribe(); disposeEntry() }
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'dsh1024-store', order: 10, label: () => t('tab'), locale: NS,
  }, props => h(SidebarEntry, { wide: props?.wide !== false, locale: ctx.locale })))

  ctx.slots.inject('settings.section', () => {
    let disposeSection = () => {}
    const register = () => {
      disposeSection = ctx.slots.register({
        name: 'settings.section', id: '1024store', order: 100,
        label: () => t('tab') + (catalogCount === null ? '' : ' (' + catalogCount + ')'), locale: NS,
      }, () => h(MarketShell, { locale: ctx.locale }))
    }
    register()
    const unsubscribe = subscribeCatalogCount(() => { disposeSection(); register() })
    return () => { unsubscribe(); disposeSection() }
  })
}

return module.exports; } });
