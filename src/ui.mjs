// Локальная страница настройки: выбрать чаты для зеркала и посмотреть состояние.
//
// Безопасность (осознанные ограничения):
//  - слушаем только 127.0.0.1 — это не сервис для сети;
//  - вебхук здесь не показывается и не принимается, он живёт в .env;
//  - страница не умеет ничего писать в Bitrix, только править локальный whitelist.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { openDb } from './lib/db.mjs';
import { CONFIG_PATH } from './lib/bitrix.mjs';

const PORT = Number(process.env.PORT ?? 7625);
const db = openDb();

const readCfg = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

function state() {
  const cfg = readCfg();
  const selected = new Set(cfg.chats ?? []);
  const stats = new Map(
    db
      .prepare(
        `SELECT c.dialog_id, COUNT(m.id) cnt, MAX(m.date) mx, c.synced_at
         FROM chats c LEFT JOIN messages m ON m.dialog_id=c.dialog_id GROUP BY c.dialog_id`
      )
      .all()
      .map((r) => [r.dialog_id, r])
  );
  const chats = db
    .prepare('SELECT dialog_id,title,type FROM known_chats ORDER BY (type=\'chat\') DESC, title')
    .all()
    .map((c) => ({ ...c, selected: selected.has(c.dialog_id), ...(stats.get(c.dialog_id) ?? {}) }));
  return { chats, total: db.prepare('SELECT COUNT(*) c FROM messages').get().c, pins: db.prepare('SELECT COUNT(*) c FROM pins').get().c };
}

const HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>bitrix-chat-mcp — настройка</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.3rem;margin-bottom:.2rem} .muted{opacity:.7;font-size:.9em}
 .row{display:flex;align-items:center;gap:.6rem;padding:.45rem .6rem;border-radius:8px}
 .row:hover{background:rgba(127,127,127,.12)}
 .row .meta{margin-left:auto;font-size:.85em;opacity:.7;white-space:nowrap}
 .personal{opacity:.75}
 button{font:inherit;padding:.5rem 1rem;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:transparent;cursor:pointer}
 button.primary{background:#2d7ff9;color:#fff;border-color:#2d7ff9}
 .bar{display:flex;gap:.6rem;align-items:center;margin:1rem 0;position:sticky;bottom:0;padding:.6rem 0;backdrop-filter:blur(6px)}
 .warn{border-left:3px solid #e0a030;padding:.5rem .8rem;margin:1rem 0;font-size:.9em;opacity:.9}
 h2{font-size:1rem;margin:1.4rem 0 .4rem}
</style></head><body>
<h1>Зеркало чатов Bitrix24</h1>
<div class="muted">Отметьте чаты, историю которых нужно хранить локально для поиска. Синхронизация — <code>make sync</code>.</div>
<div class="warn">Личные переписки часто содержат чувствительное (доступы, ключи). По умолчанию отмечайте только командные каналы.</div>
<div id="app">Загрузка…</div>
<div class="bar"><button class="primary" onclick="save()">Сохранить</button><span id="status" class="muted"></span></div>
<script>
let data=null;
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){
  data=await (await fetch('/api/state')).json();
  const group=(t,list)=>list.length?'<h2>'+t+'</h2>'+list.map(c=>
    '<label class="row '+(c.type==='chat'||c.type==='channel'?'':'personal')+'">'+
    '<input type="checkbox" value="'+esc(c.dialog_id)+'"'+(c.selected?' checked':'')+'>'+
    '<span>'+esc(c.title||c.dialog_id)+'</span>'+
    '<span class="meta">'+(c.cnt?c.cnt+' сообщ. · до '+String(c.mx||'').slice(0,10):'не зеркалится')+'</span></label>').join(''):'';
  const team=data.chats.filter(c=>c.type==='chat'||c.type==='channel');
  const personal=data.chats.filter(c=>!(c.type==='chat'||c.type==='channel'));
  document.getElementById('app').innerHTML=
    '<div class="muted">В зеркале '+data.total+' сообщений, закладок: '+data.pins+'</div>'+
    group('Командные каналы',team)+group('Личные переписки',personal);
}
async function save(){
  const chats=[...document.querySelectorAll('input:checked')].map(i=>i.value);
  await fetch('/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chats})});
  document.getElementById('status').textContent='Сохранено ('+chats.length+'). Теперь: make sync';
}
load();
</script></body></html>`;

createServer(async (req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(state()));
  }
  if (req.url === '/api/save' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const cfg = readCfg();
    cfg.chats = JSON.parse(body).chats ?? [];
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Настройка: http://127.0.0.1:${PORT}  (только локально, Ctrl+C чтобы закрыть)`);
});
