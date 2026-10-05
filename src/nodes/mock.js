// Mock-режим: заглушка по ключевым словам вместо LLM, стоимость 0.
const ctx = $input.first().json;
return [{
  json: {
    ...ctx,
    triage: mockTriage(ctx.text_masked),
    result_mode: 'mock',
    attempts: 0,
    cost_usd: 0,
    llm_error: null,
    warnings: [],
  },
}];
