-- A student number identifies one platform user within a school, regardless of provider.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DROP INDEX IF EXISTS "UserSchoolBinding_schoolId_providerId_studentNoHash_key";

UPDATE "UserSchoolBinding"
SET "studentNoHash" = encode(
  digest(
    "schoolId" || ':' || lower(trim(replace("studentNoEncrypted", 'masked:', ''))),
    'sha256'
  ),
  'hex'
)
WHERE "studentNoHash" IS NOT NULL
  AND "studentNoEncrypted" LIKE 'masked:%';

WITH ranked_bindings AS (
  SELECT
    "id",
    "userId",
    first_value("id") OVER binding_group AS "keeperBindingId",
    first_value("userId") OVER binding_group AS "keeperUserId",
    row_number() OVER binding_group AS "rank"
  FROM "UserSchoolBinding"
  WHERE "studentNoHash" IS NOT NULL
  WINDOW binding_group AS (
    PARTITION BY "schoolId", "studentNoHash"
    ORDER BY "updatedAt" DESC, "createdAt" ASC, "id" ASC
  )
),
duplicate_bindings AS (
  SELECT *
  FROM ranked_bindings
  WHERE "rank" > 1
)
UPDATE "CourseCache" cache
SET
  "bindingId" = duplicate_bindings."keeperBindingId",
  "userId" = duplicate_bindings."keeperUserId"
FROM duplicate_bindings
WHERE cache."bindingId" = duplicate_bindings."id";

WITH ranked_bindings AS (
  SELECT
    "id",
    "userId",
    first_value("id") OVER binding_group AS "keeperBindingId",
    first_value("userId") OVER binding_group AS "keeperUserId",
    row_number() OVER binding_group AS "rank"
  FROM "UserSchoolBinding"
  WHERE "studentNoHash" IS NOT NULL
  WINDOW binding_group AS (
    PARTITION BY "schoolId", "studentNoHash"
    ORDER BY "updatedAt" DESC, "createdAt" ASC, "id" ASC
  )
),
duplicate_bindings AS (
  SELECT *
  FROM ranked_bindings
  WHERE "rank" > 1
)
UPDATE "FeatureCache" cache
SET
  "bindingId" = duplicate_bindings."keeperBindingId",
  "userId" = duplicate_bindings."keeperUserId"
FROM duplicate_bindings
WHERE cache."bindingId" = duplicate_bindings."id";

WITH ranked_bindings AS (
  SELECT
    "id",
    "userId",
    first_value("id") OVER binding_group AS "keeperBindingId",
    first_value("userId") OVER binding_group AS "keeperUserId",
    row_number() OVER binding_group AS "rank"
  FROM "UserSchoolBinding"
  WHERE "studentNoHash" IS NOT NULL
  WINDOW binding_group AS (
    PARTITION BY "schoolId", "studentNoHash"
    ORDER BY "updatedAt" DESC, "createdAt" ASC, "id" ASC
  )
),
duplicate_bindings AS (
  SELECT *
  FROM ranked_bindings
  WHERE "rank" > 1
)
UPDATE "SyncRecord" record
SET
  "bindingId" = duplicate_bindings."keeperBindingId",
  "userId" = duplicate_bindings."keeperUserId"
FROM duplicate_bindings
WHERE record."bindingId" = duplicate_bindings."id";

WITH ranked_bindings AS (
  SELECT
    "id",
    "userId",
    first_value("id") OVER binding_group AS "keeperBindingId",
    first_value("userId") OVER binding_group AS "keeperUserId",
    row_number() OVER binding_group AS "rank"
  FROM "UserSchoolBinding"
  WHERE "studentNoHash" IS NOT NULL
  WINDOW binding_group AS (
    PARTITION BY "schoolId", "studentNoHash"
    ORDER BY "updatedAt" DESC, "createdAt" ASC, "id" ASC
  )
),
duplicate_bindings AS (
  SELECT *
  FROM ranked_bindings
  WHERE "rank" > 1
)
UPDATE "FeedbackItem" feedback
SET
  "bindingId" = duplicate_bindings."keeperBindingId",
  "userId" = duplicate_bindings."keeperUserId"
FROM duplicate_bindings
WHERE feedback."bindingId" = duplicate_bindings."id";

WITH ranked_bindings AS (
  SELECT
    "id",
    row_number() OVER binding_group AS "rank"
  FROM "UserSchoolBinding"
  WHERE "studentNoHash" IS NOT NULL
  WINDOW binding_group AS (
    PARTITION BY "schoolId", "studentNoHash"
    ORDER BY "updatedAt" DESC, "createdAt" ASC, "id" ASC
  )
)
DELETE FROM "UserSchoolBinding" binding
USING ranked_bindings
WHERE binding."id" = ranked_bindings."id"
  AND ranked_bindings."rank" > 1;

DELETE FROM "User" user_record
WHERE NOT EXISTS (
  SELECT 1
  FROM "UserSchoolBinding" binding
  WHERE binding."userId" = user_record."id"
);

CREATE UNIQUE INDEX "UserSchoolBinding_schoolId_studentNoHash_key"
ON "UserSchoolBinding"("schoolId", "studentNoHash");
