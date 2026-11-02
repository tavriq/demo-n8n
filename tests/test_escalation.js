// Сквозные тесты «звать ли менеджера» и поправок полей: заявка проходит собранный
// workflows/triage-core.json целиком (tests/local_core.js), модель подменена tests/fake_openai.js.
// Ответ модели задан явно:
//   - для 42 кейсов evals/cases.jsonl — тот, что модель дала в живом прогоне 2026-10-05
//     (evals/results-2026-10-05-llm-gpt-5.6-terra.json, поля «got»);
//   - для новых примеров evals/cases-escalation.jsonl — такой же уверенный ответ, как у живой
//     модели: поля по разметке, needs_human=false, confidence 0.95, плюс ошибка, если тест про неё.
// Тест проходит, только если правило в коде исправляет ответ. Живой модели здесь нет: что
// модель ответит на новый промпт, покажет только живой прогон.   node tests/test_escalation.js
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { runCore, startFake, replayAnswers } = require('./local_core');

const ROOT = path.resolve(__dirname, '..');
const readCases = (f) => fs.readFileSync(path.join(ROOT, 'evals', f), 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const RECORDED = path.join(ROOT, 'evals', 'results-2026-10-05-llm-gpt-5.6-terra.json');

const recorded = Object.fromEntries(replayAnswers(RECORDED).map((a) => [a.id, a]));
const newCases = Object.fromEntries(readCases('cases-escalation.jsonl').map((c) => [c.id, c]));
const oldCases = Object.fromEntries(readCases('cases.jsonl').map((c) => [c.id, c]));

// уверенный ответ «как у живой модели» на новый пример: основные метки разметки, человек не нужен
function confident(id, wrong = {}) {
  const c = newCases[id] || oldCases[id];
  if (!c) throw new Error('нет кейса ' + id);
  const e = c.expected;
  return { text: c.text, answer: {
    category: first(e.category), urgency: first(e.urgency), city: first(e.city) ?? null, budget_rub: first(e.budget_rub) ?? null,
    summary: 'Суть заявки', next_step: 'Связаться с клиентом', needs_human: false, confidence: 0.95, ...wrong } };
}
const rec = (id) => ({ text: recorded[id].text, answer: recorded[id].answer });
const text = (s, answer) => ({ text: s, answer: { city: null, budget_rub: null, summary: 'Суть', next_step: 'Связаться',
  needs_human: false, confidence: 0.95, ...answer } });

// сценарии: имя теста -> заявки с ответом модели и проверка результата
const tests = [];
const t = (name, items, check, opts = {}) => tests.push({ name, items, check, ...opts });

const route = (r) => r.response.meta.trace.route;
const result = (r) => r.response.result;
function escalated(r, code) {
  assert.equal(result(r).needs_human, true, 'needs_human');
  assert.equal(route(r).to, 'manager', 'маршрут');
  if (code) assert.ok((route(r).checks || []).includes(code), 'повод ' + code + ', есть: ' + JSON.stringify(route(r).checks));
}
function notEscalated(r) {
  assert.equal(result(r).needs_human, false, 'needs_human: поводы ' + JSON.stringify(route(r).reasons));
}

// ---- ошибки живого прогона: ответ модели тот же, что был 2026-10-05 ----
t('ошибка 1: «Здравствуйте» без сути — модель не звала человека (confidence 0.98) → менеджер, повод no_substance',
  [rec('other-hello')], ([r]) => escalated(r, 'no_substance'));
t('ошибка 1: предложение поставщика крепежа — модель уверенно назвала спамом → менеджер, повод partner_offer',
  [rec('spam-supplier-offer')], ([r]) => escalated(r, 'partner_offer'));
t('ошибка 1: «отремонтировать компрессор и сдать вам в аренду» → менеджер, поводы multiple_requests и partner_offer',
  [rec('repair-then-rent-out')], ([r]) => {
    escalated(r, 'multiple_requests');
    assert.ok(route(r).checks.includes('partner_offer'));
  });
t('ошибка 2: документы для тендера на монтаж вентиляции — модель сказала installation → consultation',
  [rec('consult-tender-docs')], ([r]) => {
    assert.equal(result(r).category, 'consultation');
    assert.ok(route(r).fixes.includes('category_docs'));
    assert.ok(r.response.meta.trace.check.warnings.some((w) => /consultation/.test(w)), 'поправка видна в трассе');
    notEscalated(r);
  });
t('ошибка 3: «аренда бетономешалки на месяц» — модель поставила low → normal (срок аренды — не срок выполнения)',
  [rec('rental-mixer-price')], ([r]) => {
    assert.equal(result(r).urgency, 'normal');
    assert.ok(route(r).fixes.includes('urgency_term'));
    notEscalated(r);
  });
// какие из 42 записанных ответов правила меняют — ровно эти, остальные 36 как были
const EXPECTED_CHANGES = {
  'other-hello': { needs_human: true },
  'spam-supplier-offer': { needs_human: true },
  'repair-then-rent-out': { needs_human: true },
  'consult-tender-docs': { category: 'consultation' },
  'rental-mixer-price': { urgency: 'normal' },
  // две просьбы (монтаж стойки и аренда погрузчика) — по правилу менеджер; в разметке needs_human=false
  'mixed-move-install-rental': { needs_human: true },
};
t('все 42 записанных ответа: правила меняют только 6 кейсов (5 ошибок прогона и mixed-move-install-rental)',
  Object.keys(recorded).map(rec), (rs) => {
    const ids = Object.keys(recorded);
    const changes = {};
    rs.forEach((r, i) => {
      const was = recorded[ids[i]].answer;
      const now = result(r);
      for (const f of ['category', 'urgency', 'needs_human']) {
        // жалобе needs_human=true ставили и раньше (правило «жалоба»), в «got» он уже true
        if (now[f] !== was[f]) (changes[ids[i]] = changes[ids[i]] || {})[f] = now[f];
      }
    });
    assert.deepEqual(changes, EXPECTED_CHANGES);
  });

// ---- проверки пункта 1 на новых примерах: модель уверена и человека не зовёт ----
t('нет сути: одно приветствие, «у меня вопрос», «перезвоните» с телефоном, «меня зовут Олег» → менеджер',
  ['esc-greet-evening', 'esc-greet-question-only', 'esc-greet-callback-phone', 'esc-greet-name-only'].map((id) => confident(id)),
  (rs) => rs.forEach((r) => escalated(r, 'no_substance')));
t('нет просьбы: «Мы небольшая пекарня в Калуге…» без вопроса и просьбы → менеджер',
  [confident('esc-no-request-statement')], ([r]) => escalated(r, 'no_request'));
t('несколько просьб: «почините и заодно установите», «аренда компрессора, а старый в ремонт» → менеджер',
  [confident('esc-multi-repair-install'), confident('esc-multi-rental-repair')],
  (rs) => rs.forEach((r) => escalated(r, 'multiple_requests')));
t('предложение поставщика или партнёра: дилер кабеля (модель: spam), субподряд, «сдать вам в аренду генератор» → менеджер',
  [confident('esc-supplier-cable', { category: 'spam' }), confident('esc-partner-subcontract'), confident('esc-rent-out-generator')],
  (rs) => rs.forEach((r) => escalated(r, 'partner_offer')));
t('поля противоречат: спам со срочностью high → менеджер',
  [text('Пассивный доход от 100 000 в месяц! Без вложений, пиши в лс', { category: 'spam', urgency: 'high' })],
  ([r]) => escalated(r, 'contradiction'));
t('поля противоречат: в тексте претензия, а модель (поддавшись подмене инструкций) сказала repair → менеджер',
  [{ text: oldCases['injection-hide-complaint'].text, answer: { ...confident('injection-hide-complaint').answer, category: 'repair' } }],
  ([r]) => escalated(r, 'contradiction'));
t('поля противоречат: спам, а в тексте просьба о ремонте → менеджер',
  [text('Нужен ремонт посудомоечной машины в кафе, Казань', { category: 'spam', urgency: 'normal' })],
  ([r]) => escalated(r, 'contradiction'));
t('поля противоречат: urgency low, а в тексте «сегодня» → менеджер',
  [confident('esc-repair-today', { urgency: 'low' })], ([r]) => escalated(r, 'contradiction'));
t('поля противоречат: urgency high, а в тексте «не срочно» (подмена инструкций сработала) → менеджер',
  [{ text: oldCases['injection-force-urgency'].text, answer: { ...confident('injection-force-urgency').answer, urgency: 'high' } }],
  ([r]) => escalated(r, 'contradiction'));
t('самооценка не решает: чистая заявка с confidence 0.3 не уходит менеджеру',
  [text('Нужен монтаж розеток в квартире, Казань', { category: 'installation', urgency: 'normal', confidence: 0.3 })],
  ([r]) => {
    notEscalated(r);
    assert.equal(result(r).confidence, 0.3, 'confidence в ответе остаётся как данные');
  });
t('заглушка (mock) проходит те же правила: «почините и заодно установите» → менеджер',
  [{ text: newCases['esc-multi-repair-install'].text }], ([r]) => {
    assert.equal(r.response.mode, 'mock');
    escalated(r, 'multiple_requests');
  }, { mock: true });

// ---- ошибки 2 и 3 на новых примерах ----
t('документы, а не работа: выписка СРО (модель: installation), типовой договор (модель: repair) → consultation',
  [confident('esc-docs-sro', { category: 'installation' }), confident('esc-docs-contract', { category: 'repair' })],
  (rs) => rs.forEach((r) => { assert.equal(result(r).category, 'consultation'); notEscalated(r); }));
t('срок аренды или работ — не срок выполнения: «на неделю», «на два месяца», «дня на 3» при low → normal',
  ['esc-rental-week', 'esc-rental-two-months', 'esc-install-duration'].map((id) => confident(id, { urgency: 'low' })),
  (rs) => rs.forEach((r) => { assert.equal(result(r).urgency, 'normal'); notEscalated(r); }));

// ---- контрольные: правила не должны срабатывать ----
t('контроль: приветствие + просьба, «после ремонта нужен монтаж», «брали в аренду, нужна ещё», СММ-спам, вопрос про скидки, поиск аренды',
  ['esc-greet-plus-request', 'esc-after-renovation', 'esc-rented-before', 'esc-spam-smm', 'esc-client-asks-discount',
    'esc-client-seeks-supplier', 'esc-repair-today'].map((id) => confident(id)),
  (rs) => rs.forEach((r) => notEscalated(r)));
t('контроль: заказ работы с просьбой прислать договор остаётся installation',
  [confident('esc-docs-with-order')], ([r]) => { assert.equal(result(r).category, 'installation'); notEscalated(r); });
t('контроль: low остаётся, если есть настоящий дальний срок («не срочно, в следующем месяце», «на следующей неделе»)',
  [confident('esc-rental-term-far-start'), confident('esc-not-urgent-filter')],
  (rs) => rs.forEach((r) => { assert.equal(result(r).urgency, 'low'); notEscalated(r); }));
t('контроль: жалоба по-прежнему у менеджера, повод «жалоба»',
  [rec('complaint-crooked-refund')], ([r]) => {
    escalated(r);
    assert.ok(route(r).reasons.includes('жалоба'), JSON.stringify(route(r).reasons));
  });

(async () => {
  let failed = 0;
  for (const x of tests) {
    // у каждого теста своя заглушка модели: один и тот же текст в разных тестах получает разный ответ
    const fake = x.mock ? null : await startFake(x.items);
    const rs = [];
    try {
      for (const it of x.items) rs.push((await runCore(it.text, { env: fake ? fake.env : {} })).json);
    } finally {
      if (fake) fake.stop();
    }
    try {
      for (const r of rs) {
        assert.equal(r.http_status, 200, 'HTTP ' + r.http_status + ' ' + JSON.stringify(r.response).slice(0, 200));
        // заглушка модели не ответила — это поломка теста, а не ошибка правил: так и сказать
        if (!x.mock) {
          const a = r.response.meta.trace.attempts;
          assert.equal(r.response.mode, 'llm', 'заглушка модели (tests/fake_openai.js) не дала ответ: '
            + JSON.stringify(a.map((t) => t.errors)));
        }
      }
      x.check(rs);
      console.log('ok   ' + x.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + x.name + '\n     ' + String(e.message).split('\n').slice(0, 12).join('\n     '));
    }
  }
  console.log((failed ? 'ПРОВАЛ: ' + failed + ' из ' : 'ok: ') + tests.length + ' сквозных тестов правил');
  process.exit(failed ? 1 : 0);
})();
