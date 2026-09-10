// Тонкий клиент Bitrix24 REST.
// Намеренно не зависим от bitrix24-local-mcp как от процесса — делим только креденшл,
// чтобы падение или обновление одного не ломало другой.
import { config as loadEnv } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Читает KEY=VALUE из .env без внешних зависимостей. */
function envFrom(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Свой .env, иначе — соседний bitrix24-local-mcp: один секрет на две тулзы. */
export function webhookUrl() {
  const own = envFrom(join(ROOT, '.env')).BITRIX24_WEBHOOK_URL;
  const neighbour = envFrom(join(ROOT, '..', 'bitrix24-local-mcp', '.env')).BITRIX24_WEBHOOK_URL;
  const url = process.env.BITRIX24_WEBHOOK_URL || own || neighbour;
  if (!url) {
    throw new Error(
      'Не найден BITRIX24_WEBHOOK_URL. Заведите .env (см. .env.example) ' +
        'или положите его в ../bitrix24-local-mcp/.env'
    );
  }
  return url.replace(/\/+$/, '');
}

export async function callBitrix(method, params = {}) {
  const res = await fetch(`${webhookUrl()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error_description || json.error}`);
  return json.result;
}

/** Конфиг в git не хранится: в нём перечислены чаты, включая личные переписки —
 *  по одному этому списку видно, с кем человек общается. В репозитории лежит
 *  только пример, с него и начинаем, если своего ещё нет. */
export const readConfig = () => {
  const own = join(ROOT, 'config.json');
  const example = join(ROOT, 'config.example.json');
  return JSON.parse(readFileSync(existsSync(own) ? own : example, 'utf8'));
};
export const CONFIG_PATH = join(ROOT, 'config.json');
