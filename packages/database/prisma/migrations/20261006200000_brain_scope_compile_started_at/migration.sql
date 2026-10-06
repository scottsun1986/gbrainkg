-- BrainScopeService 已提交代码引用 compileStartedAt（标记编译起点、清扫卡在
-- compiling 的陈旧 scope），但 schema 与数据库一直缺该列，运行时持续报
-- "Unknown argument `compileStartedAt`"。补齐列定义。
ALTER TABLE "BrainScope" ADD COLUMN IF NOT EXISTS "compileStartedAt" TIMESTAMP(3);
