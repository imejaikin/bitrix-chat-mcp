// Инкрементальная синхронизация истории чатов.
//
// Семантика im.dialog.messages.get (проверено экспериментально):
//   FIRST_ID отсутствует -> последняя страница (самые свежие);
//   FIRST_ID: 0          -> самые СТАРЫЕ сообщения;
//   FIRST_ID: <id>       -> сообщения НОВЕЕ указанного.
// Поэтому курсор всегда двигаем по МАКСИМАЛЬНОМУ id — история листается вперёд.
// Один и тот же код работает и для первой полной закачки (курсор 0),
// и для докачки новых (курсор = last_message_id).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { callBitrix, readConfig } from './lib/bitrix.mjs';
import { openDb } from './lib/db.mjs';

const PAGE = 50;

function saveUsers(db, users = []) {
  const ins = db.prepare('INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
  for (const u of users) if (u?.id) ins.run(u.id, u.name ?? String(u.id));
}

function saveMessages(db, dialogId, messages = [], parentMessageId = null) {
  const ins = db.prepare(
    'INSERT INTO messages(id,dialog_id,author_id,date,text,parent_message_id) VALUES(?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET text=excluded.text, parent_message_id=excluded.parent_message_id'
  );
  let n = 0;
  for (const m of messages) {
    const text = (m.text ?? '').trim();
    if (!text) continue; // системные события и голые вложения не индексируем
    if (m.isSystem) continue; // im.v2 помечает служебные явно — «пригласил в канал» и т.п.
    ins.run(m.id, dialogId, m.author_id ?? m.authorId ?? 0, m.date ?? '', text, parentMessageId);
    n++;
  }
  return n;
}

/**
 * Треды (комментарии к сообщению).
 *
 * В Bitrix тред — это отдельный скрытый чат, а связь с родительским сообщением
 * живёт в `commentInfo` ответа `im.v2.Chat.Message.list`. Без этого половина
 * обсуждения теряется: под сообщением может висеть ветка на десяток реплик,
 * и именно там договариваются.
 *
 * `commentInfo` приходит только для сообщений текущей страницы, поэтому смотрим
 * последние сто — для инкрементального прогона этого достаточно, а старые ветки
 * подтянутся при следующем, если в них напишут.
 */
/** Адрес ветки: im.v2 отдаёт то `dialogId`, то голый `chatId`. */
export function threadDialogIdOf(link) {
  if (link?.dialogId) return String(link.dialogId);
  if (link?.chatId) return 'chat' + link.chatId;
  return null;
}

/**
 * Стоит ли лезть в ветку.
 *
 * Сравниваем `messageCount` из связи с тем, каким он был на прошлой закачке.
 * Считать вместо этого свои строки в базе нельзя: системные и пустые мы не
 * индексируем, поэтому своё число всегда меньше отданного Bitrix — на замере
 * ветка с messageCount 9 хранилась как 7 строк, и каждый прогон перекачивал
 * 265 сообщений при нуле новых. Это ровно та повторная выкачка, которую
 * правило проекта запрещает.
 */
export function threadNeedsSync({ cursor, seenCount, messageCount }) {
  if (!cursor) return true;                    // ветку ещё ни разу не качали
  if (messageCount === undefined || messageCount === null) return false;
  return messageCount > (seenCount ?? 0);
}

async function syncThreads(db, dialogId, maxThreads = 25) {
  // callBitrix уже разворачивает json.result — второго уровня тут нет.
  const v2 = await callBitrix('im.v2.Chat.Message.list', { dialogId, limit: 100 });
  const info = v2?.commentInfo ?? [];
  if (!info.length) return 0;

  const upsertThread = db.prepare(
    'INSERT INTO threads(thread_dialog_id,parent_dialog_id,parent_message_id,last_message_id,message_count,synced_at) ' +
      'VALUES(?,?,?,?,?,?) ON CONFLICT(thread_dialog_id) DO UPDATE SET ' +
      'last_message_id=excluded.last_message_id, message_count=excluded.message_count, synced_at=excluded.synced_at'
  );

  let added = 0;
  for (const t of info.slice(0, maxThreads)) {
    const threadDialogId = threadDialogIdOf(t);
    const parentId = t.messageId;
    if (!threadDialogId || !parentId) continue;

    const prev = db.prepare('SELECT last_message_id, message_count FROM threads WHERE thread_dialog_id=?')
      .get(threadDialogId);
    const cursor = prev?.last_message_id ?? 0;
    if (!threadNeedsSync({ cursor, seenCount: prev?.message_count, messageCount: t.messageCount })) continue;

    try {
      const data = await callBitrix('im.v2.Chat.Message.list', { dialogId: threadDialogId, limit: 100 });
      const msgs = data?.messages ?? [];
      if (!msgs.length) continue;

      added += saveMessages(db, threadDialogId, msgs, parentId);
      saveUsers(db, data?.users);

      const maxId = Math.max(...msgs.map((m) => m.id));
      upsertThread.run(threadDialogId, dialogId, parentId, maxId, t.messageCount ?? 0, new Date().toISOString());
    } catch (e) {
      // Ветка могла стать недоступной — это не повод ронять синк всего чата.
      console.error(`    (тред ${threadDialogId}: ${e.message})`);
    }
  }
  return added;
}

async function syncChat(db, dialogId, maxPages) {
  let cursor = db.prepare('SELECT last_message_id FROM chats WHERE dialog_id=?').get(dialogId)?.last_message_id ?? 0;
  let added = 0;

  for (let page = 0; page < maxPages; page++) {
    const res = await callBitrix('im.dialog.messages.get', { DIALOG_ID: dialogId, LIMIT: PAGE, FIRST_ID: cursor });
    const msgs = res?.messages ?? [];
    if (!msgs.length) break;

    added += saveMessages(db, dialogId, msgs);
    saveUsers(db, res?.users);

    const maxId = Math.max(...msgs.map((m) => m.id));
    if (maxId <= cursor) break; // курсор не сдвинулся — дальше идти некуда
    cursor = maxId;
    if (msgs.length < PAGE) break; // последняя страница
  }

  db.prepare(
    'INSERT INTO chats(dialog_id,last_message_id,synced_at) VALUES(?,?,?) ' +
      'ON CONFLICT(dialog_id) DO UPDATE SET last_message_id=excluded.last_message_id, synced_at=excluded.synced_at'
  ).run(dialogId, cursor, new Date().toISOString());

  return added;
}

/** Каталог доступных чатов — из него UI даёт выбирать, что зеркалить. */
async function refreshCatalog(db) {
  try {
    const recent = await callBitrix('im.recent.get', {});
    const ins = db.prepare(
      'INSERT INTO known_chats(dialog_id,title,type) VALUES(?,?,?) ' +
        'ON CONFLICT(dialog_id) DO UPDATE SET title=excluded.title, type=excluded.type'
    );
    for (const r of recent ?? []) {
      const id = r?.id?.chat_id ? 'chat' + r.id.chat_id : String(r?.id ?? '');
      if (id) ins.run(id, r.title ?? '', r.type ?? '');
    }
  } catch (e) {
    console.error(`  (каталог чатов не обновлён: ${e.message})`);
  }
}

async function main() {
  const cfg = readConfig();
  const db = openDb();
  await refreshCatalog(db);

  if (!cfg.chats?.length) {
    console.error('В config.json пустой список чатов. Откройте настройку: make ui');
    db.close();
    process.exit(1);
  }

  let total = 0;
  for (const dialogId of cfg.chats) {
    try {
      const n = await syncChat(db, dialogId, cfg.maxPagesPerChat ?? 40);
      const t = await syncThreads(db, dialogId, cfg.maxThreadsPerChat ?? 25);
      total += n + t;
      const title = db.prepare('SELECT title FROM known_chats WHERE dialog_id=?').get(dialogId)?.title ?? dialogId;
      console.log(`  ${title} (${dialogId}): +${n}` + (t ? `, в тредах +${t}` : ''));
    } catch (e) {
      console.error(`  ! ${dialogId}: ${e.message}`);
    }
  }

  db.exec('DELETE FROM messages_fts');
  db.exec('INSERT INTO messages_fts(id,dialog_id,text) SELECT id,dialog_id,text FROM messages');

  const totalMsgs = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
  console.log(`Готово: +${total} новых, всего в зеркале ${totalMsgs}.`);
  db.close();
}

// Запускаемся только как скрипт: из тестов файл импортируют ради чистых
// функций, и синхронизация с чужим API при этом стартовать не должна.
const запущен_напрямую = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (запущен_напрямую) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
