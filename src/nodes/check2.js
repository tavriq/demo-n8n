// Проверка ответа модели, попытка 2 (последняя). Снова невалидно -> заглушка needs_human=true.
const tLlm = Date.now();
const prev = $('Проверка ответа #1').first().json;
const r = parseLlmResponse($input.first().json);
const base = { ...prev };
delete base.llm_body;
// токены обеих попыток: за первую тоже заплачено
const tokens = {
  tokens_in: (Number(prev.tokens_in) || 0) + r.usage.input_tokens,
  tokens_out: (Number(prev.tokens_out) || 0) + r.usage.output_tokens,
};
const trace = { raw_2: r.raw === undefined ? null : r.raw, errors_2: r.errors, t_llm2: tLlm };
if (r.ok) {
  return [{ json: { ...base, ...tokens, ...trace, valid: true, triage: r.value, result_mode: 'llm', attempts: 2,
    llm_error: null, warnings: (r.warnings || []).concat(['со второй попытки']), t_check2: Date.now() } }];
}
return [{ json: { ...base, ...tokens, ...trace, valid: false, triage: fallbackTriage(), result_mode: 'llm_fallback', attempts: 2,
  llm_error: (prev.llm_error + ' | ' + r.errors.join('; ')).slice(0, 300), warnings: [], t_check2: Date.now() } }];
