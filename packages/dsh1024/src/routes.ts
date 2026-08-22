/** Local HTTP routes for browsing and managing 1024 Store plugins. */

import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { installExtraArgs, installTarget, loadRegistry, parseGitHubSource } from './registry.ts'
import type { Registry, RegistryPlugin } from './registry.ts'
import { runPluginCommand } from './shared/install-runner.ts'
import type { InstallInvocation } from './shared/install-runner.ts'
import { reportInstallEvent } from './telemetry.ts'
import { checkForUpdate } from './update.ts'
import { resolveDshHome } from './shared/files.ts'
import { readCatalogPageCache, writeCatalogPageCache } from './catalog-cache.ts'

export interface WebRoute {
  kind: 'exact'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

export interface WebServerService {
  register(route: WebRoute): () => void
}

export interface MarketRouteConfig {
  profile: string
  registryUrl: string
  updateUrl: string
  embedUrl: string
}

interface CommandResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

interface Progress {
  active: boolean
  action: 'install' | 'update' | 'uninstall' | null
  target: string
  startedAt: number
  lastLine: string
}

const PROFILE_RE = /^[A-Za-z0-9_-]+$/
const PACKAGE_RE = /^(?:@[a-z0-9._-]+\/)?[A-Za-z0-9._-]+$/
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000
const BODY_LIMIT_BYTES = 4 * 1024
const CATALOG_CACHE_BODY_LIMIT_BYTES = 4 * 1024 * 1024
const BRAND_ICON = readFileSync(new URL('../client/brand-icon.png', import.meta.url))

function profileDirectory(profile: string): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', profile)
}

/** Read the store that pnpm used to link an existing profile's node_modules. */
export function readProfilePnpmStoreDir(directory: string): string | undefined {
  try {
    const contents = readFileSync(join(directory, 'node_modules', '.modules.yaml'), 'utf8')
    let candidate: unknown
    try {
      candidate = (JSON.parse(contents) as { storeDir?: unknown }).storeDir
    } catch {
      const match = /^\s*storeDir:\s*(.+?)\s*$/m.exec(contents)
      candidate = match?.[1]?.replace(/^(["'])(.*)\1$/, '$2')
    }
    return typeof candidate === 'string'
      && candidate !== ''
      && !candidate.includes('\0')
      && isAbsolute(candidate)
      ? candidate
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Read non-official dependencies installed into one profile.
 * @param profile - validated profile name.
 * @returns package names mapped to their manifest specs.
 */
export function readInstalled(profile: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(profileDirectory(profile), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return Object.fromEntries(
      Object.entries(manifest.dependencies ?? {}).filter(([name]) => !name.startsWith('@deepseek-ai/')),
    )
  } catch {
    return {}
  }
}

function installedPackageName(
  plugin: RegistryPlugin,
  installed: Record<string, string>,
): string | null {
  const target = installTarget(plugin)
  if (!target.startsWith('github:') && installed[target] !== undefined) return target

  const repository = parseGitHubSource(plugin.url)
  if (repository === null) return null
  const wantedPath = plugin.id.split('/').slice(2).join('/').toLowerCase()
  const repositoryNeedle = `github:${repository}`.toLowerCase()
  for (const [name, spec] of Object.entries(installed)) {
    const normalized = spec.toLowerCase()
    if (!normalized.includes(repositoryNeedle)) continue
    const match = /[#&]path:\/*([^&]*)/.exec(normalized)
    const installedPath = (match?.[1] ?? '').replace(/\/+$/, '')
    if (installedPath === wantedPath) return name
  }
  return null
}

/** Map local dependencies to public catalog ids without exposing package specs. */
export function installedPluginIds(
  installed: Record<string, string>,
  plugins: RegistryPlugin[],
): string[] {
  return plugins
    .filter(plugin => installedPackageName(plugin, installed) !== null)
    .map(plugin => plugin.id)
}

function cliInvocation(): InstallInvocation {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const absoluteEntry = resolve(entry)
    return {
      file: process.execPath,
      prefixArgs: [...process.execArgv, absoluteEntry],
      cwd: dirname(absoluteEntry),
      useShell: false,
    }
  }
  return { file: 'dsh', prefixArgs: [], useShell: process.platform === 'win32' }
}

function failureCode(result: CommandResult): string {
  if (result.timedOut) return 'TIMED_OUT'
  if (result.exitCode === 127) return 'SPAWN_FAILED'
  return 'OFFICIAL_CLI_FAILED'
}

function pluginEventId(plugin: RegistryPlugin): string {
  // The full id, so a monorepo subpackage's installs are counted against that
  // plugin rather than folded onto its repository or a sibling.
  return plugin.id.toLowerCase()
}

/** Run one plugin mutation through the shared async runner, tracking progress. */
async function runTrackedPluginCommand(
  profile: string,
  action: 'install' | 'update' | 'uninstall',
  target: string,
  progress: Progress,
  extraArgs: string[] = [],
): Promise<CommandResult> {
  progress.active = true
  progress.action = action
  progress.target = target
  progress.startedAt = Date.now()
  progress.lastLine = ''
  try {
    const pnpmStoreDir = readProfilePnpmStoreDir(profileDirectory(profile))
    const result = await runPluginCommand({
      invocation: cliInvocation(),
      action: action === 'uninstall' ? 'remove' : 'add',
      profile,
      target,
      extraArgs,
      stdio: 'capture',
      timeoutMs: COMMAND_TIMEOUT_MS,
      env: {
        ...process.env,
        CI: 'true',
        ...(pnpmStoreDir === undefined ? {} : {
          npm_config_store_dir: pnpmStoreDir,
          PNPM_STORE_DIR: pnpmStoreDir,
        }),
      },
      onLine: line => { progress.lastLine = line },
    })
    if (result.error !== null) {
      return { exitCode: 127, timedOut: false, stdout: result.stdout, stderr: `${result.stderr}\n${result.error}` }
    }
    return { exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr }
  } finally {
    progress.active = false
    progress.action = null
  }
}

/** Run one plugin mutation and report its outcome anonymously (fire-and-forget). */
async function runReportedPluginCommand(
  profile: string,
  pluginId: string,
  action: 'install' | 'update' | 'uninstall',
  target: string,
  progress: Progress,
  extraArgs: string[] = [],
  versions: { beforeVersion?: string | null; afterVersion?: string | null } = {},
): Promise<CommandResult> {
  const startedAt = new Date()
  const result = await runTrackedPluginCommand(profile, action, target, progress, extraArgs)
  const completedAt = new Date()
  const succeeded = result.exitCode === 0 && !result.timedOut
  void reportInstallEvent({
    pluginId,
    profile,
    operation: action === 'uninstall' ? 'remove' : action,
    status: succeeded ? 'success' : 'failed',
    startedAt,
    completedAt,
    errorCode: succeeded ? null : failureCode(result),
    ...versions,
  })
  return result
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(value))
}

function sendBrandIcon(response: ServerResponse): void {
  response.writeHead(200, {
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': String(BRAND_ICON.byteLength),
    'content-type': 'image/png',
  })
  response.end(BRAND_ICON)
}

function isPrivateNetworkHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.local')) return true
  const family = isIP(normalized)
  if (family === 4) {
    const octets = normalized.split('.').map(Number)
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31)
      || (octets[0] === 192 && octets[1] === 168)
  }
  if (family === 6) {
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized)
  }
  return false
}

export function isTrustedSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || host === undefined) return false
  try {
    const url = new URL(origin)
    return url.host === host && isPrivateNetworkHostname(url.hostname)
  } catch {
    return false
  }
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  return isTrustedSameOrigin(origin, host)
}

async function readJsonBody(request: IncomingMessage, limit: number = BODY_LIMIT_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function requireMethod(request: IncomingMessage, response: ServerResponse, method: 'GET' | 'POST'): boolean {
  if (request.method === method) return true
  response.writeHead(405, { allow: method })
  response.end()
  return false
}

function requireTrustedPost(request: IncomingMessage, response: ServerResponse): boolean {
  if (!requireMethod(request, response, 'POST')) return false
  if (isSameOrigin(request)) return true
  sendJson(response, 403, { error: 'untrusted origin' })
  return false
}

/**
 * Register the local market API and return a disposer for every route.
 * @param webServer - DSH web server service.
 * @param config - resolved profile and registry settings.
 * @returns a disposer that unregisters all market routes.
 */
export function mountMarketRoutes(webServer: WebServerService, config: MarketRouteConfig): () => void {
  if (!PROFILE_RE.test(config.profile)) throw new Error(`invalid profile name: ${config.profile}`)
  const registryUrl = new URL(config.registryUrl)
  if (registryUrl.protocol !== 'https:') throw new Error('registry API URL must use HTTPS')
  const updateUrl = new URL(config.updateUrl)
  if (updateUrl.protocol !== 'https:') throw new Error('update API URL must use HTTPS')
  const embedUrl = new URL(config.embedUrl)
  const loopbackEmbed = embedUrl.protocol === 'http:'
    && new Set(['localhost', '127.0.0.1', '[::1]']).has(embedUrl.hostname)
  if (embedUrl.username !== '' || embedUrl.password !== '') {
    throw new Error('embed URL cannot contain credentials')
  }
  if (embedUrl.protocol !== 'https:' && !loopbackEmbed) {
    throw new Error('embed URL must use HTTPS (loopback HTTP is allowed for development)')
  }

  let mutating = false
  const dshHome = resolveDshHome()
  const progress: Progress = { active: false, action: null, target: '', startedAt: 0, lastLine: '' }
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/icon',
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        sendBrandIcon(response)
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/embed-config',
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        sendJson(response, 200, { url: embedUrl.href, origin: embedUrl.origin })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/registry',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        try {
          // `?revalidate=1` is the panel asking for the current catalog behind
          // the copy it already rendered; everything else stays cache-first.
          const revalidate = /[?&]revalidate=1(?:&|$)/.test(request.url ?? '')
          const result = await loadRegistry(config.registryUrl, fetch, {
            revalidate,
            preferCache: !revalidate,
            dshHome,
          })
          sendJson(response, 200, result)
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/catalog-page-cache',
      handler: async (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, { page: await readCatalogPageCache(dshHome) })
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'GET, POST' })
          response.end()
          return
        }
        if (!requireTrustedPost(request, response)) return
        try {
          const body = await readJsonBody(request, CATALOG_CACHE_BODY_LIMIT_BYTES) as { page?: unknown }
          await writeCatalogPageCache(dshHome, body.page)
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/update',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        sendJson(response, 200, await checkForUpdate(config.updateUrl))
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/installed',
      handler: async (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        const installed = readInstalled(config.profile)
        let registry: Registry | null = null
        let registryError: string | null = null
        try {
          ;({ registry } = await loadRegistry(config.registryUrl, fetch, { dshHome }))
        } catch (error) {
          registryError = error instanceof Error ? error.message : String(error)
        }
        if (registry === null) {
          // The registry is unreachable and no last-good cache exists. Report
          // the local install state with an empty catalog mapping instead of
          // failing the whole panel with 503, so the installed plugins stay
          // visible (issue #159).
          sendJson(response, 200, {
            profile: config.profile,
            installed,
            pluginIds: [],
            plugins: [],
            registryError,
          })
          return
        }
        const pluginIds = installedPluginIds(installed, registry.plugins)
        const idSet = new Set(pluginIds)
        const categoryLabels = new Map(registry.categories.map(category => [category.id, category.label]))
        sendJson(response, 200, {
          profile: config.profile,
          installed,
          pluginIds,
          plugins: registry.plugins.filter(plugin => idSet.has(plugin.id)).map(plugin => ({
            id: plugin.id,
            name: plugin.name,
            owner: plugin.owner,
            url: plugin.url,
            category: plugin.category,
            categoryLabel: categoryLabels.get(plugin.category) ?? {},
            description: plugin.description,
            install: plugin.install,
            added: plugin.added,
            stars: plugin.stars ?? null,
          })),
          ...(registryError === null ? {} : { registryError }),
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/status',
      handler: (request, response) => {
        if (!requireMethod(request, response, 'GET')) return
        sendJson(response, 200, {
          ...progress,
          seconds: progress.active ? Math.round((Date.now() - progress.startedAt) / 1000) : 0,
          installed: readInstalled(config.profile),
        })
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/self-update',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        if (mutating) {
          sendJson(response, 409, { error: 'another plugin operation is already running' })
          return
        }
        try {
          const update = await checkForUpdate(config.updateUrl)
          if (!update.checked || update.latestVersion === null) {
            sendJson(response, 503, { error: update.error ?? 'update service unavailable', update })
            return
          }
          if (!update.updateAvailable) {
            sendJson(response, 200, { ok: true, updated: false, update })
            return
          }
          mutating = true
          try {
            const result = await runReportedPluginCommand(
              config.profile,
              'imsai-sh/awesome-deepseek-harness-plugins',
              'update',
              `dsh1024@${update.latestVersion}`,
              progress,
              [],
              { beforeVersion: update.currentVersion, afterVersion: update.latestVersion },
            )
            const ok = result.exitCode === 0 && !result.timedOut
            sendJson(response, ok ? 200 : 502, { ok, updated: ok, update, ...result })
          } finally {
            mutating = false
          }
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/install',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        if (mutating) {
          sendJson(response, 409, { error: 'another plugin operation is already running' })
          return
        }
        try {
          // Resolved by id: a repository URL is no longer unique now that one
          // monorepo can contribute several plugins.
          const body = await readJsonBody(request) as { id?: unknown }
          const requestedId = typeof body.id === 'string' ? body.id.toLowerCase() : ''
          const { registry } = await loadRegistry(config.registryUrl, fetch, { dshHome })
          const plugin = registry.plugins.find(entry => entry.id.toLowerCase() === requestedId)
          if (plugin === undefined) {
            sendJson(response, 400, { error: 'plugin is not in the 1024 Store registry' })
            return
          }
          const target = installTarget(plugin)
          mutating = true
          try {
            const result = await runReportedPluginCommand(
              config.profile,
              pluginEventId(plugin),
              'install',
              target,
              progress,
              installExtraArgs(plugin),
            )
            const ok = result.exitCode === 0 && !result.timedOut
            sendJson(response, ok ? 200 : 502, {
              ok,
              ...result,
              installed: readInstalled(config.profile),
            })
          } finally {
            mutating = false
          }
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    webServer.register({
      kind: 'exact',
      path: '/dsh1024/uninstall',
      handler: async (request, response) => {
        if (!requireTrustedPost(request, response)) return
        if (mutating) {
          sendJson(response, 409, { error: 'another plugin operation is already running' })
          return
        }
        try {
          const body = await readJsonBody(request) as { name?: unknown }
          const name = typeof body.name === 'string' ? body.name : ''
          if (!PACKAGE_RE.test(name) || name === 'dsh1024') {
            sendJson(response, 400, { error: 'plugin cannot be uninstalled here' })
            return
          }
          const installed = readInstalled(config.profile)
          const installedSpec = installed[name]
          if (installedSpec === undefined) {
            sendJson(response, 400, { error: 'plugin is not installed' })
            return
          }
          const { registry } = await loadRegistry(config.registryUrl, fetch, { dshHome })
          // Prefer the plugin whose github:owner/repo target appears in the installed
          // manifest spec so telemetry is attributed to the actually-installed plugin;
          // fall back to the display-name match only for the catalog-membership gate
          // (display names are not unique across the catalog — same-named forks exist).
          const cataloged = registry.plugins.find(plugin =>
            installedSpec.toLowerCase().includes(installTarget(plugin).toLowerCase()))
            ?? registry.plugins.find(plugin => plugin.name === name)
          if (cataloged === undefined) {
            sendJson(response, 400, { error: 'plugin is not in the 1024 Store registry' })
            return
          }
          mutating = true
          try {
            const result = await runReportedPluginCommand(
              config.profile,
              pluginEventId(cataloged),
              'uninstall',
              name,
              progress,
            )
            const ok = result.exitCode === 0 && !result.timedOut
            sendJson(response, ok ? 200 : 502, {
              ok,
              ...result,
              installed: readInstalled(config.profile),
            })
          } finally {
            mutating = false
          }
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  ]

  return () => {
    for (const dispose of disposers) dispose()
  }
}
