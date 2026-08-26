/** Fetch and validate the public 1024 Store registry API. */
import { readJson, storePaths, writeJsonAtomic } from './shared/files.js';
export const DEFAULT_REGISTRY_URL = 'https://deepseek1024.com/api/v1/registry';
const CACHE_TTL_MS = 5 * 60 * 1000;
const PERSISTED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
// Revalidation URLs carry a coarse timestamp so a stale CDN copy cannot answer
// them, while a whole minute of revalidations still collapses onto one URL.
const REVALIDATE_WINDOW_MS = 60_000;
let cache = null;
// One network refresh at a time: opening the panel twice, or opening it while a
// visibility-triggered refresh is still running, must not stack up requests.
let inFlight = null;
let hydration = null;
function isStringMap(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    return Object.values(value).every(item => typeof item === 'string');
}
function isCategory(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const category = value;
    return typeof category.id === 'string'
        && typeof category.order === 'number'
        && isStringMap(category.label);
}
function isPlugin(value, categoryIds) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const plugin = value;
    if (!(typeof plugin.id === 'string'
        && typeof plugin.name === 'string'
        && typeof plugin.owner === 'string'
        && typeof plugin.url === 'string'
        && parseGitHubSource(plugin.url) !== null
        && typeof plugin.category === 'string'
        && categoryIds.has(plugin.category)
        && isStringMap(plugin.description)
        && typeof plugin.install === 'string'
        && typeof plugin.added === 'string'
        && (plugin.stars === undefined || plugin.stars === null || typeof plugin.stars === 'number')))
        return false;
    try {
        validatedInstallTarget(plugin);
        installExtraArgs(plugin);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Validate untrusted registry JSON before it can become an installation allowlist.
 *
 * Per-entry validation filters rather than rejects: one malformed entry used
 * to invalidate the whole registry, and every client answered 503 until the
 * catalog was fixed (issue #159). The per-entry checks themselves stay strict
 * — a skipped entry is simply not in the allowlist — and skipped ids are
 * logged so a data problem stays visible instead of silently shrinking the
 * store. Registry-level corruption (bad metadata, a count that disagrees with
 * the payload, nothing valid at all) still throws.
 * @param value - parsed `/api/v1/registry` response.
 * @returns the validated registry, restricted to its valid plugins.
 */
export function validateRegistry(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('registry must be an object');
    }
    const registry = value;
    if (typeof registry.name !== 'string' || typeof registry.updated !== 'string' || typeof registry.count !== 'number') {
        throw new Error('registry metadata is invalid');
    }
    if (!Array.isArray(registry.categories) || !registry.categories.every(isCategory)) {
        throw new Error('registry categories are invalid');
    }
    const categoryIds = new Set(registry.categories.map(category => category.id));
    if (!Array.isArray(registry.plugins) || registry.plugins.length === 0) {
        throw new Error('registry plugins are empty');
    }
    // Checked against the raw array: the count guards against a truncated or
    // corrupted payload, which filtering must not paper over.
    if (registry.count !== registry.plugins.length)
        throw new Error('registry count does not match plugins');
    const plugins = registry.plugins.filter(plugin => isPlugin(plugin, categoryIds));
    if (plugins.length === 0)
        throw new Error('registry contains no valid plugins');
    const skipped = registry.plugins.length - plugins.length;
    if (skipped > 0) {
        const skippedIds = registry.plugins
            .filter(plugin => !plugins.includes(plugin))
            .map(plugin => (plugin !== null && typeof plugin === 'object' && typeof plugin.id === 'string')
            ? plugin.id
            : '<malformed>');
        console.warn(`[dsh1024] skipped ${skipped} invalid registry entr${skipped === 1 ? 'y' : 'ies'}: ${skippedIds.slice(0, 10).join(', ')}${skippedIds.length > 10 ? ', …' : ''}`);
    }
    const validated = { ...registry, count: plugins.length, plugins };
    // The additive full-catalog size is display-only and survives validation
    // only as a sane number; anything else is dropped rather than trusted.
    if (!(typeof validated.total === 'number' && Number.isInteger(validated.total) && validated.total >= 0)) {
        delete validated.total;
    }
    return validated;
}
/**
 * Parse the only repository URL form accepted by the installer.
 * @param url - curated plugin repository URL.
 * @returns the GitHub owner/repository pair, or null for an unsupported URL.
 */
export function parseGitHubSource(url) {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?$/.exec(url);
    return match?.[1] ?? null;
}
const ID_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
/**
 * The plugin's in-repo directory, taken from its id and cross-checked against
 * the repository URL. A monorepo subpackage's id extends its repository with
 * the directory the plugin lives in.
 * @param id - curated plugin id.
 * @param repository - owner/repository parsed from the plugin's URL.
 * @returns the subdirectory, or `''` for a repository-level plugin.
 */
export function pluginSubPath(id, repository) {
    const segments = id.split('/');
    if (segments.length < 2)
        throw new Error('unsupported plugin id');
    if (segments.slice(0, 2).join('/').toLowerCase() !== repository.toLowerCase()) {
        throw new Error('plugin id does not match its repository URL');
    }
    const rest = segments.slice(2);
    if (!rest.every(segment => ID_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
        throw new Error('unsupported plugin subdirectory');
    }
    return rest.join('/');
}
/** Derive the immutable GitHub fallback without trusting display copy. */
function githubInstallTarget(plugin) {
    const repository = parseGitHubSource(plugin.url);
    if (repository === null)
        throw new Error('unsupported plugin repository URL');
    const subPath = pluginSubPath(plugin.id, repository);
    return subPath === '' ? `github:${repository}` : `github:${repository}#path:${subPath}`;
}
/** Derive a structured GitHub target from the catalog id itself. */
function githubInstallTargetFromId(id) {
    const segments = id.split('/');
    if (segments.length < 2 || !segments.every(segment => ID_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
        throw new Error('unsupported plugin id');
    }
    const repository = segments.slice(0, 2).join('/');
    const subPath = segments.slice(2).join('/');
    return subPath === '' ? `github:${repository}` : `github:${repository}#path:${subPath}`;
}
function validatedInstallTarget(plugin) {
    if (plugin.target !== undefined && typeof plugin.target !== 'string') {
        throw new Error('install target must be a string');
    }
    // Older registry responses have no structured target, so their safe
    // fallback still comes from the repository URL cross-checked against id.
    if (plugin.target === undefined)
        return githubInstallTarget(plugin);
    const target = plugin.target;
    if (target.startsWith('github:')) {
        const expected = githubInstallTargetFromId(plugin.id);
        const [targetRepository, targetPath = ''] = target.slice('github:'.length).split('#path:');
        const [expectedRepository, expectedPath = ''] = expected.slice('github:'.length).split('#path:');
        if (targetRepository?.toLowerCase() !== expectedRepository?.toLowerCase() || targetPath !== expectedPath) {
            throw new Error('install target does not match plugin id');
        }
        return target;
    }
    if (!PACKAGE_NAME.test(target))
        throw new Error('unsupported npm install target');
    return target;
}
/** Return the server-derived preferred target after constraining its grammar. */
export function installTarget(plugin) {
    return validatedInstallTarget(plugin);
}
/** Extra official CLI arguments needed by the preferred install method. */
export function installExtraArgs(plugin) {
    const allowance = plugin.allowBuild;
    if (allowance === undefined || allowance === null)
        return [];
    if (typeof allowance !== 'string')
        throw new Error('build allowance must be a string');
    if (!PACKAGE_NAME.test(allowance))
        throw new Error('unsupported build allowance');
    if (!installTarget(plugin).startsWith('github:'))
        throw new Error('npm installs cannot request a source build allowance');
    return [`--allow-build=${allowance}`];
}
/** Clear process-local registry state for deterministic tests. */
export function clearRegistryCache() {
    cache = null;
    inFlight = null;
    hydration = null;
}
function hydrateRegistryCache(path, registryUrl) {
    if (hydration?.path === path)
        return hydration.promise;
    const promise = (async () => {
        try {
            const persisted = await readJson(path, null);
            if (persisted === null || persisted.version !== 1 || persisted.url !== registryUrl
                || typeof persisted.fetchedAt !== 'number' || !Number.isFinite(persisted.fetchedAt)
                || persisted.fetchedAt > Date.now() + CACHE_TTL_MS
                || Date.now() - persisted.fetchedAt > PERSISTED_CACHE_MAX_AGE_MS)
                return;
            cache = {
                url: registryUrl,
                at: persisted.fetchedAt,
                registry: validateRegistry(persisted.registry),
                persisted: true,
            };
        }
        catch {
            // A missing, partial, old, or manually edited cache is non-fatal. The
            // validated network response remains the only source that can replace it.
        }
    })();
    hydration = { path, promise };
    return promise;
}
async function fetchRegistry(registryUrl, fetcher, bustEdgeCache, cachePath) {
    const url = new URL(registryUrl);
    if (url.protocol !== 'https:')
        throw new Error('registry API URL must use HTTPS');
    if (bustEdgeCache)
        url.searchParams.set('t', String(Math.floor(Date.now() / REVALIDATE_WINDOW_MS)));
    const response = await fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`registry API HTTP ${response.status}`);
    const registry = validateRegistry(await response.json());
    const fetchedAt = Date.now();
    cache = { url: registryUrl, at: fetchedAt, registry, persisted: false };
    if (cachePath !== null) {
        await writeJsonAtomic(cachePath, {
            version: 1,
            url: registryUrl,
            fetchedAt,
            registry,
        }).catch(() => { });
    }
    return registry;
}
function refresh(registryUrl, fetcher, bustEdgeCache, cachePath) {
    if (inFlight !== null && inFlight.url === registryUrl)
        return inFlight.promise;
    const promise = fetchRegistry(registryUrl, fetcher, bustEdgeCache, cachePath).finally(() => {
        if (inFlight?.promise === promise)
            inFlight = null;
    });
    inFlight = { url: registryUrl, promise };
    return promise;
}
/**
 * Load the registry from the configured HTTPS API, with a last-good response cache.
 *
 * The default path stays cache-first so rendering the panel never waits on the
 * network. `revalidate` is the stale-while-revalidate half: the caller already
 * has something on screen and wants the current catalog behind it.
 * @param registryUrl - public 1024 Store registry API endpoint.
 * @param fetcher - injectable fetch implementation for deterministic tests.
 * @param options - set `revalidate` to force a network read.
 * @returns the registry and whether it is fresh API data or a stale fallback cache.
 */
export async function loadRegistry(registryUrl = DEFAULT_REGISTRY_URL, fetcher = fetch, options = {}) {
    const cachePath = options.dshHome === undefined ? null : storePaths(options.dshHome).registryCache;
    if (cachePath !== null)
        await hydrateRegistryCache(cachePath, registryUrl);
    const cached = cache !== null && cache.url === registryUrl ? cache : null;
    if (options.revalidate !== true && cached !== null
        && (options.preferCache === true || Date.now() - cached.at < CACHE_TTL_MS)) {
        return { registry: cached.registry, source: cached.persisted ? 'cache' : 'api' };
    }
    try {
        const registry = await refresh(registryUrl, fetcher, options.revalidate === true, cachePath);
        return { registry, source: 'api' };
    }
    catch (error) {
        // Last-good fallback: an offline machine keeps browsing what it already has.
        if (cached !== null)
            return { registry: cached.registry, source: 'cache' };
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`registry API unavailable: ${detail}`);
    }
}
