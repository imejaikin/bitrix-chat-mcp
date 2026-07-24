// MCP-сервер: память по чатам Bitrix24.
// Дополняет bitrix24-local-mcp — там живое состояние и запись, здесь поиск по истории.
// В Bitrix ничего не пишет намеренно: единственная запись — локальные закладки.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, ftsQuery, userName } from './lib/db.mjs';

const db = openDb();
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const title = (id) => db.prepare('SELECT title FROM known_chats WHERE dialog_id=?').get(id)?.title ?? id;
const fmt = (m) => `[${(m.date ?? '').slice(0, 16).replace('T', ' ')}] ${userName(db, m.author_id)} (${title(m.dialog_id)} · msg ${m.id})`;

const server = new McpServer({ name: 'bitrix-chat', version: '0.1.0' });

server.registerTool(
  'chat_search',
  {
    title: 'Поиск по истории чатов Bitrix24',
    description:
      'Точный полнотекстовый поиск по зеркалу чатов: где обсуждали решение, договорённость, замечание. ' +
      'Возвращает dialog_id и message_id — с ними можно дочитать свежий контекст через im_chat_messages ' +
      'или ответить через im_send_message (инструменты bitrix24).',
    inputSchema: {
      query: z.string().describe('что ищем, например "ai-rules-check" или "task_summary_files"'),
      chat: z.string().optional().describe('ограничить чатом, например chat10833'),
      limit: z.number().optional(),
    },
  },
  async ({ query, chat, limit = 10 }) => {
    const q = ftsQuery(query);
    if (!q) return text('Пустой запрос.');
    const sql =
      `SELECT m.id, m.dialog_id, m.author_id, m.date,
              snippet(messages_fts, 2, '«', '»', ' … ', 28) AS snip
       FROM messages_fts JOIN messages m ON m.id = messages_fts.id
       WHERE messages_fts MATCH ? ${chat ? 'AND m.dialog_id = ?' : ''}
       ORDER BY bm25(messages_fts) LIMIT ?`;
    const rows = chat ? db.prepare(sql).all(q, chat, limit) : db.prepare(sql).all(q, limit);
    if (!rows.length) return text(`Ничего не найдено: ${query}`);
    return text(rows.map((r) => `${fmt(r)}\n${r.snip}`).join('\n\n') + '\n\nОкружение сообщения: chat_context(message_id).');
  }
);

server.registerTool(
  'chat_context',
  {
    title: 'Сообщение с окружением',
    description: 'Показывает найденное сообщение вместе с соседними — чтобы понять, чем закончилось обсуждение.',
    inputSchema: { message_id: z.number(), around: z.number().optional().describe('сколько сообщений с каждой стороны, по умолчанию 5') },
  },
  async ({ message_id, around = 5 }) => {
    const m = db.prepare('SELECT * FROM messages WHERE id=?').get(message_id);
    if (!m) return text(`Нет сообщения ${message_id} в зеркале.`);
    const before = db.prepare('SELECT * FROM messages WHERE dialog_id=? AND id<? ORDER BY id DESC LIMIT ?').all(m.dialog_id, message_id, around).reverse();
    const after = db.prepare('SELECT * FROM messages WHERE dialog_id=? AND id>? ORDER BY id ASC LIMIT ?').all(m.dialog_id, message_id, around);
    const render = (x) => `${fmt(x)}\n${x.text}`;
    return text(
      [...before.map(render), '>>> ' + render(m), ...after.map(render)].join('\n\n')
    );
  }
);

server.registerTool(
  'chat_list',
  {
    title: 'Что есть в зеркале',
    description: 'Зеркалируемые чаты: объём, глубина истории, дата последней синхронизации.',
    inputSchema: {},
  },
  async () => {
    const rows = db
      .prepare(
        `SELECT c.dialog_id, c.synced_at, COUNT(m.id) cnt, MIN(m.date) mn, MAX(m.date) mx
         FROM chats c LEFT JOIN messages m ON m.dialog_id = c.dialog_id
         GROUP BY c.dialog_id ORDER BY cnt DESC`
      )
      .all();
    if (!rows.length) return text('Зеркало пустое. Настройте чаты (make ui) и синхронизируйте (make sync).');
    return text(
      rows
        .map((r) => `${title(r.dialog_id)} (${r.dialog_id}): ${r.cnt} сообщений, ${(r.mn ?? '').slice(0, 10)} → ${(r.mx ?? '').slice(0, 10)}`)
        .join('\n') + '\n\nОбновить: make sync'
    );
  }
);

server.registerTool(
  'chat_pin',
  {
    title: 'Запомнить сообщение как договорённость',
    description:
      'Локальная закладка на сообщение с пояснением, зачем оно важно. В Bitrix ничего не меняет. ' +
      'Закладки всплывают в chat_pins — так важные замечания не теряются.',
    inputSchema: { message_id: z.number(), note: z.string().describe('чем это сообщение важно') },
  },
  async ({ message_id, note }) => {
    if (!db.prepare('SELECT 1 FROM messages WHERE id=?').get(message_id)) return text(`Нет сообщения ${message_id} в зеркале.`);
    db.prepare('INSERT INTO pins(message_id,note,pinned_at) VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET note=excluded.note')
      .run(message_id, note, new Date().toISOString());
    return text(`Закладка сохранена: ${message_id}.`);
  }
);

server.registerTool(
  'chat_pins',
  {
    title: 'Сохранённые договорённости',
    description: 'Все локальные закладки — важные решения и замечания, отмеченные ранее.',
    inputSchema: {},
  },
  async () => {
    const rows = db
      .prepare('SELECT p.message_id, p.note, m.dialog_id, m.author_id, m.date, m.text FROM pins p JOIN messages m ON m.id=p.message_id ORDER BY p.pinned_at DESC')
      .all();
    if (!rows.length) return text('Закладок пока нет. Отметить: chat_pin(message_id, note).');
    return text(rows.map((r) => `${fmt(r)}\nЗачем: ${r.note}\n${r.text.slice(0, 400)}`).join('\n\n'));
  }
);

await server.connect(new StdioServerTransport());
