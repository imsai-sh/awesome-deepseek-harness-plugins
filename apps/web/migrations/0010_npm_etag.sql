-- The npm version was refreshed by the discovery cron behind a 7-day de-dup
-- window, so a package that published twice a day could sit up to a week stale.
-- The fast-refresh task re-checks every package on a tight cron instead, and the
-- only way that stays cheap against a public registry we do not own is the
-- conditional request: send the ETag of the last packument as `If-None-Match`
-- and npm answers `304 Not Modified` with an empty body when nothing published.
--
-- npm_etag  the ETag returned by the last full-packument fetch of
--           https://registry.npmjs.org/<name>. NULL means "no validator yet"
--           (never fetched, or the last result was 404/error), so the next probe
--           is an unconditional GET that then records the ETag. Only `found`
--           (200) and `absent` (404) results touch this column; an `error`
--           leaves it, exactly as it leaves the version and binding.

ALTER TABLE catalog_plugins ADD COLUMN npm_etag TEXT;
