# Local archived SciFact cleanup review

Implementation only; real deletion has not been executed by the implementation agent.

The maintenance CLI is `apps/api/dist/bootstrap/cleanup-archived-personal.js`, built from the corresponding TypeScript source. There is no HTTP endpoint, schema migration, KB reactivation or production deployment. It explicitly constructs the existing Permission, ModelConfig, BrainScope, BrainOutbox, BrainCompiler, GraphRag, Raptor, LexicalIndex and ObjectStorage business services, plus four BullMQ Queue clients. It constructs no Nest application, Processor or Worker and invokes no lifecycle hook. Queue clients use the existing local Redis host/port/database; no middleware instance is created.

Reviewed scope:

| KB ID | Exact name | Non-published+ready candidates | Retained published+ready |
|---|---|---:|---:|
| `7bae6312-86de-44d0-8082-1f7d15d3583a` | `EVAL-BEIR-SciFact-Full-20260927` | 593 | 7 |
| `4ff9ac97-0527-4f4f-841a-33bb81ae1c3a` | `EVAL-BEIR-SciFact-Full-20260927-Retry` | 5,183 | 0 |

The invoking actor must be both system administrator and owner of the exact archived personal KB. Only a local service-principal context can call the service. Local database hostname and basename must match an explicit `ARCHIVED_CLEANUP_LOCAL_DATABASE`; local Redis is required. Explicit runtime `UPLOAD_ROOT` and `BRAIN_REPO_BASE_PATH` are required and pinned into the plan. A configured remote MinIO endpoint is rejected. Execution additionally requires `ARCHIVED_CLEANUP_ENABLE=1`. These are command-specific opt-ins; do not add them to runtime `.env`.

Dry-run is the default and creates a new mode-0600 plan file with exclusive creation. The plan contains exact document IDs, status/readiness/version/updatedAt and storage references, plus exact retained ready IDs. Execution requires that reviewed plan and the same explicit actor/KB ID/name. It defaults to one document, is bounded to 100 per invocation and stops on the first error. SIGINT/SIGTERM stops before the next document; the current document may finish its bounded transaction. Successful prior documents have committed audit rows and can be safely resumed with the same plan. A missing document counts as idempotent success only when a matching operation audit exists.

Per document, the service locks KB and document rows, checks the KB remains archived and the exact planned document state, locks associated outbox rows and refuses any non-terminal event or non-terminal target queue job. It calls the same lifecycle services as ordinary deletion: strict lexical unindex; mapped compiler-source removal and scope invalidation; strict graph cleanup; RAPTOR document/global-node removal without scheduling an archived-KB rebuild; strict provider-specific object deletion with a HEAD/access absence check; document-contained raw/pending files and directory deletion. It then removes terminal target queue jobs and all document outbox rows, deletes the document through application Prisma relations, and creates a strict audit row in the same commit. KB status remains archived throughout.

Root's read-only inspection found zero BrainSourceDocument mappings for the 5,776 candidates, zero live document outbox events and 11,552 terminal document events. `requireMapping` returns before source lookup/GBrain mutation when mappings are empty. If mapped material exists, affected scopes are invalidated and synthesis is queued once per unique scope per batch, rather than once per document.

External index/object/filesystem operations cannot roll back with the document transaction. A failure retains document metadata and outbox rows, so the same plan can rerun the idempotent cleanup. Strict errors are never reported as successful document deletion. `--verify` is a separate read-only acceptance check for exact deleted IDs: Document, Chunk, DocumentVersion, DocumentAcl, BrainSourceDocument, RaptorNode and BrainChangeEvent counts must be zero; lexical and graph provenance must be absent; object HEAD/access and raw paths must be absent; all retained published+ready IDs must remain present in the archived KB. Any unavailable verification dependency fails closed.

Run from `apps/api`, using the existing local-test `.env` identity and infrastructure. Example preview (no credentials):

```bash
ARCHIVED_CLEANUP_LOCAL_DATABASE=llmwiki \
UPLOAD_ROOT=/home/scottsun/.local/share/llmwiki/uploads \
BRAIN_REPO_BASE_PATH=/home/scottsun/.local/share/llmwiki/brain_repos \
node dist/bootstrap/cleanup-archived-personal.js \
  --actor 0e7a51f6-f4c3-46a0-87bd-d23d4d7280d4 \
  --kb-id 7bae6312-86de-44d0-8082-1f7d15d3583a \
  --kb-name EVAL-BEIR-SciFact-Full-20260927 \
  --plan /home/scottsun/.local/share/llmwiki/maintenance-plans/20261005/scifact-full.json
```

Use the second exact ID/name with a separate plan for Retry. Review count, identities, status snapshots and storage namespace safety before enabling deletion. The first approved execution must use `--execute --offset 0 --batch-size 1` with the same scope and plan plus the one-command `ARCHIVED_CLEANUP_ENABLE=1`. After it commits, run `--verify --offset 0 --batch-size 1` without the enable switch. Broader batches require successful pilot verification and the parent agent's review. Preserve plan and audit operation IDs; never regenerate a plan to conceal an unresolved partial failure.

Validation: final full serial suite passed 139 API suites / 1,190 tests, with the existing 5 skips; all 6 Turbo tasks passed. API typecheck, lint and build passed. Targeted lifecycle/security suite passed 6 files / 60 tests before the final extra history-version/shared-storage and CLI guard regressions; latest full suite includes all added regressions. A real local CLI invocation with `ARCHIVED_CLEANUP_ENABLE=0 --execute` refused before queue construction, exited 1 and performed no deletion.

Final dry-run plans (both exclusively created mode 0600) are stored outside source control in the persistent local maintenance directory shown above: `scifact-full.json` operation `8cfd03fe-b7fc-4b73-a957-410dbc022cfa` and `scifact-retry.json` operation `06b723e9-49d4-45a7-a621-93b86b0dd209`. Exact SHA256 values and the 7 retained IDs are in [scifact-archived-cleanup.json](scifact-archived-cleanup.json). These plans contain 5,776 disjoint eligible IDs, zero duplicate target storage keys, zero raw namespace/symlink failures, and all target raw files and local objects were found present during read-only filesystem inspection. Scope states are Full: 500 indexing/ready + 90 indexing/pending + 3 indexing/degraded; Retry: 5,183 indexing/pending. The 500 indexing/ready rows remain eligible because their document status is not published. No deletion, API restart, migration or production action was executed.

The first full-suite attempt during active edits failed one newly added shared-reference assertion against a previously loaded service revision; the isolated final test and subsequent stable full suite both passed. The reviewed plan is the final persistent version with pinned runtime storage roots; earlier `/tmp/*-review-20261005.json` exploratory snapshots predate that requirement and must not be used for execution.
