/** Fetch and validate the public 1024 Store registry API. */
export interface RegistryCategory {
    id: string;
    order: number;
    label: Record<string, string>;
}
export interface RegistryPlugin {
    id: string;
    name: string;
    owner: string;
    url: string;
    category: string;
    description: Record<string, string>;
    install: string;
    /** Server-derived preferred package spec; absent on older registry responses. */
    target?: string;
    /** Package allowed to run a source-install build script. */
    allowBuild?: string | null;
    added: string;
    stars?: number | null;
}
export interface Registry {
    name: string;
    updated: string;
    count: number;
    /**
     * Full catalog size; absent on older registry responses. The API caps
     * `plugins` at an install-ranked head of the catalog, so `count` only says
     * how many entries were served — this is the number the store can display.
     */
    total?: number;
    categories: RegistryCategory[];
    plugins: RegistryPlugin[];
}
export type RegistrySource = 'api' | 'cache';
export declare const DEFAULT_REGISTRY_URL = "https://deepseek1024.com/api/v1/registry";
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
export declare function validateRegistry(value: unknown): Registry;
/**
 * Parse the only repository URL form accepted by the installer.
 * @param url - curated plugin repository URL.
 * @returns the GitHub owner/repository pair, or null for an unsupported URL.
 */
export declare function parseGitHubSource(url: string): string | null;
/**
 * The plugin's in-repo directory, taken from its id and cross-checked against
 * the repository URL. A monorepo subpackage's id extends its repository with
 * the directory the plugin lives in.
 * @param id - curated plugin id.
 * @param repository - owner/repository parsed from the plugin's URL.
 * @returns the subdirectory, or `''` for a repository-level plugin.
 */
export declare function pluginSubPath(id: string, repository: string): string;
/** Return the server-derived preferred target after constraining its grammar. */
export declare function installTarget(plugin: RegistryPlugin): string;
/** Extra official CLI arguments needed by the preferred install method. */
export declare function installExtraArgs(plugin: RegistryPlugin): string[];
/** Clear process-local registry state for deterministic tests. */
export declare function clearRegistryCache(): void;
export interface LoadRegistryOptions {
    /**
     * Go to the network even when the process cache is still fresh, and answer
     * with what comes back. Used when the store panel opens or becomes visible
     * again, so a newly listed plugin shows up without waiting out any TTL.
     */
    revalidate?: boolean;
    /** Return any validated disk snapshot immediately so the client can revalidate separately. */
    preferCache?: boolean;
    /** Enable the plugin-owned on-disk cache under this DSH home directory. */
    dshHome?: string;
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
export declare function loadRegistry(registryUrl?: string, fetcher?: typeof fetch, options?: LoadRegistryOptions): Promise<{
    registry: Registry;
    source: RegistrySource;
}>;
