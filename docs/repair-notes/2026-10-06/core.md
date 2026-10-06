# API检索/编译修复记录（2026-10-06）
状态：代码与回归用例已写入，尚未运行测试；不能当作已验证完成。

| 报告项目 | 代码处置 | 回归证据/待验证 |
|---|---|---|
| H12/M18 | outbox固定BullMQ job identity；真实lease token extendLock检查；数据库claimToken CAS；重启新worker可回收失主claim；完成前再次lease+CAS；dispatcher仅缺job过期/终态恢复processing，绝不抢active/delayed；优先扫描revoke；毒事件增长retryCount | processor新增失lease拒绝/新token条件提交tests；outbox现有dispatcher tests；需Redis真实stalled worker验证 |
| H19 | 分数序中find目标后直接取目标citation/index，消除pool index错用 | bridge-rescue新增分数序≠池序测试 |
| H20 | topic去重最多8，findMany一批；每请求最多尝试1次编译；waitUntilFinished最大5秒且受检索deadline；超时只延后optional编译，保留已有证据 | 待API测试/实际编译队列验证 |
| H21/H22/L16 | plan/expansion所有set路径统一500容量与过期清理；scopeDomain缓存500容量 | 待API缓存测试 |
| H23/M03 | authorization failure重抛；源撤权清空/replace已推delta；注册并清理inheritedCancellation与ChatRun取消信号 | 待chat/authorization回归 |
| H24/glm P2-0 | strict buffer溢出flag清空并拒绝后续next，微任务unsubscribe取消pipeline，finalize.catch；空回答记failed与non_evidence failure；replace正确更新持久answer | empty完成与strict 8MiB溢出立即unsubscribe新增controller测试；待运行验证 |
| H25 | startup迁移分支使用顺序sync而非无界Promise.all | 待compiler tests |
| M01 | probe组过滤空正文时同步保留对应candidate数组，非空组继续重排，返回index仍对应正确target | 待fusion-rerank tests |
| M02 | 搜索分数只收有限number并按doc/chunk稳定tie-break | 待chat search tests |
| M04/L08 | subQuery缓存命中重新进行现有permission与源version过滤后返回 | 待retrieval tests |
| glm P0-1 | RAPTOR timer catch不再从后台抛授权错误，明确log；backfill floating Promise catch；global build在脱离请求的显式service身份下执行 | 待raptor tests与故障注入 |
| glm P1-1 | adaptive无校准trace标uncalibrated且calibrationAvailable=false；不产生或伪造校准概率；已有adaptive测试按实际语义更新 | citation-assembly adaptive回归 |
| glm P2-1 | maxDocs现代码已60与example一致；timeout由60000统一到15000 | 待配置/default测试 |
| glm P2-2 | ChatRun持久leaseExpiresAt跨进程；poll续租；reaper只清start旧且DBlease过期、并排除本进程controller；reaper/pruner显式service上下文 | 新活跃lease排除test；待isolated DB迁移 |
| glm P2-6 | headingHierarchy/蛇形层级/噪声过滤/metadata whitelist现有实现已满足，未重复修 | existing fusion/retrieval tests |
| glm P2-7 | 显式MIN_FLOOR_GROUPS同样受softFloor灰度开关控制并校验finite | citation-assembly现有tests，保留用户原有boost/multisource修改 |
| glm P3-3 | 每wait独立idle timer，Set管理dispose；并发结束不清另一个timer | stream-deadline新增并发测试 |
| glm P3-5 | 已有retrieval fingerprint机制复用；加入adaptive/embedding/校准配置与profile文件metadata，固定本次contract盐 | existing semanticCacheScopeKey tests |

# 权限风暴补强
内容/index不推进全局authority revision后，strictOutputPermit必须在同一共享output锁内再次校验确切来源manifest（版本/hash/ACL/有效期），ChatController显式传最终manifest；新增permit tests验证revision不变但source changed拒绝。MCP/OpenAPI持有agent协调接入相同第四参数。SQL app_manifest支持请求asOf，历史查询语义保留。

# 安全组追加
Graph构建等待upstream links后最终再assertSnapshot+ACL过滤检查；新增异步期间撤权test。
Dirty/旧epoch派生页必须保持SELECT隐身，通过app_publish_derived_page窄授权函数校验membership/source/epoch并在scope锁+output fence内替换；局部service权限只覆盖该写操作并恢复。SQL security-test新增private cache/source/derived deny、伪造source membership拒绝与旧epoch不可见→合法rebuild可见验证。

ModelProvider是系统共享推理配置，active请求读取配置的密文是当前架构职责，不能声称完整密钥数据库隔离；已限制无身份SELECT与非管理写，API对外仍需保持遮罩密钥。未执行任何生产操作。
