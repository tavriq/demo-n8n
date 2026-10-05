// Cost guard: решение «обрабатывать или вежливо отказать».
// Вход: строки журнала за последние 24 часа (Data Table). Исполнения идут
// по одному (N8N_CONCURRENCY_PRODUCTION_LIMIT=1), поэтому проверка и запись
// не гоняются друг с другом.
const ctx = $('Подготовка').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r && r.ts !== undefined && r.ts !== null);

const hourAgo = ctx.now_ms - 3600 * 1000;
// служебные прогоны (evals, smoke) не съедают лимиты в час живых пользователей,
// но их расход входит в дневной бюджет
const lastHour = rows.filter((r) => Number(r.ts) >= hourAgo && r.source !== 'eval');
const ipHour = lastHour.filter((r) => r.client_key === ctx.client_key).length;
// общий лимит считается отдельно для формы и для API: скрипт, выбравший лимит API,
// не закрывает форму для посетителей. Деньги при этом защищает дневной бюджет.
const sourceHour = lastHour.filter((r) => r.source === ctx.source).length;
// дневной лимит считается в токенах (вход + выход, все попытки): цены провайдера
// в настройках не обязательны, а токены приходят в usage каждого ответа
const tokensToday = rows
  .filter((r) => r.day === ctx.day)
  .reduce((s, r) => s + (Number(r.tokens_in) || 0) + (Number(r.tokens_out) || 0), 0);

let decision = 'allow';
let httpStatus = 200;
if (ctx.input_error) {
  decision = ctx.input_error;
  httpStatus = 400;
} else if (!ctx.bypass_hourly && ipHour >= ctx.limit_ip_hour) {
  decision = 'rate_limited_ip';
  httpStatus = 429;
} else if (!ctx.bypass_hourly && sourceHour >= ctx.limit_global_hour) {
  decision = 'rate_limited_global';
  httpStatus = 429;
} else if (ctx.mode === 'llm' && tokensToday + ctx.reserve_tokens > ctx.daily_token_budget) {
  decision = 'daily_budget';
  httpStatus = 429;
}

return [{
  json: {
    ...ctx,
    decision,
    allowed: decision === 'allow',
    http_status: httpStatus,
    tokens_today: tokensToday,
    ip_requests_last_hour: ipHour,
    requests_last_hour: lastHour.length,
    source_requests_last_hour: sourceHour,
    t_guard: Date.now(),
  },
}];
