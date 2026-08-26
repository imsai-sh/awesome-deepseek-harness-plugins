# Catalog data sources

## Production data flow

The catalog in production D1 is fed from two directions:

- **Curated entries** — the checked-in `catalog/plugins/*.json` files contributed through
  pull requests. GitHub CI pushes them into D1 through `POST /api/v1/catalog/sync` after
  every merge to `main`. This is the only collection path that runs from this repository.
- **Discovery facts** — GitHub repositories carrying the `dsh-plugin` topic, plus the
  git/npm inspection results that back install verification. These are maintained by
  out-of-band collection jobs operated by the maintainer; **none of that tooling runs inside
  this Worker**, which is why `apps/web` contains no scheduled tasks and its Wrangler
  configuration declares no Cron Triggers. The jobs write to the same D1 database directly.

```text
out-of-band collection (topic scan, git/npm inspection) ─┐
                                                         ├─> D1 catalog ─> KV snapshot ─> /api/v1/*
checked-in PR catalog ──> CI POST /api/v1/catalog/sync ──┘
```

Nothing is bundled into the Worker: reads serve the KV snapshot, fresh or stale, without
touching D1 — the snapshot is rebuilt only by the catalog-sync endpoint, or once on a cold
start when the KV namespace is empty. Stale KV is the only degradation mode. External consumers read the same D1-backed catalog through
`GET /api/v1/registry` — capped at its install-ranked head (see [API reference](api.md)).

## Data model

D1 holds two tables: `catalog_repositories` (one row per GitHub repository) and
`catalog_plugins` (one row per plugin, referencing its repository). A GitHub numeric
repository ID is the stable identity across renames, and the normalized `owner/repository`
key deduplicates rows before that ID is known. A plugin's public id is
`owner/repository`, or `owner/repository/sub/dir` for a monorepo subpackage, so one
repository may host several plugins.

Plugin identity is **not** enforced unique (migration `0013`). The id embeds a GitHub
repository name, a fact this catalog does not control: when a repository is renamed, the
existing row keeps its pre-rename id while a curated entry may legitimately re-introduce
the same id under the old name. Both rows are allowed to coexist — readers order
deterministically, and rows whose repository no longer resolves are garbage-collected out
of band. Enforcing uniqueness here is what used to let a single renamed repository wedge
the entire catalog sync (issue #90).

Which channel found a plugin is a column, not a table: `from_topic` on the repository (the
scan discovers repositories) and `from_pr` on the plugin (a submission contributes one
plugin). Column ownership decides who may overwrite what — `curated_*` only from a
submission, `github_*`/`git_*`/`npm_*` only from collection — so a refresh cannot clobber a
reviewed description. If both sources cover the same plugin id, GitHub owns repository
facts and PR metadata owns the display name, category, bilingual descriptions, and added
date; curated subdirectory entries with other paths coexist as separate plugins of the same
repository. Repository-level metrics (stars, forks, growth, star history) are shared by all
plugins of a repository, while install metrics are keyed by full plugin id.

Topic-only repositories are published after static validation and use the `unclassified`
category until curated metadata is added. PR-only repositories remain published, so losing a
topic never silently removes a maintainer-approved entry.

## Install method inference

Install methods are derived from facts recorded by the collection jobs; nothing installs or
executes third-party plugins, here or there. GitHub inspection records whether the declared
entry point is committed and whether `prepare` exists. npm inspection fetches the latest
manifest for the exact package name declared by the repository and records whether it
declares `dsh.bundle`.

- A published npm package whose latest manifest declares `dsh.bundle` is a verified method
  and the only one OFFERED to users. Its `repository` field is diagnostic only: a missing,
  stale, or different backlink does not change npm verification.
- The GitHub source method stays derived and recorded — a committed entry, a carrier package
  with no declared entry, or an entry produced by `prepare` is statically considered loadable —
  but no user-facing surface currently offers it: its `--allow-build` grant quoted a
  repository-author-controlled package name, and one unvalidatable value invalidated the whole
  registry for every store client (issue #159). A plugin without a published npm package is
  therefore listed browse-only. Re-opening source installs later is a display-layer decision;
  the collected data already supports it.

“Verified” means the static evidence supports a loadable installation path. It is not a runtime
test, compatibility guarantee, quality rating, or security review.

## Deployment and operations

The configured D1 database is `dsh-store-star-history`; it stores both star history and the
primary catalog. Apply migrations before deploying:

```bash
npm ci
npm run typecheck
npm test
npx wrangler d1 export CATALOG_DB --remote --output=catalog-backup-$(date +%Y%m%d-%H%M).sql
npm run db:migrate:remote --workspace @dsh-1024store/web
npm run deploy
```

Nothing deploys on a push: publishing is this local sequence, run deliberately.

Take the export before every migration and check that it restores (`sqlite3 tmp.db < backup.sql`).
It is the only way back: a Worker cannot read a schema it predates, so rolling one back means
rolling back both.

`GITHUB_TOKEN` must be a Cloudflare Worker secret, never a Wrangler plaintext variable or a
committed `.dev.vars` value; the plugin detail endpoint uses it to read repository metadata.
