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
const hasKey = env('ANTHROPIC_API_KEY', '') !== '';
const forceMock = env('TRIAGE_FORCE_MOCK', 'false').toLowerCase() === 'true';
const mode = hasKey && !forceMock ? 'llm' : 'mock';
const model = env('LLM_MODEL', 'claude-haiku-4-5-20251001');
const maxTokens = Math.max(200, Math.min(2000, Math.round(envNum('LLM_MAX_TOKENS', 600))));
const priceIn = envNum('PRICE_INPUT_USD_PER_MTOK', 1);
const priceOut = envNum('PRICE_OUTPUT_USD_PER_MTOK', 5);

// Резерв на худший случай: две попытки, вход ~ системный промпт + текст
// (консервативно 1 токен на символ), выход = max_tokens.
const estInput = 900 + masked.text.length;
const reserveUsd = 2 * (estInput * priceIn + maxTokens * priceOut) / 1e6;

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
  price_in: priceIn,
  price_out: priceOut,
  reserve_usd: Math.round(reserveUsd * 1e6) / 1e6,
  daily_budget_usd: envNum('DAILY_BUDGET_USD', 0.5),
  limit_ip_hour: envNum('RATE_LIMIT_PER_IP_HOUR', 5),
  limit_global_hour: envNum('RATE_LIMIT_GLOBAL_HOUR', 60),
  trust_proxy_header: trust,
};
if (mode === 'llm' && !inputError) ctx.llm_body = buildLlmBody(ctx.text_masked, model, maxTokens, null);
return [{ json: ctx }];
