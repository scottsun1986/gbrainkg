# GBrainKG 生产可观测性

组件：Prometheus（:9090，仅本机）+ Grafana（建议 :3300）+ 预置告警规则与总览看板。

## 安装（生产宿主机）

```bash
sudo bash deploy/monitoring/install-monitoring.sh
# Grafana 与 inst1 API 都默认 :3000 时，先把 Grafana 改到 :3300：
sudo sed -i 's/^;http_port = 3000/http_port = 3300/' /etc/grafana/grafana.ini
sudo systemctl restart grafana-server
```

可选 Exporter（节点/PG）：

```bash
sudo INSTALL_EXPORTERS=1 bash deploy/monitoring/install-monitoring.sh
```

## 抓取目标

| Job | Targets | 说明 |
|---|---|---|
| `gbrainkg-api` | `127.0.0.1:3000/3002/3004` | 三实例 `/metrics` |
| `gbrainkg-web` | `127.0.0.1:3200/3202` | Web（若未暴露指标则抓取失败可忽略） |
| `node` / `postgres` | `9100` / `9187` | 可选 |

## 指标来源

API `GET /metrics`（手写 registry，无 prom-client）：

- `http_requests_total{method,route,status}`
- `http_request_duration_ms_*` + `_quantile{quantile=0.5|0.95|0.99}`
- `retrieval_failopen_total{channel}`
- `ingestion_queue_depth`
- `llm_errors_total{provider}` / `embedding_failures_total`
- `rls_enforce` / `app_build_info` / `process_uptime_seconds`

## 告警（`gbrainkg-alerts.yml`）

| 级别 | 告警 | 含义 |
|---|---|---|
| critical | ApiDown | 实例失联 |
| critical | HighHttp5xx | 5 分钟 5xx > 2% |
| warning | HighLatencyP95 / ChatLatencyP95 | p95 超预算 |
| warning | RetrievalFailopenSpike | 混合检索开始大量降级 |
| warning | LlmProviderErrors / EmbeddingFailures | 上游模型故障 |
| warning | IngestionBacklog | 解析积压 > 500 |
| warning | RlsNotEnforced | 某实例 RLS_ENFORCE=0 |

Alertmanager 可选：配置 `ALERT_WEBHOOK` 后可加企业微信/飞书/邮件通知（未装 AM 时告警只在 Prometheus UI `/alerts` 可见）。

## 验证

```bash
curl -s 127.0.0.1:9090/api/v1/targets | python3 -m json.tool | head
curl -s 127.0.0.1:9090/api/v1/rules | python3 -m json.tool | head
# Grafana 导入后打开 GBrainKG / gbrainkg-overview
```


## 知识库域名入口（已下线）

> 2026-09-23 应要求停用生产监控：容器已移除、nginx `/monitor/*` 入口已撤销。
> 配置与安装脚本保留在本目录，需要时可重新 `install-monitoring-docker.sh` + `expose-monitoring-vhost.sh`。

### 历史参考

```
https://knowledge.5gsailor.com:20080/monitor/            落地页（Grafana / Prometheus 导航）
https://knowledge.5gsailor.com:20080/monitor/grafana/    Grafana 看板
https://knowledge.5gsailor.com:20080/monitor/prometheus/ Prometheus
```

- 全部走 **HTTP Basic Auth**（用户 `ops`）。
- 当前统一口令见运维私信；改密：`sudo MONITOR_USER=ops MONITOR_PASS='…' bash deploy/monitoring/expose-monitoring-vhost.sh`。
- 一键发布/改密：

```bash
sudo MONITOR_USER=ops MONITOR_PASS='你的密码' \
  bash deploy/monitoring/expose-monitoring-vhost.sh
```

- 实现要点：Grafana `serve_from_sub_path=true` + 反代**保留** `/monitor/grafana` 前缀；
  Prometheus `--web.route-prefix=/monitor/prometheus`；落地页用 `alias` 静态文件
  （nginx `return` 在 rewrite 阶段执行会绕过 `auth_basic`）。
