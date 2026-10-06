# Parser / adapter checkpoint

Implemented without running tests (user requires gpt-6-luna verification):
- C02 keyword-only forwarding and execute instance_id; C03 TLS verification default.
- H26 streaming meaningful-character count, quality CPU off event loop.
- M07-09 finite adapter numeric settings, stale-lock age guard; M10 commit failure propagation except truly clean index; M11 forced post-sync source status.
- M12 shared frontmatter regex; M13 section indices + bounded sections/paragraph splitting (no corpus-specific behavior).
- M28 source identities validated before filesystem paths. M29 rebuild cleans docs and derived roots.
- M30 native page eligibility per-page quality; M31 Excel cell grid cap 1m before merge/iteration, legacy XLS cap.
- M32 embedded OCR shares limiter and holds it throughout uploads; instance_id supported. M33 keeps HTTP 400/413.
- M34 provider error strings scrubbed from OCR markdown/task and logs. M35 stat-before-read, off-thread read/base64.
- M36 cancellation drops task and partial file.
- M61 default max inflight 16 plus total reservation upload budget 1GiB and disk reserve check. M62 HTTPS provider CDN allowlist/public-address check, no redirects, streaming 20MiB/30s artifact bound. M63 retry transient polling HTTP errors.
- M64 plaintext/normalization/quality off-thread; embedded file write off-thread.
- M65 deferred placeholder replacements with one final scan.
- M66 PDF rendering max 8M pixels and off-thread.
- M67 best-effort unlink preserves successful output.
- M68 isolated docling FSIZE resource limit and pre-write artifact byte check.
- M69 OCR confidence denominator only successful confidence measurements.
- M70 safe env readers in main/cache/VLM. M71 default requires token, explicit PARSER_ALLOW_UNAUTHENTICATED_LOOPBACK=1 permits dev loopback only, public nginx /parse returns 404. Health remains available for probes. M72 metrics authentication.
- M73 cache includes hashed credentials. M74 maxsim shape validation before NumPy allocation; parent releases duplicate parsed payload. M75 limiter forgets completed identities. M76 shielded subprocess reaping tolerates repeated cancellation. M77 antiword isolated resource-limit helper, bounded temporary output, group kill/reap timeout.
- M78 git stdout/stderr 8MiB cap. M79 every reported embedding column dimension checked. M80 empty federation reranked=false. M81 deep cache clones + refresh LRU order.
- TI11 pytest pythonpath config. Added parser report regressions and adapter contract regressions.

Verification requested: pnpm test:parser; pnpm test:adapter; parser ruff/mypy gates. Existing test_execute explicitly opts into loopback dev behavior. New tests make no paid model calls. No production activity.

Known followups to inspect during verification:
- antiword existing tests may mock subprocess.run; implementation now uses isolated Popen/helper and such mocks need update.
- new maxsim helper assumes list documents as existing contract, ndarray callers unsupported.
- pytest namespace import src.* vs flat helper names may need lint adjustment.
- M13 final localized output remains context-limited 18k by existing contract; bounded passage ranking prevents entire articles monopolizing localization.
- M62 provider CDN allowlist intentionally baidu.com, baidubce.com, bcebos.com; custom provider should not return arbitrary artifact hosts.

External pre-existing modifications in .env.example and chat/citation-assembly.ts/spec.ts untouched.
