// Вежливый отказ: неверный ввод (400) или сработал лимит (429).
const c = $input.first().json;
const messages = {
  bad_request: 'Ожидается JSON вида {"text": "текст заявки"}.',
  empty: 'Заявка пустая. Опишите, что нужно сделать.',
  too_long: 'Текст длиннее 1000 символов (' + c.text_len + '). Сократите и отправьте снова.',
  rate_limited_ip: 'Это демо: не больше ' + c.limit_ip_hour + ' заявок в час с одного адреса. Попробуйте через час.',
  rate_limited_global: 'Демо перегружено: общий лимит ' + c.limit_global_hour + ' заявок в час ' + (c.source === 'form' ? 'через форму' : 'через API') + ' исчерпан. Попробуйте позже.',
  daily_budget: 'Дневной бюджет демо на LLM исчерпан: потрачено ' + formatUsd(c.spent_today_usd) + ' из ' + formatUsd(c.daily_budget_usd) + '. Попробуйте завтра.',
};
const message = messages[c.decision] || 'Заявку не удалось принять.';
return [{
  json: {
    source: c.source,
    http_status: c.http_status,
    response: {
      ok: false,
      error: c.decision,
      message,
      spent_today_usd: c.spent_today_usd,
      daily_budget_usd: c.daily_budget_usd,
    },
    form_title: 'Заявка не принята',
    form_message: escapeHtml(message),
  },
}];
