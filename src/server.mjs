// MCP-сервер: память по чатам Bitrix24.
// Дополняет bitrix24-local-mcp — там живое состояние и запись, здесь поиск по истории.
// В Bitrix ничего не пишет намеренно: единственная запись — локальные закладки.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, ftsQuery, userName, displayChat } from './lib/db.mjs';
import { webhookUrl, readConfig } from './lib/bitrix.mjs';
import { pendingQuestions, openPromises, selfIdFromWebhook } from './lib/attention.mjs';

const db = openDb();
const text = (s) => ({ content: [{ type: 'text', text: s }] });
const title = (id) => displayChat(db, id);
const fmt = (m) => `[${(m.date ?? '').slice(0, 16).replace('T', ' ')}] ${userName(db, m.author_id)} (${title(m.dialog_id)} · msg ${m.id})`;

const found = (rows, render) => rows.map(render).join('\n\n');

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

// --- что просело между чатами ---------------------------------------------
//
// Обе выборки читают одно и то же окно истории и обе опираются на «писал ли я
// в этом чате после». Точного «ответа именно на это» из зеркала не достать, и
// вечное напоминание про закрытый вопрос хуже пропуска — признак грубый нарочно.

/** Сообщения за последние N дней, вместе с датой моего последнего сообщения
 *  в каждом чате: по ней и решается, отвечал я после или нет. */
function attentionWindow(days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const messages = db.prepare('SELECT id, dialog_id, author_id, date, text FROM messages WHERE date >= ? ORDER BY date').all(since);
  const myLastByDialog = {};
  for (const r of db.prepare('SELECT dialog_id, MAX(date) AS last FROM messages WHERE author_id = ? GROUP BY dialog_id').all(selfId())) {
    myLastByDialog[r.dialog_id] = r.last;
  }
  return { since, messages, myLastByDialog };
}

let cachedSelfId = null;
function selfId() {
  if (cachedSelfId === null) {
    cachedSelfId = selfIdFromWebhook(webhookUrl());
    if (!cachedSelfId) throw new Error('Не удалось определить свой user_id из BITRIX24_WEBHOOK_URL');
  }
  return cachedSelfId;
}

//: Слова моей зоны: по ним вопрос считается адресованным мне даже без прямого
//: упоминания. Список свой у каждого, поэтому живёт в config.json (`topics`),
//: а не в коде. Пустой список — ищем только прямые упоминания и личку.
const МОИ_ТЕМЫ = (readConfig().topics ?? []).map((t) => String(t).toLowerCase()).filter(Boolean);

server.registerTool(
  'answer_pending',
  {
    title: 'Вопросы ко мне без ответа',
    description:
      'Вопросы, адресованные мне за последние дни, после которых я в том же чате ничего не написал. ' +
      'Считает по зеркалу, в Bitrix не ходит. Признак грубый: показывает лишнее охотнее, чем пропускает. ' +
      'Ответить можно через im_send_message (bitrix24) — этот сервер не пишет в Bitrix.',
    inputSchema: {
      days: z.number().optional().describe('окно в днях, по умолчанию 7'),
      chat: z.string().optional().describe('ограничить чатом, например chat13851'),
    },
  },
  async ({ days = 7, chat }) => {
    const { since, messages, myLastByDialog } = attentionWindow(days);
    const найдено = pendingQuestions(messages, { selfId: selfId(), myLastByDialog, topics: МОИ_ТЕМЫ })
      .filter((q) => !chat || q.dialog_id === chat);
    if (!найдено.length) return text(`Вопросов без ответа за ${days} дн. не нашлось (с ${since.slice(0, 10)}).`);
    return text(
      found(найдено, (q) => `${fmt(q)} · ${q.reason}\n${q.text.slice(0, 400)}`) +
      '\n\nОкружение: chat_context(message_id).'
    );
  }
);

server.registerTool(
  'my_promises',
  {
    title: 'Что я пообещал',
    description:
      'Мои же сообщения вида «сделаю / отпишу / пришлю» за последние дни. Выполнено обещание или нет, ' +
      'зеркало не знает — «сделаю» закрывается коммитом, а не сообщением; поэтому помечается только то, ' +
      'писал ли я в этом чате после (silent_since). Молчание после обещания — самый частый случай забытого.',
    inputSchema: {
      days: z.number().optional().describe('окно в днях, по умолчанию 14'),
      silent_only: z.boolean().optional().describe('только те, после которых я в чате молчу'),
    },
  },
  async ({ days = 14, silent_only = false }) => {
    const { since, messages, myLastByDialog } = attentionWindow(days);
    const найдено = openPromises(messages, { selfId: selfId(), myLastByDialog })
      .filter((p) => !silent_only || p.silent_since);
    if (!найдено.length) return text(`Обещаний за ${days} дн. не нашлось (с ${since.slice(0, 10)}).`);
    return text(found(найдено, (p) => `${fmt(p)}${p.silent_since ? ' · после этого молчу' : ''}\n${p.text.slice(0, 400)}`));
  }
);


await server.connect(new StdioServerTransport());
