# 158 项台账逐条对抗性复核（2026-10-06）

方法：把 `docs/FIX-TODO-2026-10-06.md` 中全部未勾选条目（158 项）按区域切成 10 组，各组由一名独立复核代理逐条判定。判定只认代码本身：注释、提交信息、报告里的"已修改"一律不算证据；对每个修复都追问「描述中的失败路径是否真的不可达」，并检查边界（空输入、非数值/拼错的env、NaN、并发、错误分支、缓存后撤权）。

判定口径：

- **CONFIRMED**：修复确实在代码里，且消除该缺陷。
- **PARTIAL**：只修了一部分，或只治症状。
- **NOT_FOUND**：没有找到该缺陷被处理的证据。
- **WRONG**：有改动但无效，或引入新问题。
- **REVIEW_CLOSED**：确属误报/重复/用户决定不执行，且理由成立。

## 结论

| 判定 | 数量 |
|---|---|
| CONFIRMED | 137 |
| PARTIAL | 13 |
| NOT_FOUND | 2 |
| REVIEW_CLOSED | 4 |
| 判定成立但依赖用户决定 | 2 |

本轮修复后：PARTIAL/NOT_FOUND 中有 9 项已在本轮修掉，其余转为「已登记的残余风险」或「需决策」。

## 本轮的复核修正（原报告或上一轮结论有误）

| 事项 | 原结论 | 复核结论 |
|---|---|---|
| H-16 | 台账写"代码已修改" | **修复无效**。守卫判定 `role.builtin`，而 `普通用户` 是 `builtin: false`（`permission/permissions.ts:28`），`PATCH /admin/roles/<普通用户 id> {"permissions":["*"]}` 仍可把全部基础用户提升为系统管理员。同一文件顶部注释早已写明"判定不得依赖 builtin 标记"。本轮修复。 |
| M-84 | 台账写"代码已修改" | **未修**。`20261003000000_force_rls_core_tenant_tables/verify.sql:59` 的存在性探测缺 `pg_namespace` 过滤，而紧随其后的 RLS 检查是带过滤的；其它 schema 里的同名表可让真实缺失的核心表被报成 SKIP。本轮修复。 |
| P1-4 | 台账写"代码修改或复核已记录"，复核代理判 NOT_FOUND | **部分成立**。`authorization-revision.ts` 确实未改，但新增迁移 `20261006160000` 已把触发器换成按字段判定的 `app_authority_row_changed()`：纯内容/展示元数据变更不再推进全局 revision。新安全 fixture 里 "Pure content or display metadata advanced global authority" 一项即为该断言，且已通过。剩余的是"权威变更仍会让在途请求失败"，属预期 fail-closed。 |
| C-05 / TI-04 / P1-1 | 原报告列为缺陷 | 与用户已记录的决定一致（默认发布不要求严格质量门禁、不生成真实校准），不计为未修。 |

## 本轮已修（9 项）

| 编号 | 缺陷 | 处置位置 |
|---|---|---|
| H-16 | 通配权限可授予非受保护角色 → 批量提权 | `admin.controller.ts`：新增 `assertWildcardReservedForProtectedRoles`，`createRole`/`updateRole` 均调用 |
| C-01 | 精确匹配路径导致 `/api/v1/admin/kbs/` 403 | `auth.guard.ts`：路径去尾斜杠后精确比较 |
| M-07 | `envNumber` 低于下限时改用 fallback，使 `GBRAIN_COMMAND_TIMEOUT_MS=10000` 静默变成 180000 | `gbrain-adapter/src/index.ts`：改回 `Math.max(floor, value)`，仅非有限值才 fallback |
| H-27 | `CHUNK_EMBEDDING_READ_BATCH` 非数值 → `LIMIT NaN` | `chunk-embedding.service.ts`：改用 `positiveNumber`（读写两个批量值） |
| M-84 | 存在性探测未过滤 schema | `verify.sql`：补 `pg_namespace` 条件 |
| L-01 | 压缩包白名单在写循环内抛错 → 混合压缩包部分入库 | `open-api.controller.ts`：写盘前先整包校验 |
| M-21 | 单条凭据解密失败使整张模型供应商列表 500 | `model-credential.ts`：`maskModelCredential` 按行降级为"无法解密·请检查 MODEL_CONFIG_KEY"（比较路径仍 fail-closed 抛出） |
| M-50 | ⌘K"新建个人库"首次点击无效 | `AppShell.tsx`：与 `paletteUpload` 一致改用挂载延迟 |
| M-45 / M-51 / M-71 / M-79 / M-31 | 多选框可提交空组织 id；Dream 分页失败吐错提示；解析器启动告警文案已过时；向量校验报错写死列名；合并单元格首个异常静默中止整表 | 分别修于 `UsersPanel.tsx`、`AdminScreen.tsx`、`parser-worker/src/main.py`、`gbrain-adapter/src/index.ts`、`parser-worker/src/main.py` |

另修一处配置转发缺口（M-61 同类）：`deploy/production.env.example` 声明了 `PARSER_MAX_INFLIGHT=64` 等，但 `docker-compose.prod.yml` 的 parser 服务从未转发，容器实际跑代码默认值 16。已在 compose 中补齐 `PARSER_MAX_TASKS/PARSER_MAX_INFLIGHT/PARSER_MAX_TEMP_BYTES/PARSER_TASK_STALE_SECONDS/LEGACY_WORD_MAX_BYTES`。

## 已登记的残余风险（未修，需决策或不适合本轮盲改）

| 编号 | 残余 | 为何未在本轮修 |
|---|---|---|
| C-04 | 原报告点名的约 20 张租户表中，仍有约 12 张未启用 RLS 且持有完整 DML 授权（`User`、`UserRole`、`Role`、`OrgNode`、`OrgAdmin`、`KbAdmin`、`IndustryGrant`、`SystemSetting`、`AuditLog`、`ModelConfig`、`BrainScope/Source/Topic`、`BrainRepo`）。上一轮把"全表 GRANT"换成显式白名单，但头号缺陷只关掉了一半。另：该白名单是静态的，未来迁移新建的表不会自动获得运行时授权，表现为"静默不可访问"。 | 给 `User`/`Role`/`OrgNode` 等核心表加策略会直接影响登录与管理面。无端到端环境下盲改策略风险高于收益，需一次专门的迁移 + 全量安全 fixture + 运行时校验。 |
| L-08 | 子查询缓存命中路径复用权限过滤时传入 `aclEpoch:-1/knowledgeEpoch:-1`，若缓存中出现派生引用会在命中时被丢弃、未命中时保留（fail-closed 的不一致）。 | 属检索语义改动，需 SOTA/端到端套件才能验证；本轮不具备该验证条件。 |
| M-13 | `insideArticle` 仍只在标题或 12k 空行块处清除，首个"第N条"之后的条款仍会并入；`slice(0, 18_000)` 仍是静默截断。 | 同上，语义改动需检索回归。 |
| P2-5 | 上传文件名校验只补了控制字符剥离，MIME/可执行扩展名白名单仍未做。 | 需先明确允许清单的产品口径。 |
| TI-06/TI-07/TI-08/TI-09 | 历史 per-migration `verify.sql` 文件本体未改（仍有 `PERFORM count(*)` 丢弃结果、按文档调用即 SKIP 退出 0），新写的 `scripts/test-legacy-rls-security.sql` 包装器没有被任何脚本或 workflow 引用。实践上已被 `scripts/verify-runtime-rls.sh` 取代。 | 属遗留资产清理，需决定"接线还是显式退役"。 |
| TI-01 | `tests/e2e-web/`、`tests/evaluation/enterprise/` 仍无源码，既未恢复也未显式退役。 | 需决定退役方式。 |
| M-17 | 至少一次投递改依赖 Redis 持久化，但 `bootstrap-new-server.sh` 安装的是默认 redis，未开 AOF。 | 基础设施配置，需按部署口径统一处理。 |
| H-12/H-13/H-14 | 认领行的 BullMQ `active` 态不被回收；解析入队在事务提交后，失败则文档滞留 `parsing`；连接器重同步仍无事务（孤儿 `input.<hash>.txt` 累积）。 | 设计级改动，需单独的可靠性与清理设计。 |
| M-67 | `await background()` 仍无 except；仅 `BaseException`/`CancelledError` 可逃逸。 | 抑制取消信号会掩盖正常取消语义，属"保持现状更正确"。 |
| M-34 | 百度 OCR 的 `access_token` 仍在 URL query（厂商机制，无 header 方案）。已确认 `safe_error` 把所有错误串统一脱敏为固定文案，markdown/任务元数据/500 详情均不再泄漏。 | 无可行的代码修复；应在运维侧确保访问日志不落 query。 |

## 交互式验收新增的两个缺陷（本轮修复）

真实启动 API 后（详见 [交互式验收](interactive-verification.md)）立刻暴露两个只在运行时可见的权限缺陷——单测与迁移 fixture 都发现不了，因为它们用的是自建角色与自建授权：

| 编号 | 缺陷 | 处置 |
|---|---|---|
| DB-03 | 新迁移的 `model_provider_write` 策略直接调用 `app_kb_has_permission`，而该函数已从 PUBLIC 撤销且未授给运行角色；策略以调用者身份求值 ⇒ 运行角色访问 `ModelProvider` 直接 `42501`，应用启动即失败 | 改为经过已授权的无参 SECURITY DEFINER 包装 `app_current_user_has_permission(text)`，并按库名映射授权 |
| DB-04 | 运行角色对 `ModelQuotaBucket` 只有 DELETE，而 M-22 修复后无条件执行的清理跑 `DELETE ... WHERE period < …`（需要 SELECT）⇒ 新供给环境每个周期 `42501` | `reconcile-runtime-db-role.sh` 改为 `GRANT SELECT,DELETE`；该表唯一策略是 `app_is_service()`，RLS 仍挡住非服务上下文 |

## 新增回归测试

- `apps/api/src/admin-role-permissions.spec.ts`：H-16（通配权限拒绝/放行、创建与更新两条路径）。
- `apps/api/src/auth/auth.guard.spec.ts`：C-01 尾斜杠与更深路径边界。
- `apps/api/src/config-numbers.spec.ts`：H-27 依赖的数值解析契约。

## 未执行

未执行端到端与交互验收；未执行付费在线质量评测与真实检索校准；未部署任何环境。
