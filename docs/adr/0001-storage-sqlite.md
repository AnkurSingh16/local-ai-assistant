# ADR-0001: Storage in SQLite through node:sqlite, with real deletion

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Ankur Pawar

## Context

I need to store sessions, conversations, approved memory, feedback, the review queue and a search-result cache. Everything runs as one API process on one Mac. Users must be able to delete what is stored about them, and deleted text must actually be gone.

## Options considered

1. **SQLite through the built-in `node:sqlite`.** No extra process, no native addon, no dependency. Real SQL in tests with `:memory:` databases. Single writer per file.
2. **SQLite through better-sqlite3.** The most mature driver with an almost identical API, but a native addon that needs a prebuild or node-gyp on every Node major.
3. **PostgreSQL.** Concurrent writers and a clear path to managed hosting, but one more container, a pool, a migration tool and a CI service, for concurrency I do not have.

## Decision

I use SQLite through `node:sqlite` (`DatabaseSync`), one file under `data/`, behind async repository interfaces in `packages/storage` (`SessionRepo`, `ConversationRepo`, `MemoryRepo`, `FeedbackRepo`, `ReviewQueueRepo`, `SearchCacheRepo`).

- **Pragmas on every connection:** `foreign_keys=ON` (SQLite defaults it off, which silently disables cascades), `journal_mode=WAL`, `secure_delete=ON`.
- **Deletion:** every session-owned table cascades from `sessions`. After any delete I run `PRAGMA wal_checkpoint(TRUNCATE)`, because until the checkpoint the deleted rows still sit in the WAL file.
- **Migrations:** numbered `.sql` files, one transaction each, tracked with `PRAGMA user_version`. No migration tool.
- **Vectors:** approved memory is small (the owner approves every item), so `nomic-embed-text` embeddings from Ollama are stored as Float32 BLOBs next to each memory row and scored by brute-force cosine in JavaScript. I chose Ollama over transformers.js to avoid a second inference runtime; its RAM cost next to the other models is measured in Milestone 5. Measured on 2026-11-13 with `ollama ps` on my 16 GB M1 Pro: `nomic-embed-text` takes 0.34 GB when loaded, next to 4.76 GB for `qwen2.5:7b`, so it fits beside the chat and guard models. The recall threshold (cosine 0.35) is a starting value I have not tuned against real approved items; with only approved items in play, a loose threshold adds at most a few hundred tokens to the memory slot.
- **Never stored:** flagged input or output text (only a category and a timestamp), plaintext session tokens, IP addresses, raw page HTML.
- **Approved memory stays tied to its session** and is deleted with it. Nothing a user wrote ever leaves the session's tables; see [ADR-0009](0009-sessions-and-memory-deletion.md).

## Consequences

- No extra process or dependency, and storage tests run against real SQL in milliseconds.
- `node:sqlite` is a release candidate, not stable. If it hits a blocking bug, swapping to better-sqlite3 is about a day of work because the APIs match.
- One writer per file. I revisit this when there is more than one API process or a hosted multi-user deployment; Postgres then needs crypto-shredding (a per-session data key) for real deletion, because `VACUUM` and point-in-time backups keep old tuples.
- Encryption at rest relies on FileVault. The `data/` folder must be excluded from Time Machine, or deletion never reaches backups; [local setup](../local-setup.md) says so.

## Evidence

Measured on my M1 Pro (Node 24.22.3, bundled SQLite 3.54.1) on 2026-11-12:

- 10,000 rows of 768-dimension Float32 BLOBs inserted in 77 ms; a brute-force dot product over all of them took 29.5 ms.
- I inserted 50 marker rows, cascade-deleted them and scanned the file bytes. Without `secure_delete`, all 50 markers were still in the file after a checkpoint. With it, 50 copies remained in the WAL before the checkpoint and 0 after `wal_checkpoint(TRUNCATE)`.
- Node 24 documents `node:sqlite` as "Stability: 1.2 - Release candidate" since v24.15.0: https://nodejs.org/docs/latest-v24.x/api/sqlite.html (accessed 2026-11-12).
