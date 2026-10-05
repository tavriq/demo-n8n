// Проверка ответа модели, попытка 1. Невалидно -> готовим повтор с перечнем ошибок.
const ctx = $('Cost guard').first().json;
const r = parseLlmResponse($input.first().json);
const base = { ...ctx };
delete base.llm_body;
const tokens = { tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens };
if (r.ok) {
  return [{ json: { ...base, ...tokens, valid: true, triage: r.value, result_mode: 'llm', attempts: 1,
    llm_error: null, warnings: r.warnings || [] } }];
}
return [{ json: { ...base, ...tokens, valid: false, triage: null, attempts: 1,
  llm_error: r.errors.join('; ').slice(0, 300), warnings: [],
  llm_body: buildLlmBody(ctx.text_masked, ctx.model, ctx.max_tokens, r.errors.slice(0, 5), ctx.reasoning_effort) } }];
