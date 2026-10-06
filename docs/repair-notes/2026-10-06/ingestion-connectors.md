# Ingestion / connectors / MCP / OpenAPI changes

Implemented; tests intentionally not executed by development agent. Request gpt-6-luna targeted API tests, typecheck and lint.

- H02: Express trusts loopback proxies, preventing arbitrary direct-client forwarded-IP spoofing while native nginx sees client-specific rate buckets. Docker reverse proxy beyond loopback requires explicit topology followup, no broad trust by default.
- H06: configured CORS origins exact match; development default limited known ports.
- H08: list ACL-filtered ID population before paging/counts; absolute rawFileOid omitted from response while local size calculation remains available. Added ACL regression.
- H09: MCP calculation requires the requested active published version.
- H10: strict graph/lexical deletion cleanup executes before deleting DB document; failure keeps retryable document identity.
- H11/L09: shared upload-paths helper used by ingestion, MCP, connector, object storage, admin and OpenAPI; historical absolute DB file pointers still work. Legacy doc-owned directories cleaned on delete.
- H13/M39: KB row lock before version read, stale predecessor conflict; independent raw+markdown copy directory; valid effective dates/range; shared durable BullMQ enqueue helper directly injected into VersionChainModule, no dependency cycle or optional no-op. Added version lifecycle regression.
- H14: legacy connector writes hash-named immutable replacement file then moves DB pointer, preserves old bytes; pending immutable resync requeues matching pending hash after earlier enqueue failure.
- H17: failed legacy persistence removes unreferenced renamed markdown artifact; immutable stage failure similarly checks version reference.
- H27: hybrid indexing uses bounded ordered cursor SQL batches instead of materializing all content.
- M05: contextual retrieval finite concurrency/batch/timeout/retry/chunk budget defaults.
- M06: chunk splitting finite positive maxChars; validated overrides and finite nonnegative overlap.
- M14/M15: archive/text use same KB-lock transaction for duplicateMode=skip check and create; copy default consistently preserved across all upload forms; reused uploaded scratch/object artifacts removed. Existing storageProvider/objectKey precisely marks local fallback.
- M16: Feishu stops checkpoint advance at first failed download. Prior successful files can commit and failure retries next sync.
- M17: existing instance-isolated Redis DB durable list with sequence cursor and atomic append/ACK Lua. Unacknowledged batches are replayed after sync failure; failed Redis append rejects request, full queue rejects 429 instead of dropping oldest. ACK based on committed source cursor on next fetch, after persistence+enqueue succeeded. Connector controller awaits enqueue and returns 503 on storage errors. Tests use offline fake Redis sequence/ACK semantics.
- M22: quota/artifact GC runs independent of optional core versioning.
- M37: MCP Bearer fallback preserves 429.
- M38: raw, native PDF and converted PDF previews stream files via pipeline instead of full Buffer allocation.
- L01/L17: archive entry type whitelist in MCP/OpenAPI; nonarchive MCP type whitelist.
- L02: OpenAPI document status query scoped by visible KB plus document ACL, all inaccessible states return same 404.
- L03: new OpenAPI conversation plus user message persisted in single transaction; assistant write remains one atomic message operation against established conversation.
- L05/glm P2-4: JSON/urlencoded 10MiB limit. MCP file upload currently uses multipart route with independent 200MiB binary cap; no active base64 JSON upload API found.
- L07: fixed OpenAPI stream error text prevents provider/internal details disclosure.
- glm P2-5: URI-decoded upload filename re-sanitizes control characters and truncates consistently.
- glm P3-4: storage fallback already correctly represented by existing storageProvider=local plus absent objectKey; preserved explicitly, no speculative schema.

Stage1 parser verification failures corrected: safe_error retains only exact local missing-extractor RuntimeError text, no upstream URLs; /metrics dictionaries now annotated.

Potential focused checks: ingestion.controller.spec, knowledge-base.controller.spec, version-chain.service.spec, connector.service.spec, webhook-connector.spec, feishu-connector.spec, chunk-embedding.service.spec, markdown-chunker.spec, contextual-retrieval.spec, mcp.controller.spec, OpenAPI specs. API typecheck/lint. Existing mocks may need extensions for new ACL population query / durable queue helper.

No production deployment or paid model evaluation. User/external citation-assembly and .env.example edits preserved.

Additional authorization contract fix (verification pending): strict OpenAPI buffers up to 8MiB, preserves final `dependency_manifest`, performs `withStrictOutputPermit` shared-lock evidence verification and holds permit until response finish. MCP knowledge results explicitly pass manifest (chat done or active table version) to permit; nonknowledge RPC keeps authorization snapshot validation without inventing knowledge evidence. Explicit refusal/failure markers are accepted only when supplied by pipeline's manifest contract. Streaming disconnect/overflow rejects and unsubscribes instead of leaking buffered content.
