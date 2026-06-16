WITH ranked_course_cache AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "accountId", "sourceHash"
      ORDER BY "syncedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS row_number
  FROM "CourseCache"
)
DELETE FROM "CourseCache"
USING ranked_course_cache
WHERE "CourseCache"."id" = ranked_course_cache."id"
  AND ranked_course_cache.row_number > 1;

WITH ranked_feature_cache AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "accountId", "target", "sourceHash"
      ORDER BY "syncedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS row_number
  FROM "FeatureCache"
)
DELETE FROM "FeatureCache"
USING ranked_feature_cache
WHERE "FeatureCache"."id" = ranked_feature_cache."id"
  AND ranked_feature_cache.row_number > 1;

CREATE UNIQUE INDEX "CourseCache_accountId_sourceHash_key"
  ON "CourseCache"("accountId", "sourceHash");

CREATE INDEX "CourseCache_accountId_termId_syncedAt_idx"
  ON "CourseCache"("accountId", "termId", "syncedAt");

CREATE UNIQUE INDEX "FeatureCache_accountId_target_sourceHash_key"
  ON "FeatureCache"("accountId", "target", "sourceHash");

CREATE INDEX "FeatureCache_accountId_target_termId_syncedAt_idx"
  ON "FeatureCache"("accountId", "target", "termId", "syncedAt");

WITH ranked_active_sync AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "accountId", "target"
      ORDER BY COALESCE("startedAt", "createdAt") DESC, "createdAt" DESC, "id" DESC
    ) AS row_number
  FROM "SyncRecord"
  WHERE "status" IN ('pending', 'running')
)
UPDATE "SyncRecord"
SET
  "status" = 'cancelled',
  "errorCode" = 'DUPLICATE_SYNC_JOB',
  "errorMessage" = 'Cancelled duplicate active sync job during migration',
  "finishedAt" = COALESCE("finishedAt", CURRENT_TIMESTAMP)
FROM ranked_active_sync
WHERE "SyncRecord"."id" = ranked_active_sync."id"
  AND ranked_active_sync.row_number > 1;

CREATE UNIQUE INDEX "SyncRecord_active_account_target_key"
  ON "SyncRecord"("accountId", "target")
  WHERE "status" IN ('pending', 'running');

CREATE INDEX "SyncRecord_accountId_target_status_createdAt_idx"
  ON "SyncRecord"("accountId", "target", "status", "createdAt");

CREATE INDEX "SyncRecord_schoolId_target_status_createdAt_idx"
  ON "SyncRecord"("schoolId", "target", "status", "createdAt");
