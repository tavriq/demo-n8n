// Проверка ответа Claude, попытка 2 (последняя). Снова невалидно -> заглушка needs_human=true.
const prev = $('Проверка ответа #1').first().json;
const r = parseLlmResponse($input.first().json, prev.price_in, prev.price_out);
const base = { ...prev };
delete base.llm_body;
const cost = (Number(prev.cost_usd) || 0) + r.cost_usd;
if (r.ok) {
  return [{ json: { ...base, valid: true, triage: r.value, result_mode: 'llm', attempts: 2,
    cost_usd: cost, usage: r.usage, llm_error: null, warnings: (r.warnings || []).concat(['со второй попытки']) } }];
}
return [{ json: { ...base, valid: false, triage: fallbackTriage(), result_mode: 'llm_fallback', attempts: 2,
  cost_usd: cost, llm_error: (prev.llm_error + ' | ' + r.errors.join('; ')).slice(0, 300), warnings: [] } }];
