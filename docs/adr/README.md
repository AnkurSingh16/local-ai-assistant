# Architecture decision records

I record every significant decision here, one per file, using [the template](0000-template.md). A decision that changes a fixed choice in the [requirements](../architecture/requirements.md) needs evidence in the ADR.

Statuses: `Proposed`, `Accepted`, `Superseded by ADR-NNNN`, `Rejected`.

| ADR                                            | Title                                                               | Status   |
| ---------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](0001-storage-sqlite.md)                 | Storage in SQLite through node:sqlite, with real deletion           | Accepted |
| [0002](0002-packages-interfaces-boundaries.md) | Package layout, provider interfaces and guard boundaries            | Accepted |
| [0003](0003-agent-loop-and-tools.md)           | Agent loop with native tool calling, forced search and a taint rule | Accepted |
| [0004](0004-context-budget-and-history.md)     | Context budget and conversation history                             | Accepted |
| [0005](0005-guardrail-pipeline.md)             | Guardrail pipeline, fail-closed moderation and refusals             | Accepted |
| [0006](0006-guard-model-size.md)               | llama-guard3:1b as the guard on 16 GB machines                      | Accepted |
| [0007](0007-streaming-contract.md)             | Streaming contract: POST with Server-Sent Events read through fetch | Accepted |
| [0008](0008-fetch-safety.md)                   | Fetch safety for read_page                                          | Accepted |
| [0009](0009-sessions-and-memory-deletion.md)   | Anonymous sessions, memory review and real deletion                 | Accepted |
| [0010](0010-process-topology-and-pinning.md)   | Process topology, network binding and version pinning               | Accepted |
| [0011](0011-search-cache-and-rate-limits.md)   | Search cache and rate limits                                        | Accepted |
| [0012](0012-evaluation-in-ci.md)               | Red-team and routing evaluation, in CI and locally                  | Accepted |
| [0013](0013-logging-and-privacy.md)            | Logging without message text                                        | Accepted |

I made these decisions after a two-round debate between a simplicity-and-cost view and a security-and-scale view, with every recommendation challenged before it was accepted. Measurements in the ADRs were taken on my M1 Pro with 16 GB on 2026-11-12.
