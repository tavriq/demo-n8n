// Подготовка: вход из вебхука или формы -> проверка текста, маскирование,
// ключ клиента (HMAC от IP), режим (llm/mock), лимиты из env.
const crypto = require('crypto');

const MAX_LEN = 1000;
const inJson = $input.first().json;
const fromForm = Object.prototype.hasOwnProperty.call(inJson, 'submittedAt')
  || Object.prototype.hasOwnProperty.call(inJson, 'formMode');

const env = (name, def) => {
  const v = $env[name];
  return v === undefined || v === null || String(v).trim() === '' ? def : String(v).trim();
};
const envNum = (name, def) => {
  const n = Number(env(name, String(def)));
  return Number.isFinite(n) && n >= 0 ? n : def;
};
// цена не задана или не число -> null: рубли не считаются, учёт только в токенах
const envPrice = (name) => {
  const v = env(name, '');
  const n = Number(v.replace(',', '.'));
  return v !== '' && Number.isFinite(n) && n >= 0 ? n : null;
};

const headers = {};
for (const [k, v] of Object.entries(inJson.headers || {})) headers[String(k).toLowerCase()] = v;

let raw;
let inputError = null;
if (fromForm) {
  raw = inJson.text;
} else {
  const body = inJson.body;
  raw = body && typeof body === 'object' && !Array.isArray(body) ? body.text : undefined;
}
if (typeof raw !== 'string') { inputError = fromForm ? 'empty' : 'bad_request'; raw = ''; }
const trimmed = raw.replace(/\r\n/g, '\n').trim();
if (!inputError && !trimmed) inputError = 'empty';
if (!inputError && trimmed.length > MAX_LEN) inputError = 'too_long';

// IP клиента. n8n слушает только 127.0.0.1, адрес может сообщить только обратный прокси,
// и верить заголовку можно, только если прокси его перезаписывает. Какому заголовку
// верить, задаёт TRUST_PROXY_HEADER; по умолчанию 'direct': заголовки игнорируются,
// все заявки делят один ключ (иначе клиент подставил бы свой X-Real-IP и обошёл лимит).
//   x-real-ip         nginx с proxy_set_header X-Real-IP $remote_addr
//   cf-connecting-ip  Cloudflare (заголовок ставит сам Cloudflare)
//   xff-last          последний адрес X-Forwarded-For: его дописал ближайший прокси
const trust = env('TRUST_PROXY_HEADER', 'direct').toLowerCase();
let ip = null;
if (trust === 'x-real-ip' || trust === 'cf-connecting-ip') {
  if (headers[trust]) ip = String(headers[trust]).trim();
} else if (trust === 'xff-last' && headers['x-forwarded-for']) {
  const parts = String(headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length) ip = parts[parts.length - 1];
}
const salt = env('IP_HASH_SALT', 'no-salt');
const clientKey = ip ? crypto.createHmac('sha256', salt).update(ip).digest('hex').slice(0, 16) : 'direct';

// Токен прогонов evals снимает лимиты в час, но не дневной бюджет.
const evalToken = env('EVAL_BYPASS_TOKEN', '');
const sentToken = String(headers['x-eval-token'] || '');
let isEval = false;
if (evalToken.length >= 16 && sentToken.length === evalToken.length) {
  isEval = crypto.timingSafeEqual(Buffer.from(sentToken), Buffer.from(evalToken));
}

const masked = maskPII(trimmed.slice(0, MAX_LEN));
// LLM: OpenAI-совместимый chat/completions. Ключ и адрес шлюза приходят из env
// (на сервере — общий файл ../llm.env, см. docker-compose.yml); модель — LLM_MODEL,
// если пусто — LLM_MODEL_SMART. Нет ключа, адреса или модели -> mock.
const model = env('LLM_MODEL', env('LLM_MODEL_SMART', ''));
const hasLlm = env('LLM_API_KEY', '') !== '' && env('LLM_BASE_URL', '') !== '' && model !== '';
const forceMock = env('TRIAGE_FORCE_MOCK', 'false').toLowerCase() === 'true';
const mode = hasLlm && !forceMock ? 'llm' : 'mock';
const maxTokens = Math.max(200, Math.min(2000, Math.round(envNum('LLM_MAX_TOKENS', 600))));
const effort = env('LLM_REASONING_EFFORT', '').toLowerCase();
const reasoningEffort = /^[a-z]{1,16}$/.test(effort) ? effort : null;

// Резерв токенов на худший случай: две попытки, вход ~ системный промпт со схемой
// (по замеру ~550 токенов) + текст (консервативно 1 токен на символ), выход = max_tokens.
const reserveTokens = 2 * (900 + masked.text.length + maxTokens);

const ctx = {
  source: isEval ? 'eval' : (fromForm ? 'form' : 'api'),
  input_error: inputError,
  text_len: trimmed.length,
  text_masked: inputError ? '' : masked.text,
  pii_masked: masked.total,
  client_key: clientKey,
  bypass_hourly: isEval,
  now_ms: Date.now(),
  day: $now.toFormat('yyyy-MM-dd'),
  mode,
  model,
  max_tokens: maxTokens,
  reasoning_effort: reasoningEffort,
  reserve_tokens: reserveTokens,
  daily_token_budget: Math.round(envNum('DAILY_TOKEN_BUDGET', 200000)),
  price_rub_in: envPrice('PRICE_RUB_PER_1M_INPUT'),
  price_rub_out: envPrice('PRICE_RUB_PER_1M_OUTPUT'),
  limit_ip_hour: envNum('RATE_LIMIT_PER_IP_HOUR', 5),
  limit_global_hour: envNum('RATE_LIMIT_GLOBAL_HOUR', 60),
  trust_proxy_header: trust,
};
if (mode === 'llm' && !inputError) {
  ctx.llm_body = buildLlmBody(ctx.text_masked, model, maxTokens, null, reasoningEffort);
}
return [{ json: ctx }];
