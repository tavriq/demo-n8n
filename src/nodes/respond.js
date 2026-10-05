// Ответ клиенту: JSON для API, экранированный текст для страницы формы.
// meta.trace — как прошла заявка: тайминги шагов, сырые ответы модели, итог проверки,
// маршрут и счётчик лимита. По нему песочница на корне демо рисует схему.
const tRespond = Date.now();
const row = $('Итог').first().json;
const guard = $('Cost guard').first().json;
// нода, которая в этом исполнении не запускалась (mock, нет повтора), даёт null
const ran = (name) => {
  try {
    const node = $(name);
    if (node.isExecuted === false) return null;
    const item = node.first();
    return item ? item.json : null;
  } catch (e) {
    return null;
  }
};
const c1 = ran('Проверка ответа #1');
const c2 = ran('Проверка ответа #2');
const mk = ran('Mock-классификатор');
const tokensToday = (Number(guard.tokens_today) || 0) + row.tokens_in + row.tokens_out;
const rub = costRub(row.tokens_in, row.tokens_out, guard.price_rub_in, guard.price_rub_out);
const result = {
  category: row.category,
  urgency: row.urgency,
  city: row.city,
  budget_rub: row.budget_rub,
  summary: row.summary,
  next_step: row.next_step,
  needs_human: row.needs_human,
  confidence: row.confidence,
};

const span = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null);
const tChecked = c2 ? c2.t_check2 : c1 ? c1.t_check1 : mk ? mk.t_mock : null;
const timings = {
  mask: span(guard.t_start, guard.t_masked),
  limits: span(guard.t_masked, guard.t_guard),
  model: mk ? span(guard.t_guard, mk.t_mock) : span(guard.t_guard, c1 && c1.t_llm1),
  check: c1 ? span(c1.t_llm1, c1.t_check1) : null,
  retry: c2 ? span(c1.t_check1, c2.t_check2) : null,
  route: span(tChecked, tRespond),
  total: span(guard.t_start, tRespond),
};
// ответ модели мог «восстановить» контакт из заявки: в трассу он идёт замаскированным
const rawOut = (raw) => (typeof raw === 'string' ? maskPII(raw).text : null);
const attemptsLog = [];
if (c1) attemptsLog.push({ attempt: 1, ok: c1.valid === true, errors: c1.errors_1 || [], raw: rawOut(c1.raw_1) });
if (c2) attemptsLog.push({ attempt: 2, ok: c2.valid === true, errors: c2.errors_2 || [], raw: rawOut(c2.raw_2) });
const last = c2 || c1;
const checkWarnings = last && last.valid ? (last.warnings || []).slice() : [];
if (/в ответе модели скрыто/.test(row.llm_error || '')) checkWarnings.push('контакт в ответе модели скрыт, needs_human выставлен');

const reasons = [];
if (row.category === 'complaint') reasons.push('жалоба');
if (row.urgency === 'high') reasons.push('срочно');
if (row.mode === 'llm_fallback') reasons.push('модель не дала валидный ответ за 2 попытки');
else if (row.confidence < 0.6) reasons.push('уверенность ' + row.confidence);
if (row.needs_human && !reasons.length) reasons.push('нужен человек');
const toManager = row.needs_human === true || row.urgency === 'high';

const trace = {
  timings_ms: timings,
  attempts: attemptsLog,
  check: {
    ok: row.mode !== 'llm_fallback',
    fallback: row.mode === 'llm_fallback',
    warnings: checkWarnings,
  },
  route: {
    to: toManager ? 'manager' : 'queue',
    reasons,
    telegram: 'в демо выключен',
  },
  limits: {
    ip_used: guard.bypass_hourly ? null : (Number(guard.ip_requests_last_hour) || 0) + 1,
    ip_limit: guard.limit_ip_hour,
  },
};

const lines = [
  'Категория: ' + (LABEL_CATEGORY[row.category] || row.category),
  'Срочность: ' + (LABEL_URGENCY[row.urgency] || row.urgency),
  'Город: ' + (row.city || 'не указан'),
  'Бюджет: ' + (row.budget_rub != null ? row.budget_rub + ' ₽' : 'не указан'),
  'Суть: ' + row.summary,
  'Следующий шаг: ' + row.next_step,
  'Нужен человек: ' + (row.needs_human ? 'да' : 'нет'),
  'Режим: ' + row.mode + (row.mode === 'mock' ? ' (заглушка без LLM)' : ''),
];
if (row.mode !== 'mock') {
  lines.push('Модель: ' + row.model + ', токенов: ' + formatInt(row.tokens_in + row.tokens_out)
    + (rub !== null ? ' (≈ ' + formatRub(rub) + ')' : ''));
}
if (row.pii_masked > 0) lines.push('Контакты в тексте замаскированы: ' + row.pii_masked);
lines.push('', 'Заявка появится на публичной доске.');
return [{
  json: {
    source: row.source,
    http_status: 200,
    response: {
      ok: true,
      mode: row.mode,
      result,
      meta: {
        text_masked: row.text_masked,
        pii_masked: row.pii_masked,
        attempts: row.attempts,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        cost_rub: rub,
        tokens_today: tokensToday,
        daily_token_budget: guard.daily_token_budget,
        model: row.model,
        reasoning_effort: row.mode === 'mock' ? null : guard.reasoning_effort,
        trace,
      },
    },
    form_title: 'Заявка разобрана',
    form_message: escapeHtml(lines.join('\n')),
  },
}];
