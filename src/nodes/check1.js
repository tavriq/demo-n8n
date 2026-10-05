// Проверка ответа модели, попытка 1. Невалидно -> готовим повтор с перечнем ошибок.
// t_llm1 — когда ответ модели дошёл до проверки, t_check1 — конец проверки.
const tLlm = Date.now();
const ctx = $('Cost guard').first().json;
const r = parseLlmResponse($input.first().json);
const base = { ...ctx };
delete base.llm_body;
const tokens = { tokens_in: r.usage.input_tokens, tokens_out: r.usage.output_tokens };
const trace = { raw_1: r.raw === undefined ? null : r.raw, errors_1: r.errors, t_llm1: tLlm };
if (r.ok) {
  return [{ json: { ...base, ...tokens, ...trace, valid: true, triage: r.value, result_mode: 'llm', attempts: 1,
    llm_error: null, warnings: r.warnings || [], t_check1: Date.now() } }];
}
return [{ json: { ...base, ...tokens, ...trace, valid: false, triage: null, attempts: 1,
  llm_error: r.errors.join('; ').slice(0, 300), warnings: [],
  llm_body: buildLlmBody(ctx.text_masked, ctx.model, ctx.max_tokens, r.errors.slice(0, 5), ctx.reasoning_effort),
  t_check1: Date.now() } }];
