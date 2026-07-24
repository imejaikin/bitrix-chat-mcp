// Инкрементальная синхронизация истории чатов.
//
// Семантика im.dialog.messages.get (проверено экспериментально):
//   FIRST_ID отсутствует -> последняя страница (самые свежие);
//   FIRST_ID: 0          -> самые СТАРЫЕ сообщения;
//   FIRST_ID: <id>       -> сообщения НОВЕЕ указанного.
// Поэтому курсор всегда двигаем по МАКСИМАЛЬНОМУ id — история листается вперёд.
// Один и тот же код работает и для первой полной закачки (курсор 0),
// и для докачки новых (курсор = last_message_id).
import { callBitrix, readConfig } from './lib/bitrix.mjs';
import { openDb } from './lib/db.mjs';

const PAGE = 50;

function saveUsers(db, users = []) {
  const ins = db.prepare('INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name');
  for (const u of users) if (u?.id) ins.run(u.id, u.name ?? String(u.id));
}

function saveMessages(db, dialogId, messages = []) {
  const ins = db.prepare(
    'INSERT INTO messages(id,dialog_id,author_id,date,text) VALUES(?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET text=excluded.text'
  );
  let n = 0;
  for (const m of messages) {
    const text = (m.text ?? '').trim();
    if (!text) continue; // системные события и голые вложения не индексируем
    ins.run(m.id, dialogId, m.author_id ?? 0, m.date ?? '', text);
    n++;
  }
  return n;
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
      total += n;
      const title = db.prepare('SELECT title FROM known_chats WHERE dialog_id=?').get(dialogId)?.title ?? dialogId;
      console.log(`  ${title} (${dialogId}): +${n}`);
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

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
