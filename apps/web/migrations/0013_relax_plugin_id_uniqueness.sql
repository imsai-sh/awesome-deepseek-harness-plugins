-- Drop UNIQUE(normalized_plugin_id).
--
-- The constraint assumed one plugin identity maps to exactly one row forever,
-- but the identity comes from a GitHub repository name — a fact this catalog
-- does not control. When a repository is renamed, the old row keeps the old id
-- while a curated entry (or a re-submission) legitimately re-introduces the
-- same id under the old name, and the resulting UNIQUE violation aborted the
-- whole sync batch: one renamed repository froze catalog updates for everyone.
--
-- The new stance: identity collisions are data, not errors. A rename may leave
-- two rows that look like the same plugin for a while; readers order
-- deterministically, and stale rows whose repository no longer resolves are
-- garbage-collected later. Nothing in the write path enforces global
-- uniqueness anymore.
--
-- SQLite cannot drop an inline UNIQUE constraint, so the table is rebuilt.
-- No other table references catalog_plugins by foreign key (community tables
-- store normalized_plugin_id as plain text), so the rebuild is self-contained.

CREATE TABLE catalog_plugins_v2 (
  repository_id INTEGER NOT NULL
    REFERENCES catalog_repositories (id) ON DELETE CASCADE,

  plugin_id            TEXT NOT NULL,
  -- Still indexed for lookups, no longer UNIQUE: see the header comment.
  normalized_plugin_id TEXT NOT NULL,
  plugin_path          TEXT NOT NULL DEFAULT '',

  from_pr      INTEGER NOT NULL DEFAULT 0 CHECK (from_pr IN (0, 1)),
  pr_reference TEXT,

  curated_name           TEXT,
  curated_category       TEXT,
  curated_description_en TEXT,
  curated_description_zh TEXT,
  curated_added          TEXT,
  curated_updated_at     TEXT,

  manifest_path       TEXT,
  package_name        TEXT,
  package_version     TEXT,
  bundle_patch        TEXT,
  git_entry_point     TEXT,
  git_entry_committed INTEGER NOT NULL DEFAULT 0 CHECK (git_entry_committed IN (0, 1)),
  git_has_prepare     INTEGER NOT NULL DEFAULT 0 CHECK (git_has_prepare IN (0, 1)),
  git_status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (git_status IN ('pending', 'ok', 'absent', 'error')),
  git_code            TEXT,
  git_reason          TEXT,
  git_head_sha        TEXT,
  git_checked_at      TEXT,

  npm_package_name         TEXT,
  npm_version              TEXT,
  npm_repository_url       TEXT,
  npm_repository_directory TEXT,
  npm_bundle_declared      INTEGER NOT NULL DEFAULT 0 CHECK (npm_bundle_declared IN (0, 1)),
  npm_binding              TEXT NOT NULL DEFAULT 'unknown'
    CHECK (npm_binding IN ('strict', 'name_only', 'mismatch', 'no_bundle', 'absent', 'unknown')),
  npm_status               TEXT NOT NULL DEFAULT 'pending'
    CHECK (npm_status IN ('pending', 'found', 'absent', 'error')),
  npm_http_status          INTEGER,
  npm_checked_at           TEXT,

  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'accepted', 'rejected', 'error')),
  validation_code   TEXT,
  validation_reason TEXT,

  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  -- Columns appended by 0006 (AI classification), 0010 (npm etag) and
  -- 0011 (npm downloads), carried over verbatim.
  ai_category           TEXT,
  ai_description_en     TEXT,
  ai_description_zh     TEXT,
  ai_description_origin TEXT,
  ai_classifier_version TEXT,
  ai_classified_at      TEXT,
  npm_etag              TEXT,
  npm_downloads_7d      INTEGER
    CHECK (npm_downloads_7d IS NULL OR npm_downloads_7d >= 0),
  npm_downloads_start      TEXT,
  npm_downloads_end        TEXT,
  npm_downloads_status     TEXT NOT NULL DEFAULT 'pending'
    CHECK (npm_downloads_status IN ('pending', 'found', 'error')),
  npm_downloads_checked_at TEXT,

  PRIMARY KEY (repository_id, plugin_path)
);

INSERT INTO catalog_plugins_v2 (
  repository_id, plugin_id, normalized_plugin_id, plugin_path,
  from_pr, pr_reference,
  curated_name, curated_category, curated_description_en, curated_description_zh,
  curated_added, curated_updated_at,
  manifest_path, package_name, package_version, bundle_patch,
  git_entry_point, git_entry_committed, git_has_prepare,
  git_status, git_code, git_reason, git_head_sha, git_checked_at,
  npm_package_name, npm_version, npm_repository_url, npm_repository_directory,
  npm_bundle_declared, npm_binding, npm_status, npm_http_status, npm_checked_at,
  validation_status, validation_code, validation_reason,
  first_seen_at, last_seen_at, created_at, updated_at,
  ai_category, ai_description_en, ai_description_zh,
  ai_description_origin, ai_classifier_version, ai_classified_at,
  npm_etag,
  npm_downloads_7d, npm_downloads_start, npm_downloads_end,
  npm_downloads_status, npm_downloads_checked_at
)
SELECT
  repository_id, plugin_id, normalized_plugin_id, plugin_path,
  from_pr, pr_reference,
  curated_name, curated_category, curated_description_en, curated_description_zh,
  curated_added, curated_updated_at,
  manifest_path, package_name, package_version, bundle_patch,
  git_entry_point, git_entry_committed, git_has_prepare,
  git_status, git_code, git_reason, git_head_sha, git_checked_at,
  npm_package_name, npm_version, npm_repository_url, npm_repository_directory,
  npm_bundle_declared, npm_binding, npm_status, npm_http_status, npm_checked_at,
  validation_status, validation_code, validation_reason,
  first_seen_at, last_seen_at, created_at, updated_at,
  ai_category, ai_description_en, ai_description_zh,
  ai_description_origin, ai_classifier_version, ai_classified_at,
  npm_etag,
  npm_downloads_7d, npm_downloads_start, npm_downloads_end,
  npm_downloads_status, npm_downloads_checked_at
FROM catalog_plugins;

DROP TABLE catalog_plugins;
ALTER TABLE catalog_plugins_v2 RENAME TO catalog_plugins;

CREATE INDEX catalog_plugins_published_idx ON catalog_plugins (from_pr, validation_status);
CREATE INDEX catalog_plugins_git_queue_idx ON catalog_plugins (git_status, git_checked_at);
CREATE INDEX catalog_plugins_npm_queue_idx ON catalog_plugins (npm_status, npm_checked_at);
CREATE INDEX catalog_plugins_ai_version_idx ON catalog_plugins (ai_classifier_version);
CREATE INDEX catalog_plugins_npm_downloads_queue_idx
  ON catalog_plugins (npm_downloads_checked_at, normalized_plugin_id);
-- Replaces the implicit UNIQUE index: same lookups, no uniqueness.
CREATE INDEX catalog_plugins_normalized_id_idx ON catalog_plugins (normalized_plugin_id);
