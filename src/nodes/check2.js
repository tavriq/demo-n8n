// Проверка ответа модели, попытка 2 (последняя). Снова невалидно -> заглушка needs_human=true.
const prev = $('Проверка ответа #1').first().json;
const r = parseLlmResponse($input.first().json);
const base = { ...prev };
delete base.llm_body;
// токены обеих попыток: за первую тоже заплачено
const tokens = {
  tokens_in: (Number(prev.tokens_in) || 0) + r.usage.input_tokens,
  tokens_out: (Number(prev.tokens_out) || 0) + r.usage.output_tokens,
};
if (r.ok) {
  return [{ json: { ...base, ...tokens, valid: true, triage: r.value, result_mode: 'llm', attempts: 2,
    llm_error: null, warnings: (r.warnings || []).concat(['со второй попытки']) } }];
}
return [{ json: { ...base, ...tokens, valid: false, triage: fallbackTriage(), result_mode: 'llm_fallback', attempts: 2,
  llm_error: (prev.llm_error + ' | ' + r.errors.join('; ')).slice(0, 300), warnings: [] } }];
