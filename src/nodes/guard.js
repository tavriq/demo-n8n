// Cost guard: решение «обрабатывать или вежливо отказать».
// Вход: строки журнала за последние 24 часа (Data Table). Исполнения идут
// по одному (N8N_CONCURRENCY_PRODUCTION_LIMIT=1), поэтому проверка и запись
// не гоняются друг с другом.
const ctx = $('Подготовка').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r && r.ts !== undefined && r.ts !== null);

const hourAgo = ctx.now_ms - 3600 * 1000;
const lastHour = rows.filter((r) => Number(r.ts) >= hourAgo);
const ipHour = lastHour.filter((r) => r.client_key === ctx.client_key).length;
const spentToday = rows
  .filter((r) => r.day === ctx.day)
  .reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);

let decision = 'allow';
let httpStatus = 200;
if (ctx.input_error) {
  decision = ctx.input_error;
  httpStatus = 400;
} else if (!ctx.bypass_hourly && ipHour >= ctx.limit_ip_hour) {
  decision = 'rate_limited_ip';
  httpStatus = 429;
} else if (!ctx.bypass_hourly && lastHour.length >= ctx.limit_global_hour) {
  decision = 'rate_limited_global';
  httpStatus = 429;
} else if (ctx.mode === 'llm' && spentToday + ctx.reserve_usd > ctx.daily_budget_usd) {
  decision = 'daily_budget';
  httpStatus = 429;
}

return [{
  json: {
    ...ctx,
    decision,
    allowed: decision === 'allow',
    http_status: httpStatus,
    spent_today_usd: Math.round(spentToday * 1e6) / 1e6,
    ip_requests_last_hour: ipHour,
    requests_last_hour: lastHour.length,
  },
}];
