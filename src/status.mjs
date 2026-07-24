import { openDb } from './lib/db.mjs';
const db = openDb();
const rows = db.prepare(`SELECT c.dialog_id,c.synced_at,COUNT(m.id) cnt,MIN(m.date) mn,MAX(m.date) mx
  FROM chats c LEFT JOIN messages m ON m.dialog_id=c.dialog_id GROUP BY c.dialog_id ORDER BY cnt DESC`).all();
const t = (id) => db.prepare('SELECT title FROM known_chats WHERE dialog_id=?').get(id)?.title ?? id;
for (const r of rows) console.log(`${t(r.dialog_id).padEnd(24)} ${String(r.cnt).padStart(5)} сообщ.  ${(r.mn??'').slice(0,10)} → ${(r.mx??'').slice(0,10)}`);
console.log(`\nВсего: ${db.prepare('SELECT COUNT(*) c FROM messages').get().c}, закладок: ${db.prepare('SELECT COUNT(*) c FROM pins').get().c}`);
