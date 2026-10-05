// Юнит-тесты общих функций Code-нод: node tests/test_lib.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const ctx = {};
vm.createContext(ctx);
for (const f of ['pii', 'mock', 'triage', 'html']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', f + '.js'), 'utf8'), ctx);
}
const { maskPII, mockTriage, validateTriage, parseLlmResponse, buildLlmBody, escapeHtml, formatUsd } =
  vm.runInContext('({ maskPII, mockTriage, validateTriage, parseLlmResponse, buildLlmBody, escapeHtml, formatUsd })', ctx);

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('маскирует телефоны РФ в разных форматах', () => {
  for (const p of ['+7 (999) 123-45-67', '8 999 123 45 67', '89991234567', '+79991234567', '8-999-123-45-67', '999 123 45 67']) {
    const r = maskPII('звоните ' + p + ' вечером');
    assert.equal(r.text, 'звоните [телефон скрыт] вечером', p);
    assert.equal(r.found.phone, 1, p);
  }
});
t('два телефона через пробел', () => {
  assert.equal(maskPII('89991234567 89997654321').text, '[телефон скрыт] [телефон скрыт]');
});
t('международный телефон', () => {
  assert.equal(maskPII('tel +44 20 7946 0958').text, 'tel [телефон скрыт]');
});
t('email и ник', () => {
  const r = maskPII('пишите ivan.petrov@mail.ru или @ivan_petrov');
  assert.equal(r.text, 'пишите [email скрыт] или [ник скрыт]');
  assert.equal(r.total, 2);
});
t('номер карты', () => {
  assert.equal(maskPII('карта 4276 1234 5678 9012').text, 'карта [номер карты скрыт]');
});
t('бюджеты, даты и количества не трогает', () => {
  for (const s of ['бюджет 150 000 руб', 'от 50 000 - 200 000 ₽', 'приезжайте 05.10.2026 10:30', 'нужно 3 машины на 2 дня', 'заказ 1500000']) {
    assert.equal(maskPII(s).text, s, s);
  }
});
t('mock: категории, срочность, город, бюджет', () => {
  let r = mockTriage('Срочно! Сломался генератор на складе в Казани, не включается. Бюджет до 30 тыс');
  assert.equal(r.category, 'repair'); assert.equal(r.urgency, 'high'); assert.equal(r.city, 'Казань'); assert.equal(r.budget_rub, 30000);
  r = mockTriage('Хотим взять в аренду два генератора на выходные для ярмарки в Москве');
  assert.equal(r.category, 'rental'); assert.equal(r.city, 'Москва');
  r = mockTriage('Нужна генеральная уборка офиса после ремонта, 120 м2, Санкт-Петербург, не срочно');
  assert.equal(r.category, 'cleaning'); assert.equal(r.urgency, 'low'); assert.equal(r.city, 'Санкт-Петербург');
  r = mockTriage('Ужасная уборка вчера, всё в разводах. Верните деньги!');
  assert.equal(r.category, 'complaint'); assert.equal(r.needs_human, true);
  r = mockTriage('Пассивный заработок на крипте, переходи https://example.com');
  assert.equal(r.category, 'spam');
  r = mockTriage('добрый день');
  assert.equal(r.category, 'other'); assert.equal(r.needs_human, true);
  assert.ok(r.summary.split(' ').length <= 20);
});
t('validateTriage: валидный ответ и бизнес-правило needs_human', () => {
  const v = validateTriage({ category: 'complaint', urgency: 'normal', city: ' Тула ', budget_rub: 1000.4,
    summary: 'Клиент недоволен', next_step: 'Позвонить', needs_human: false, confidence: 0.9 });
  assert.equal(v.ok, true); assert.equal(v.value.needs_human, true); assert.equal(v.value.city, 'Тула'); assert.equal(v.value.budget_rub, 1000);
});
t('validateTriage: ошибки', () => {
  const v = validateTriage({ category: 'food', urgency: 'normal', city: null, budget_rub: '100',
    summary: '', next_step: 'x', needs_human: 'yes', confidence: 2 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 4);
  assert.equal(validateTriage([1, 2]).ok, false);
});
t('validateTriage: длинный summary обрезается до 20 слов', () => {
  const long = Array.from({ length: 30 }, (_, i) => 'слово' + i).join(' ');
  const v = validateTriage({ category: 'repair', urgency: 'low', city: null, budget_rub: null,
    summary: long, next_step: 'x', needs_human: false, confidence: 0.8 });
  assert.equal(v.ok, true); assert.equal(v.value.summary.split(' ').length, 20);
});
t('parseLlmResponse: успех, стоимость по usage', () => {
  const body = { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200 },
    content: [{ type: 'text', text: JSON.stringify({ category: 'rental', urgency: 'normal', city: null, budget_rub: null,
      summary: 'Аренда', next_step: 'Связаться', needs_human: false, confidence: 0.9 }) }] };
  const r = parseLlmResponse({ statusCode: 200, body }, 1, 5);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.cost_usd - 0.002) < 1e-12);
});
t('parseLlmResponse: невалидный JSON, HTTP-ошибка, сеть', () => {
  const bad = parseLlmResponse({ statusCode: 200, body: { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: '{oops' }] } }, 1, 5);
  assert.equal(bad.ok, false); assert.ok(bad.cost_usd > 0);
  assert.equal(parseLlmResponse({ statusCode: 401, body: { error: { type: 'authentication_error' } } }, 1, 5).ok, false);
  assert.equal(parseLlmResponse({ error: { message: 'ECONNREFUSED' } }, 1, 5).ok, false);
});
t('buildLlmBody: модель, схема, повтор', () => {
  const b = buildLlmBody('текст', 'claude-haiku-4-5-20251001', 600, ['невалидный JSON']);
  assert.equal(b.model, 'claude-haiku-4-5-20251001');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.output_config.format.schema.additionalProperties, false);
  assert.match(b.messages[0].content, /не прошёл проверку/);
});
t('escapeHtml и formatUsd', () => {
  assert.equal(escapeHtml('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
  assert.equal(formatUsd(0.5), '$0.50');
  assert.equal(formatUsd(0.0123), '$0.0123');
});
console.log('ok: ' + n + ' тестов');
