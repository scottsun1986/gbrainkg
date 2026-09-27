-- These shared identity and organization tables are intentionally outside
-- tenant RLS. Application authorization is enforced by PermissionService;
-- content tables retain RLS. Reassert after GBrain engine migrations, whose
-- DDL hook may enable RLS on every newly managed relation.
ALTER TABLE "Role" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "User" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgNode" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "UserOrg" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRole" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgAdmin" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "KbAdmin" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "IndustryGrant" DISABLE ROW LEVEL SECURITY;
