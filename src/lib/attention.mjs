// Что просело между чатами: чужие вопросы без ответа и мои же обещания.
//
// Обе вещи теряются одинаково — сообщение прочитано, ответ отложен «на потом»,
// и «потом» не наступает. Типичный случай: коллега спрашивает, почему работа
// не сделана, хотя договорились, — а она в это время шла, просто он об этом
// не знал.
//
// Логика намеренно грубая: точного «ответа именно на это» из зеркала не
// достать. Ложно-положительное дешевле пропущенного вопроса.

/** Вопрос в рабочем чате часто пишут без знака вопроса: «Что можно проверить
 *  с такой ошибкой.» — по одному «?» он теряется. */
export const СПРАШИВАЮТ = new RegExp(
  '(подскажи\\w*|поясни\\w*|посмотри\\w*|глян\\w+|что\\s+(?:можно|делать|не так)|' +
  'как\\s+(?:быть|проверить|починить|исправить)|почему|не\\s+работает|' +
  'есть\\s+ли|можно\\s+ли|нужна\\s+помощь|help)', 'i');

/** Обещание — это будущее время от первого лица. «Сделал» и «сделаю» отличаются
 *  одной буквой и противоположны по смыслу, поэтому шаблоны точные. */
export const ОБЕЩАЮ = new RegExp(
  '(сделаю|доделаю|починю|поправлю|исправлю|проверю|посмотрю|гляну|уточню|' +
  'напишу|отпишу|отпишусь|пришлю|скину|отправлю|выложу|задеплою|выкачу|' +
  'заведу|создам|соберу|подготовлю|разберусь|вернусь\\s+с|сообщу|дам\\s+знать|' +
  'буду\\s+делать|займусь)', 'i');

/** Владелец вебхука — это и есть «я»: его id стоит в самом URL
 *  (`/rest/45/секрет/`). Сеть для этого не нужна, секрет наружу не идёт. */
export function selfIdFromWebhook(url) {
  const id = Number(String(url).match(/\/rest\/(\d+)\//)?.[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Личный диалог в Bitrix адресуется id собеседника, групповой — `chatNNN`. */
export const isDirect = (dialogId) => /^\d+$/.test(String(dialogId));

/** Служебные сообщения портала: звонки, приглашения, отметки BitrixGPT.
 *  Автор 0 — сам портал. */
export function isSystemMessage(m) {
  if (Number(m.author_id) === 0) return true;
  const t = String(m.text || '');
  return /^(Начат звонок|Звонок завершён|Это сообщение было удалено)/.test(t.trim());
}

/** BB-код в тексте мешает и поиску, и чтению в выдаче. */
export const plainText = (raw) =>
  String(raw || '')
    .replace(/\[USER=\d+[^\]]*\]([^[]*)\[\/USER\]/gi, '$1')
    .replace(/\[URL=[^\]]*\]([^[]*)\[\/URL\]/gi, '$1')
    .replace(/\[\/?[A-Z][^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Ссылка с query-строкой (`...?from_project_id=26`) приносит знак вопроса в
 *  сообщение, где вопроса нет: так ссылка на сравнение веток попала в список
 *  ожидающих ответа. Для проверки на вопрос ссылки выбрасываем. */
export const withoutLinks = (text) => String(text).replace(/https?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();

const mentionsMe = (raw, selfId) => new RegExp(`\\[USER=${selfId}[^\\]]*\\]`, 'i').test(String(raw || ''));

/** Тема ищется по началу слова, а не подстрокой. «бот» внутри «работа» и «чек»
 *  внутри «человек» превращали чужие дейли в вопросы ко мне: за 14 дней так
 *  налипла половина выдачи. */
export function matchesTopics(text, topics) {
  if (!topics.length) return false;
  const rx = new RegExp(`(?:^|[^\\p{L}])(?:${topics.join('|')})\\p{L}*`, 'iu');
  return rx.test(text);
}

/**
 * Вопросы ко мне, после которых я в том же чате ничего не написал.
 *
 * `myLastByDialog` — дата моего последнего сообщения в каждом чате. Если я
 * писал после вопроса, тема почти наверняка разобрана: точнее из зеркала не
 * узнать, а вечное напоминание про закрытый вопрос хуже пропуска.
 */
export function pendingQuestions(messages, { selfId, myLastByDialog = {}, topics = [] } = {}) {
  const out = [];
  for (const m of messages) {
    if (Number(m.author_id) === selfId || isSystemMessage(m)) continue;
    const text = plainText(m.text);
    if (text.length < 15) continue;
    const askable = withoutLinks(text);
    if (!askable.includes('?') && !СПРАШИВАЮТ.test(askable)) continue;

    const mine = mentionsMe(m.text, selfId);
    const direct = isDirect(m.dialog_id);
    const onTopic = matchesTopics(text, topics);
    if (!(mine || direct || onTopic)) continue;

    const answered = myLastByDialog[m.dialog_id] && myLastByDialog[m.dialog_id] > m.date;
    if (answered) continue;

    out.push({
      id: m.id, dialog_id: m.dialog_id, author_id: m.author_id, date: m.date, text,
      reason: mine ? 'упомянут' : direct ? 'личка' : 'моя тема',
    });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Мои обещания и то, что было в чате после них.
 *
 * Выполнено обещание или нет, зеркало не знает: «сделаю» закрывается коммитом,
 * а не сообщением. Поэтому инструмент не решает за человека — он показывает
 * обещание и говорит, писал ли я в этом чате после. Молчание после обещания —
 * самый частый случай забытого.
 */
export function openPromises(messages, { selfId, myLastByDialog = {} } = {}) {
  const out = [];
  for (const m of messages) {
    if (Number(m.author_id) !== selfId || isSystemMessage(m)) continue;
    const text = plainText(m.text);
    if (text.length < 10 || !ОБЕЩАЮ.test(text)) continue;
    const last = myLastByDialog[m.dialog_id];
    out.push({
      id: m.id, dialog_id: m.dialog_id, author_id: selfId, date: m.date, text,
      silent_since: !last || last <= m.date,
    });
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
