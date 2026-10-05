// Ответ клиенту: JSON для API, экранированный текст для страницы формы.
const row = $('Итог').first().json;
const guard = $('Cost guard').first().json;
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
      },
    },
    form_title: 'Заявка разобрана',
    form_message: escapeHtml(lines.join('\n')),
  },
}];
