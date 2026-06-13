-- Add stable platform identity for one student in one school/provider.
ALTER TABLE "UserSchoolBinding" ADD COLUMN "studentNoHash" TEXT;

CREATE UNIQUE INDEX "UserSchoolBinding_schoolId_providerId_studentNoHash_key"
ON "UserSchoolBinding"("schoolId", "providerId", "studentNoHash");
