import { DatabaseSync } from 'node:sqlite';

/**
 * One SQLite file under data/ through node:sqlite (ADR-0001). Every connection
 * gets the pragmas that make deletion real: foreign keys on (SQLite defaults
 * them off, which silently disables cascades), WAL, and secure_delete so freed
 * pages are zeroed rather than left readable.
 */
export type Database = DatabaseSync;

/**
 * Numbered migrations, one transaction each, tracked with PRAGMA user_version.
 * Every table that holds a user's data cascades from sessions, so deleting a
 * session deletes all of it.
 */
const migrations: readonly string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     token_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE conversations (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX conversations_session ON conversations(session_id);
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
     role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX messages_conversation ON messages(conversation_id, id);
   CREATE TABLE memory (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     embedding BLOB,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX memory_session ON memory(session_id);
   CREATE TABLE review_items (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('feedback', 'correction', 'preference')),
     content TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX review_items_status ON review_items(status, created_at);
   CREATE TABLE flagged_events (
     id INTEGER PRIMARY KEY,
     session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
     category TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT;`,
  // An item I mark as always relevant, such as an allergy, goes into every
  // prompt for its session: similarity recall missed a peanut allergy for 4 of
  // 5 food questions (ADR-0001, #55).
  `ALTER TABLE memory ADD COLUMN always INTEGER NOT NULL DEFAULT 0 CHECK (always IN (0, 1));`,
];

export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  // busy_timeout: the review command writes to the same file as the API, so a
  // write waits up to 5 s for the other's lock instead of failing at once.
  db.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

function userVersion(db: Database): number {
  const row = db.prepare('PRAGMA user_version').get();
  const version = row === undefined ? 0 : row.user_version;
  return typeof version === 'number' ? version : 0;
}

function migrate(db: Database): void {
  for (let v = userVersion(db); v < migrations.length; v++) {
    const sql = migrations[v] ?? '';
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${String(v + 1)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Until a checkpoint, deleted rows still sit in the WAL file, so every delete
 * of user data is followed by a truncating checkpoint (ADR-0001).
 */
export function checkpoint(db: Database): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}
