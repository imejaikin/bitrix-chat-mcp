import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pendingQuestions, openPromises, selfIdFromWebhook,
  isDirect, isSystemMessage, plainText, matchesTopics,
} from '../src/lib/attention.mjs';

const Я = 45;
const КОЛЛЕГА = 55;

const сообщение = (о) => ({ id: 1, dialog_id: 'chat1001', author_id: КОЛЛЕГА, date: '2026-09-08T11:25:00+03:00', text: '', ...о });

// --- свой id ---------------------------------------------------------------

test('свой id берётся из вебхука без обращения к сети', () => {
  assert.equal(selfIdFromWebhook('https://example.bitrix24.ru/rest/45/секрет/'), 45);
  assert.equal(selfIdFromWebhook('https://example.bitrix24.ru/rest/секрет/'), null);
});

// --- разбор текста ---------------------------------------------------------

test('BB-код не попадает в выдачу', () => {
  assert.equal(plainText('[USER=45]Имя[/USER], [B]привет[/B]'), 'Имя, привет');
  assert.equal(plainText('[URL=https://x]тык[/URL]'), 'тык');
});

test('служебные сообщения портала отбрасываются', () => {
  assert.ok(isSystemMessage(сообщение({ author_id: 0, text: 'BitrixGPT анализирует звонок' })));
  assert.ok(isSystemMessage(сообщение({ text: 'Начат звонок №3929' })));
  assert.ok(!isSystemMessage(сообщение({ text: 'Привет, посмотри пожалуйста' })));
});

test('личный диалог отличается от группового по виду dialog_id', () => {
  assert.ok(isDirect('15'));
  assert.ok(!isDirect('chat13851'));
});

// --- вопросы без ответа ----------------------------------------------------

test('вопрос без знака вопроса всё равно ловится', () => {
  // «Что можно проверить с такой ошибкой.» — вопрос без знака вопроса.
  const вопросы = pendingQuestions(
    [сообщение({ text: '[USER=45]Имя[/USER] что можно проверить с такой ошибкой.' })],
    { selfId: Я },
  );
  assert.equal(вопросы.length, 1);
  assert.equal(вопросы[0].reason, 'упомянут');
});

test('если я писал в чате после вопроса — вопрос считается закрытым', () => {
  const вопрос = сообщение({ text: '[USER=45]Имя[/USER] когда включаем сервис?' });
  assert.equal(pendingQuestions([вопрос], { selfId: Я, myLastByDialog: {} }).length, 1);
  assert.equal(
    pendingQuestions([вопрос], { selfId: Я, myLastByDialog: { chat1001: '2026-09-08T11:32:00+03:00' } }).length,
    0,
    'ответ через семь минут — тема разобрана',
  );
});

test('мой собственный вопрос мне не возвращается', () => {
  const свой = сообщение({ author_id: Я, text: 'А доклады сегодня будут?' });
  assert.equal(pendingQuestions([свой], { selfId: Я }).length, 0);
});

test('в личке вопрос адресован мне и без упоминания', () => {
  const вопросы = pendingQuestions(
    [сообщение({ dialog_id: '15', text: 'Отчёты руками выполняются?' })],
    { selfId: Я },
  );
  assert.equal(вопросы[0].reason, 'личка');
});

test('вопрос по моей теме без упоминания тоже виден', () => {
  const вопросы = pendingQuestions(
    [сообщение({ dialog_id: 'chat1002', text: 'А биллинг новую версию когда выкатывают?' })],
    { selfId: Я, topics: ['биллинг'] },
  );
  assert.equal(вопросы[0].reason, 'моя тема');
});

test('чужой разговор не про меня не попадает', () => {
  const чужой = сообщение({ dialog_id: 'chat1002', text: 'А кто-нибудь смотрел этот отчёт по продажам?' });
  assert.equal(pendingQuestions([чужой], { selfId: Я, topics: ['биллинг'] }).length, 0);
});

test('короткая реплика не считается вопросом', () => {
  const короткая = сообщение({ dialog_id: '15', text: 'да?' });
  assert.equal(pendingQuestions([короткая], { selfId: Я }).length, 0);
});

test('вопросы отдаются от старых к свежим — старый ждёт дольше', () => {
  const вопросы = pendingQuestions([
    сообщение({ id: 2, dialog_id: '15', date: '2026-09-09T10:00:00+03:00', text: 'А это когда будет?' }),
    сообщение({ id: 1, dialog_id: '37', date: '2026-09-01T10:00:00+03:00', text: 'Подскажи, что там по задаче' }),
  ], { selfId: Я });
  assert.deepEqual(вопросы.map((q) => q.id), [1, 2]);
});

// --- обещания --------------------------------------------------------------

test('обещание отличается от отчёта о сделанном', () => {
  const мои = [
    сообщение({ id: 1, author_id: Я, text: 'Сейчас тогда заканчиваю самое важное и сегодня постараюсь запустить' }),
    сообщение({ id: 2, author_id: Я, text: 'Я отпишу когда запущу' }),
    сообщение({ id: 3, author_id: Я, text: 'Перепроверил, теперь работает' }),
  ];
  assert.deepEqual(openPromises(мои, { selfId: Я }).map((p) => p.id), [2]);
});

test('чужие обещания — не мои', () => {
  const чужое = сообщение({ text: 'Я посмотрю и отпишу' });
  assert.equal(openPromises([чужое], { selfId: Я }).length, 0);
});

test('silent_since показывает, писал ли я в чате после обещания', () => {
  const обещание = сообщение({ id: 7, author_id: Я, date: '2026-09-08T11:33:00+03:00', text: 'Я отпишу когда запущу' });
  assert.equal(openPromises([обещание], { selfId: Я })[0].silent_since, true);
  assert.equal(
    openPromises([обещание], { selfId: Я, myLastByDialog: { chat1001: '2026-09-08T16:18:00+03:00' } })[0].silent_since,
    false,
  );
});

test('обещание остаётся в списке, даже когда я потом писал', () => {
  // Молчание — сигнал, а не фильтр: «отписал» мог быть про другое.
  const обещание = сообщение({ author_id: Я, text: 'Завтра пришлю отчёт' });
  assert.equal(openPromises([обещание], { selfId: Я, myLastByDialog: { chat1001: '2030-01-01' } }).length, 1);
});

// --- тема ищется по слову, а не подстрокой ---------------------------------

test('«бот» внутри «работа» темой не считается', () => {
  // На живом зеркале за 14 дней подстрочный поиск затащил в выдачу чужие
  // дейли: «работал», «обработка», «человек» — половина списка.
  assert.equal(matchesTopics('Вчера работал над релизом', ['бот']), false);
  assert.equal(matchesTopics('этот человек спрашивал', ['чек']), false);
});

test('словоформы темы ловятся', () => {
  for (const т of ['боту не хватило контекста', 'чек не печатается', 'в биллинге ошибка']) {
    assert.ok(matchesTopics(т, ['биллинг', 'чек', 'бот']), т);
  }
});

test('без списка тем вопрос по теме не ищется', () => {
  assert.equal(matchesTopics('в биллинге ошибка', []), false);
});

test('знак вопроса из ссылки вопросом не считается', () => {
  // Ссылка на сравнение веток тащит «?» из query-строки — вопроса в
  // сообщении нет, а в списке ожидающих ответа оно висело.
  const ссылка = сообщение({
    dialog_id: 'chat1002',
    text: 'diff 0.110.1 ... 0.111.0 https://gitlab.example.com/x/-/compare/a...b?from_project_id=26',
  });
  assert.equal(pendingQuestions([ссылка], { selfId: Я, topics: ['diff'] }).length, 0);
});

test('настоящий вопрос со ссылкой остаётся вопросом', () => {
  const с_ссылкой = сообщение({
    dialog_id: '15',
    text: 'Глянешь https://example.test/x?y=1 — почему бот молчит?',
  });
  assert.equal(pendingQuestions([с_ссылкой], { selfId: Я }).length, 1);
});
