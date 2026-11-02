// Правила поверх ответа модели или заглушки (src/lib/escalation.js): звать ли менеджера
// и какие поля поправить. Решает код по тексту заявки и полям, а не самооценка модели.
// Поводы и поправки уходят в трассу ответа API («Ответ: результат»), в журнал — только поля.
const c = $input.first().json;
// флаг needs_human из ответа: у модели и заглушки это их мнение, у заглушки после двух
// неудач — не мнение (повод «модель не дала валидный ответ» пишет «Ответ: результат»)
const flagLabel = c.result_mode === 'llm' ? 'модель отметила «нужен человек»'
  : c.result_mode === 'mock' ? 'заглушка отметила «нужен человек»' : null;
const r = applyEscalationRules(c.text_masked, c.triage, flagLabel);
const warnings = r.fixes.map((f) => f.text);
if (r.triage.needs_human !== c.triage.needs_human) warnings.push('needs_human выставлен правилом');
return [{
  json: {
    ...c,
    triage: r.triage,
    rules: { reasons: r.reasons, fixes: r.fixes, warnings, model_needs_human: c.triage.needs_human },
    t_rules: Date.now(),
  },
}];
