// Ответ клиенту: JSON для API, экранированный текст для страницы формы.
const row = $('Итог').first().json;
const guard = $('Cost guard').first().json;
const spent = Math.round(((Number(guard.spent_today_usd) || 0) + row.cost_usd) * 1e6) / 1e6;
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
        cost_usd: row.cost_usd,
        spent_today_usd: spent,
        daily_budget_usd: guard.daily_budget_usd,
        model: row.model,
      },
    },
    form_title: 'Заявка разобрана',
    form_message: escapeHtml(lines.join('\n')),
  },
}];
