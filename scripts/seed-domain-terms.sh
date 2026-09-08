#!/usr/bin/env bash
# KB 级检索领域词 seed 脚本 (OPT-3)
# 将原硬编码于 chat.service.ts 的验收领域词迁移为 KnowledgeBase.domainTerms 配置。
# 仅对指定知识库写入；默认空 = 平台无任何应用侧关键词。
# 用法:
#   ./scripts/seed-domain-terms.sh                 # 默认写入三个组织知识库
#   ./scripts/seed-domain-terms.sh --clear         # 清空
#   ./scripts/seed-domain-terms.sh --kb "知识库名"  # 指定库(可重复)
set -euo pipefail

TERMS_JSON='["数据跨境","出境","加密传输","无人系统","总则","技术加密","特殊豁免","附则","一级安全偏航","偏航事故","传感器","历史未检修","隐患记录","扣除","安全积分","连带处分","处分","停飞","绩效","极端气象","雷达","红外","双失效","接管","黑匣子","遥测","遥控","频率","着陆保护","降落伞","气囊","研发阶段","试验阶段","研发试验","商业量产","量产运营","自主避障","安全冗余","冗余裕度","量子抗性","格密码","双向握手","延迟","通信安全","防御","安全风险","重放攻击","物理自毁","指标体系","度量指标","考核指标","绩效考核","研发人员","研发效能","考勤方式","旷工","考勤管理"]'

CLEAR=0; KB_NAMES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clear) CLEAR=1; shift;;
    --kb) KB_NAMES+=("$2"); shift 2;;
    *) echo "unknown arg: $1"; exit 1;;
  esac
done
[[ ${#KB_NAMES[@]} -eq 0 ]] && KB_NAMES=("开发组知识库" "云中台知识库" "南京分公司知识库")

VALUE="null"
[[ $CLEAR -eq 0 ]] && VALUE="'$TERMS_JSON'::jsonb"

PG="docker exec llmwiki-postgres psql -U llmwiki -d llmwiki -t -A"
for NAME in "${KB_NAMES[@]}"; do
  KB_ID=$($PG -c "SELECT id FROM \"KnowledgeBase\" WHERE name='$NAME' LIMIT 1;" | tr -d '[:space:]')
  if [[ -z "$KB_ID" ]]; then echo "skip (not found): $NAME"; continue; fi
  $PG -c "UPDATE \"KnowledgeBase\" SET \"domainTerms\"=$VALUE WHERE id='$KB_ID';" >/dev/null
  echo "$([[ $CLEAR -eq 1 ]] && echo cleared || echo seeded): $NAME ($KB_ID)"
done
