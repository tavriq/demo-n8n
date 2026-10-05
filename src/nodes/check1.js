// Проверка ответа Claude, попытка 1. Невалидно -> готовим повтор с перечнем ошибок.
const ctx = $('Cost guard').first().json;
const r = parseLlmResponse($input.first().json, ctx.price_in, ctx.price_out);
const base = { ...ctx };
delete base.llm_body;
if (r.ok) {
  return [{ json: { ...base, valid: true, triage: r.value, result_mode: 'llm', attempts: 1,
    cost_usd: r.cost_usd, usage: r.usage, llm_error: null, warnings: r.warnings || [] } }];
}
return [{ json: { ...base, valid: false, triage: null, attempts: 1, cost_usd: r.cost_usd,
  llm_error: r.errors.join('; ').slice(0, 300), warnings: [],
  llm_body: buildLlmBody(ctx.text_masked, ctx.model, ctx.max_tokens, r.errors.slice(0, 5)) } }];
