// Итог: строка журнала ровно под колонки Data Table triage_log.
const c = $input.first().json;
const t = c.triage;
return [{
  json: {
    ts: c.now_ms,
    day: c.day,
    created_at: new Date(c.now_ms).toISOString(),
    source: c.source,
    client_key: c.client_key,
    text_masked: c.text_masked,
    pii_masked: c.pii_masked,
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
    cost_usd: Math.round((Number(c.cost_usd) || 0) * 1e6) / 1e6,
    model: c.result_mode === 'mock' ? 'mock' : c.model,
    llm_error: c.llm_error || '',
  },
}];
