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

    -- Треды (комментарии к сообщению). В Bitrix это отдельный скрытый чат,
    -- поэтому связь хранится явно: какое сообщение какого чата обсуждают.
    -- Курсор свой, как у обычного чата: перекачивать ветку целиком нельзя.
    CREATE TABLE IF NOT EXISTS threads (
      thread_dialog_id  TEXT PRIMARY KEY,
      parent_dialog_id  TEXT NOT NULL,
      parent_message_id INTEGER NOT NULL,
      last_message_id   INTEGER DEFAULT 0,
      -- messageCount из commentInfo на момент прошлой закачки. Считать строки
      -- в базе для этого нельзя: системные и пустые мы не индексируем, и своё
      -- число всегда меньше — ветка качалась бы на каждом прогоне.
      message_count     INTEGER DEFAULT 0,
      synced_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_dialog_id, parent_message_id);

    -- Закладки: то, ради чего всё затевалось — не терять важные замечания.
    CREATE TABLE IF NOT EXISTS pins (
      message_id INTEGER PRIMARY KEY,
      note       TEXT,
      pinned_at  TEXT
    );
  `);

  // Миграция: колонка появилась вместе с тредами, а база уже существует
  // у всех, кто зеркалит с февраля. CREATE TABLE IF NOT EXISTS её не добавит.
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('parent_message_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN parent_message_id INTEGER');
  }
  const threadCols = db.prepare('PRAGMA table_info(threads)').all().map((c) => c.name);
  if (threadCols.length && !threadCols.includes('message_count')) {
    db.exec('ALTER TABLE threads ADD COLUMN message_count INTEGER DEFAULT 0');
  }

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

/**
 * Как показать чат сообщения, если сообщение лежит в треде.
 *
 * Тред в Bitrix — отдельный скрытый чат, и в `known_chats` его нет: в выдаче
 * оставался голый `chat11115`, по которому непонятно ни где это, ни о чём.
 * Показываем родителя и помечаем, что это ветка.
 */
export function displayChat(db, dialogId) {
  const own = db.prepare('SELECT title FROM known_chats WHERE dialog_id=?').get(dialogId)?.title;
  if (own) return own;
  const parent = db.prepare('SELECT parent_dialog_id FROM threads WHERE thread_dialog_id=?').get(dialogId);
  if (!parent) return dialogId;
  const parentTitle = db.prepare('SELECT title FROM known_chats WHERE dialog_id=?').get(parent.parent_dialog_id)?.title
    ?? parent.parent_dialog_id;
  return `${parentTitle} · тред`;
}
