// Хранилище зеркала. Поиск точный (FTS5): ищем формулировки договорённостей
// («ai-rules-check», «task_summary_files»), где важно точное совпадение, а не близость по смыслу.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DB_PATH = join(ROOT, 'data', 'chats.db');

export function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      dialog_id       TEXT PRIMARY KEY,
      title           TEXT,
      type            TEXT,
      last_message_id INTEGER DEFAULT 0,
      synced_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY,
      dialog_id TEXT NOT NULL,
      author_id INTEGER,
      date      TEXT,
      text      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_dialog_date ON messages(dialog_id, date);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(id UNINDEXED, dialog_id UNINDEXED, text, tokenize='unicode61');

    CREATE TABLE IF NOT EXISTS known_chats (
      dialog_id TEXT PRIMARY KEY,
      title     TEXT,
      type      TEXT
    );

    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT);

    -- Закладки: то, ради чего всё затевалось — не терять важные замечания.
    CREATE TABLE IF NOT EXISTS pins (
      message_id INTEGER PRIMARY KEY,
      note       TEXT,
      pinned_at  TEXT
    );
  `);
  return db;
}

/** Экранирование запроса для FTS5: каждое слово как фраза, AND между ними. */
export function ftsQuery(raw) {
  const terms = String(raw).match(/[\p{L}\p{N}_.\-]+/gu) ?? [];
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' AND ');
}

export const userName = (db, id) =>
  db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name ?? `user${id}`;

export const chatTitle = (db, dialogId) =>
  db.prepare('SELECT title FROM chats WHERE dialog_id=?').get(dialogId)?.title ?? dialogId;
