// Итог: строка журнала ровно под колонки Data Table triage_log.
// Ответ модели маскируется ещё раз: контакт, записанный в заявке словами или
// через «собака/точка», модель могла переписать цифрами в summary или next_step.
const c = $input.first().json;
const t = { ...c.triage };
let outPii = 0;
for (const f of ['summary', 'next_step', 'city']) {
  if (typeof t[f] !== 'string') continue;
  const m = maskPII(t[f]);
  if (m.total) { t[f] = m.text; outPii += m.total; }
}
if (outPii) {
  if (t.city && /скрыт/.test(t.city)) t.city = null;
  t.needs_human = true;
}
return [{
  json: {
    ts: c.now_ms,
    day: c.day,
    created_at: new Date(c.now_ms).toISOString(),
    source: c.source,
    client_key: c.client_key,
    text_masked: c.text_masked,
    pii_masked: c.pii_masked + outPii,
    category: t.category,
    urgency: t.urgency,
    city: t.city,
    budget_rub: t.budget_rub,
    summary: t.summary,
    next_step: t.next_step,
    needs_human: t.needs_human,
    confidence: t.confidence,
    mode: c.result_mode,
    attempts: c.attempts,
    tokens_in: Math.round(Number(c.tokens_in) || 0),
    tokens_out: Math.round(Number(c.tokens_out) || 0),
    model: c.result_mode === 'mock' ? 'mock' : c.model,
    llm_error: outPii ? ('в ответе модели скрыто контактов: ' + outPii + (c.llm_error ? ' | ' + c.llm_error : '')).slice(0, 300) : (c.llm_error || ''),
  },
}];
