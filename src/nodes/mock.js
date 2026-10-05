// Mock-режим: заглушка по ключевым словам вместо LLM, 0 токенов.
const ctx = $input.first().json;
return [{
  json: {
    ...ctx,
    triage: mockTriage(ctx.text_masked),
    result_mode: 'mock',
    attempts: 0,
    tokens_in: 0,
    tokens_out: 0,
    llm_error: null,
    warnings: [],
    t_mock: Date.now(),
  },
}];
