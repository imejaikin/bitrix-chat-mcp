import test from 'node:test';
import assert from 'node:assert/strict';

process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/45/секрет/';

const { threadDialogIdOf, threadNeedsSync } = await import('../src/sync.mjs');

// --- адрес ветки -----------------------------------------------------------

test('im.v2 отдаёт то dialogId, то голый chatId', () => {
  assert.equal(threadDialogIdOf({ dialogId: 'chat25427' }), 'chat25427');
  assert.equal(threadDialogIdOf({ chatId: 25427 }), 'chat25427');
  assert.equal(threadDialogIdOf({ dialogId: 'chat1', chatId: 2 }), 'chat1', 'dialogId точнее');
});

test('связь без адреса ветки пропускается, а не превращается в chatundefined', () => {
  assert.equal(threadDialogIdOf({ messageId: 390977 }), null);
  assert.equal(threadDialogIdOf(null), null);
});

// --- когда лезть в ветку ---------------------------------------------------

test('невыросшая ветка не стоит запроса', () => {
  assert.equal(threadNeedsSync({ cursor: 390979, seenCount: 9, messageCount: 9 }), false);
});

test('выросшая ветка докачивается', () => {
  assert.equal(threadNeedsSync({ cursor: 390979, seenCount: 9, messageCount: 11 }), true);
});

test('ветку, которую ещё не качали, берём всегда', () => {
  assert.equal(threadNeedsSync({ cursor: 0, seenCount: 0, messageCount: 0 }), true);
});

test('сравниваем с прошлым messageCount, а не со своими строками в базе', () => {
  // Системные и пустые сообщения мы не индексируем, поэтому число строк всегда
  // меньше отданного Bitrix: ветка с messageCount 9 лежит как 7 строк. Пока
  // сравнивали с ней, каждый прогон перекачивал 265 сообщений при нуле новых —
  // ровно та повторная выкачка, которую правило проекта запрещает.
  assert.equal(threadNeedsSync({ cursor: 390979, seenCount: 9, messageCount: 9 }), false,
    'счётчик из связи совпал — ветка не выросла, даже если строк в базе меньше');
});

test('без messageCount уже скачанная ветка не перекачивается', () => {
  assert.equal(threadNeedsSync({ cursor: 390979, seenCount: 9, messageCount: undefined }), false);
  assert.equal(threadNeedsSync({ cursor: 390979, seenCount: 9, messageCount: null }), false);
});

// --- как ветка выглядит в выдаче -------------------------------------------

const { displayChat } = await import('../src/lib/db.mjs');
const { DatabaseSync } = await import('node:sqlite');

function базаСВеткой() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE known_chats (dialog_id TEXT PRIMARY KEY, title TEXT, type TEXT);
    CREATE TABLE threads (thread_dialog_id TEXT PRIMARY KEY, parent_dialog_id TEXT,
                          parent_message_id INTEGER, last_message_id INTEGER, synced_at TEXT);
    INSERT INTO known_chats(dialog_id,title) VALUES('chat1002','Developers');
    INSERT INTO threads(thread_dialog_id,parent_dialog_id,parent_message_id) VALUES('chat1115','chat1002',27589);
  `);
  return db;
}

test('сообщение из ветки показывается родительским чатом, а не голым id', () => {
  // Скрытого чата ветки нет в known_chats: в выдаче оставался «chat1115»,
  // по которому непонятно ни где это, ни о чём.
  assert.equal(displayChat(базаСВеткой(), 'chat1115'), 'Developers · тред');
});

test('обычный чат остаётся собой', () => {
  assert.equal(displayChat(базаСВеткой(), 'chat1002'), 'Developers');
});

test('незнакомый чат отдаётся как есть', () => {
  assert.equal(displayChat(базаСВеткой(), 'chat9999'), 'chat9999');
});
