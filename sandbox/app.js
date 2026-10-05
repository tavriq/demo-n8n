'use strict';
// Песочница: пресеты проигрывают записанные прогоны, «Прогнать вживую» зовёт POST /webhook/triage
// на этом же домене. Схема из шести шагов подсвечивается по таймингам из meta.trace ответа.
// Весь текст из ответа и из data.json вставляется через textContent.
(function () {
  const $ = (id) => document.getElementById(id);
  const STEPS = ['mask', 'limits', 'model', 'check', 'retry', 'route'];
  const REPO = 'https://github.com/tavriq/demo-n8n/blob/main/';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let data = null;
  let current = null; // { response, label, live }
  let selected = 'model';
  let playId = 0;
  let busy = false;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtInt = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  function fmtMs(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return ms + ' мс';
    return (ms / 1000).toFixed(1).replace('.', ',') + ' с';
  }
  const pct = (k, n) => (n ? Math.round((100 * k) / n) + '%' : '—');
  const ratio = (m) => (m ? m.correct + ' из ' + m.total + ' (' + pct(m.correct, m.total) + ')' : '—');
  const fmtDate = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('.') : '');
  const link = (path, label) => h('a', { href: REPO + path, rel: 'noopener noreferrer' }, label);

  // ---- состояние шагов по ответу ----
  function stepStates(response) {
    const st = {};
    for (const s of STEPS) st[s] = { state: 'skip', ms: null };
    if (!response || response.ok !== true) {
      st.mask = { state: 'done', ms: null };
      st.limits = { state: 'fail', ms: null };
      return st;
    }
    const tr = response.meta.trace;
    const t = tr.timings_ms;
    st.mask = { state: 'done', ms: t.mask };
    st.limits = { state: 'done', ms: t.limits };
    st.model = { state: 'done', ms: t.model };
    if (response.mode !== 'mock') {
      const a1 = tr.attempts[0];
      st.check = { state: a1 && a1.ok ? 'done' : 'fail', ms: t.check };
      if (tr.attempts.length > 1) st.retry = { state: tr.attempts[1].ok ? 'done' : 'fail', ms: t.retry };
    }
    st.route = { state: tr.route.to === 'manager' ? 'warn' : 'done', ms: t.route };
    return st;
  }

  function setStep(name, state, msText) {
    const btn = document.querySelector('.step[data-step="' + name + '"]');
    btn.classList.remove('active', 'done', 'warn', 'fail', 'skip');
    if (state) btn.classList.add(state);
    btn.querySelector('.step-ms').textContent = msText || '';
  }
  const msLabel = (s) => (s.state === 'skip' ? 'не нужен' : fmtMs(s.ms));

  function showStatic(states) {
    for (const s of STEPS) setStep(s, states[s].state, msLabel(states[s]));
  }

  async function play(states, id, from) {
    for (const s of STEPS.slice(from || 0)) {
      if (id !== playId) return;
      const st = states[s];
      if (st.state === 'skip') { setStep(s, 'skip', msLabel(st)); continue; }
      setStep(s, 'active', '');
      if (!reduceMotion) await sleep(Math.min(3500, Math.max(350, st.ms || 0)));
      if (id !== playId) return;
      setStep(s, st.state, msLabel(st));
    }
  }

  // ---- детали шага ----
  function runBox(title, ...children) {
    return h('div', { class: 'run-box' }, h('h3', null, title), ...children);
  }
  const tag = (kind, text) => h('span', { class: 'tag tag-' + kind }, text);

  function detailFor(step) {
    const r = current && current.response;
    const ok = r && r.ok === true;
    const tr = ok ? r.meta.trace : null;
    const L = data ? data.limits : { ip_hour: 5, source_hour: 60, daily_tokens: 200000 };
    const parts = [];
    const refused = r && r.ok === false ? runBox('В этом прогоне', tag('fail', 'отказ'), ' ', r.message || '') : null;

    if (step === 'mask') {
      parts.push(h('h3', null, '1. Маскировка контактов'),
        h('p', null, 'До модели и до журнала код скрывает телефоны (любые разделители, +7 и 8), email (в том числе «собака … точка»), @ники и ники после «тг», ссылки на профили, номера карт и документов. Бюджеты и даты не трогает. Ответ модели маскируется ещё раз: модель могла переписать цифрами телефон, записанный словами.'),
        h('p', { class: 'small' }, 'Код: ', link('src/lib/pii.js', 'src/lib/pii.js'), ', проверка на кейсах — ', link('tests/test_lib.js', 'tests/test_lib.js'), '.'));
      if (ok) parts.push(runBox('В этом прогоне', 'Скрыто контактов: ' + r.meta.pii_masked + '. В модель и в журнал ушёл текст:',
        h('blockquote', null, r.meta.text_masked)));
    } else if (step === 'limits') {
      parts.push(h('h3', null, '2. Лимиты и бюджет'),
        h('p', null, 'Перед вызовом модели n8n читает журнал за 24 часа (Data Table) и считает: не больше ' + L.ip_hour + ' заявок в час с одного адреса, ' + L.source_hour + ' в час на API и отдельно на форму, ' + fmtInt(L.daily_tokens) + ' токенов в день с резервом на две попытки. Превышение — вежливый отказ 429 без вызова модели. Пустой или длинный текст — 400.'),
        h('p', { class: 'small' }, 'Код: ', link('src/nodes/guard.js', 'src/nodes/guard.js'), '.'));
      if (ok) {
        const lim = tr.limits;
        parts.push(runBox('В этом прогоне',
          lim.ip_used === null ? 'Записанный служебный прогон: лимит в час не тратил.' : 'С вашего адреса за час: ' + lim.ip_used + ' из ' + lim.ip_limit + '.',
          ' Токенов сегодня: ' + fmtInt(r.meta.tokens_today) + ' из ' + fmtInt(r.meta.daily_token_budget) + '.'));
      }
      if (refused) parts.push(refused);
    } else if (step === 'model') {
      parts.push(h('h3', null, '3. Модель'),
        h('p', null, 'HTTP Request в OpenAI-совместимый chat/completions: temperature 0, structured outputs (response_format — JSON-схема в режиме strict). Текст клиента идёт между тегами <заявка> и </заявка>: модель считает его данными, а не инструкциями. Теги внутри текста вырезаются.'),
        h('details', null, h('summary', null, 'Промпт целиком'), h('pre', null, data ? data.prompt : '')));
      if (ok && r.mode === 'mock') {
        parts.push(runBox('В этом прогоне', 'Модель отключена: ответ дала заглушка по ключевым словам, 0 токенов.'));
      } else if (ok) {
        const a1 = tr.attempts[0];
        parts.push(runBox('В этом прогоне',
          h('p', null, 'Модель ' + r.meta.model + ', токенов: вход ' + fmtInt(r.meta.tokens_in) + ', выход ' + fmtInt(r.meta.tokens_out)
            + (tr.attempts.length > 1 ? ' (за обе попытки)' : '') + '. Время ответа: ' + fmtMs(tr.timings_ms.model) + '.'),
          a1 && a1.raw !== null ? [h('p', null, 'Сырой ответ модели, попытка 1:'), h('pre', null, prettyRaw(a1.raw))]
            : h('p', null, 'Ответа нет: ' + (a1 ? a1.errors.join('; ') : '—'))));
      }
      if (refused) parts.push(refused);
    } else if (step === 'check') {
      parts.push(h('h3', null, '4. Проверка ответа кодом'),
        h('p', null, 'Схема задаёт поля, типы и списки значений. Код проверяет то, чего схема не выражает: confidence от 0 до 1, summary не длиннее 20 слов (длиннее — обрезается), город не пустой, бюджет — неотрицательное число. Поверх модели — правило: жалоба или уверенность ниже 0,6 → нужен человек.'),
        h('details', null, h('summary', null, 'JSON-схема ответа'), h('pre', null, data ? JSON.stringify(data.schema, null, 2) : '')),
        h('p', { class: 'small' }, 'Код: ', link('src/lib/triage.js', 'src/lib/triage.js'), ' (validateTriage).'));
      if (ok && r.mode === 'mock') parts.push(runBox('В этом прогоне', 'Заглушка отвечает по контракту сама, проверка модели не нужна.'));
      else if (ok) {
        const a1 = tr.attempts[0];
        const warns = tr.check.warnings;
        parts.push(runBox('В этом прогоне',
          a1 && a1.ok ? tag('ok', 'попытка 1 прошла проверку') : tag('fail', 'попытка 1 не прошла: ' + (a1 ? a1.errors.join('; ') : '')),
          warns.length ? h('ul', null, warns.map((w) => h('li', null, w))) : null));
      }
    } else if (step === 'retry') {
      parts.push(h('h3', null, '5. Повтор'),
        h('p', null, 'Если ответ не прошёл проверку или API вернул ошибку, n8n один раз повторяет запрос и дописывает в него список ошибок. Снова не вышло — заявка не теряется: уходит человеку с category=other и needs_human=true.'));
      if (ok && r.mode !== 'mock') {
        if (tr.attempts.length > 1) {
          const a2 = tr.attempts[1];
          parts.push(runBox('В этом прогоне',
            a2.ok ? tag('ok', 'попытка 2 прошла проверку') : tag('fail', 'попытка 2 не прошла: ' + a2.errors.join('; ')),
            a2.raw !== null ? h('pre', null, prettyRaw(a2.raw)) : null,
            tr.check.fallback ? h('p', null, 'Обе попытки неудачны: заявка ушла человеку.') : null));
        } else {
          parts.push(runBox('В этом прогоне', 'Не понадобился: первый ответ прошёл проверку.'));
        }
      }
    } else if (step === 'route') {
      parts.push(h('h3', null, '6. Маршрут'),
        h('p', null, 'Каждая заявка пишется в журнал (Data Table) и появляется на публичной доске. Жалоба, срочная или неясная заявка — ещё и уведомление менеджеру в Telegram (в демо нода выключена: некому читать).'));
      if (ok) {
        const rt = tr.route;
        parts.push(runBox('В этом прогоне',
          rt.to === 'manager' ? [tag('warn', 'менеджеру'), ' ' + rt.reasons.join(', ') + '. Telegram: ' + rt.telegram + '.']
            : [tag('ok', 'в общую очередь'), ' человек не нужен, срочности нет.'],
          h('p', null, 'Запись в журнале видна на ', h('a', { href: '/webhook/board' }, 'доске'), '.')));
      }
    }
    return parts;
  }

  function prettyRaw(raw) {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { return raw; }
  }

  function renderDetail() {
    for (const b of document.querySelectorAll('.step')) b.classList.toggle('selected', b.dataset.step === selected);
    $('detail').replaceChildren(...detailFor(selected));
  }

  // ---- результат ----
  function renderResult() {
    const card = $('result-card');
    const r = current && current.response;
    if (!r) { card.hidden = true; return; }
    card.hidden = false;
    const dl = $('result');
    if (r.ok !== true) {
      dl.replaceChildren(h('dt', null, 'Отказ'), h('dd', null, r.message || r.error || 'заявка не принята'));
      $('result-meta').textContent = current.label;
    } else {
      const x = r.result;
      const cat = (data && data.categories[x.category]) || x.category;
      const urg = (data && data.urgencies[x.urgency]) || x.urgency;
      const rows = [
        ['Категория', cat], ['Срочность', urg], ['Город', x.city || 'не указан'],
        ['Бюджет', x.budget_rub !== null ? fmtInt(x.budget_rub) + ' ₽' : 'не указан'],
        ['Суть', x.summary], ['Следующий шаг', x.next_step],
        ['Нужен человек', x.needs_human ? 'да' : 'нет'], ['Уверенность', String(x.confidence).replace('.', ',')],
      ];
      dl.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
      const t = r.meta.trace.timings_ms;
      $('result-meta').textContent = current.label + ' · внутри n8n ' + fmtMs(t.total)
        + (r.mode === 'mock' ? ' · заглушка без модели' : ' · ' + fmtInt(r.meta.tokens_in + r.meta.tokens_out) + ' токенов · ' + r.meta.model);
    }
    $('json').textContent = JSON.stringify(r, null, 2);
  }

  function show(response, label, live, animate) {
    current = { response, label, live };
    $('run-label').textContent = label;
    const states = stepStates(response);
    const id = ++playId;
    renderResult();
    renderDetail();
    if (animate) play(states, id).then(() => { if (id === playId) renderDetail(); });
    else showStatic(states);
    return states;
  }

  // ---- пресеты ----
  function renderPresets() {
    const box = $('presets');
    box.replaceChildren(...data.presets.map((p) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-id': p.id }, p.title);
      b.addEventListener('click', () => pickPreset(p, true));
      return b;
    }));
  }
  function pressChip(id) {
    for (const c of document.querySelectorAll('.chip')) c.setAttribute('aria-pressed', String(c.dataset.id === id));
  }
  function pickPreset(p, animate) {
    if (busy) return;
    $('text').value = p.text;
    updateChars();
    pressChip(p.id);
    hideError();
    if (p.response) {
      selected = 'model';
      show(p.response, 'Запись прогона от ' + fmtDate(p.recorded_at), false, animate);
    } else {
      current = null;
      playId++;
      for (const s of STEPS) setStep(s, null, '');
      $('run-label').textContent = 'Записи нет — прогоните вживую';
      renderResult();
      renderDetail();
    }
  }

  // ---- живой прогон ----
  function updateQuota(limits) {
    if (!limits || limits.ip_used === null || limits.ip_used === undefined) return;
    const left = Math.max(0, limits.ip_limit - limits.ip_used);
    $('quota').textContent = left > 0
      ? 'Живых прогонов осталось: ' + left + ' из ' + limits.ip_limit + ' в час. Примеры работают без лимита.'
      : 'Живые прогоны на этот час закончились. Примеры работают без лимита.';
    $('run').disabled = left === 0;
  }
  function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }
  function hideError() { $('error').hidden = true; }

  async function runLive() {
    const text = $('text').value.trim();
    if (!text) { showError('Напишите текст заявки или выберите пример.'); return; }
    if (busy) return;
    busy = true;
    hideError();
    pressChip(null);
    $('run').disabled = true;
    $('run').textContent = 'Разбираю…';
    const id = ++playId;
    for (const s of STEPS) setStep(s, null, '');
    $('run-label').textContent = 'Живой прогон…';
    // пока ждём ответ: маскировка и лимиты проходят быстро, модель думает секунды
    setStep('mask', 'active', '');
    const pending = (async () => {
      if (!reduceMotion) await sleep(300);
      if (id !== playId) return;
      setStep('mask', 'done', ''); setStep('limits', 'active', '');
      if (!reduceMotion) await sleep(300);
      if (id !== playId) return;
      setStep('limits', 'done', ''); setStep('model', 'active', '');
    })();
    let status = 0;
    let body = null;
    try {
      const res = await fetch('/webhook/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        cache: 'no-store',
      });
      status = res.status;
      try { body = await res.json(); } catch (e) { body = null; }
    } catch (e) {
      status = 0;
    }
    await pending;
    busy = false;
    $('run').textContent = 'Прогнать вживую';
    $('run').disabled = false;
    if (id !== playId) return;
    if (!body || typeof body !== 'object') {
      for (const s of STEPS) setStep(s, null, '');
      $('run-label').textContent = '';
      showError(status === 503 || status === 429 ? 'Слишком часто: подождите несколько секунд и попробуйте снова.'
        : status === 0 ? 'Нет связи с сервером демо.' : 'Сервер демо ответил HTTP ' + status + '. Попробуйте позже.');
      return;
    }
    updateQuota(body.ok === true ? body.meta.trace.limits : body.limits);
    const label = body.ok === true ? 'Живой прогон' : 'Живой прогон: отказ';
    current = { response: body, label, live: true };
    $('run-label').textContent = label;
    selected = body.ok === true ? 'model' : 'limits';
    renderResult();
    renderDetail();
    const states = stepStates(body);
    // первые три шага уже показаны: дописываем их время, остальные проигрываем
    for (const s of ['mask', 'limits', 'model']) setStep(s, states[s].state, msLabel(states[s]));
    await play(states, id, 3);
    if (id === playId) renderDetail();
  }

  function updateChars() {
    $('chars').textContent = $('text').value.length + ' / 1000';
  }

  // ---- эталон ----
  function renderEvals() {
    const box = $('evals');
    const e = data.evals;
    if (!e) {
      box.replaceChildren(h('p', { class: 'muted' }, 'Прогон на текущем наборе кейсов ещё не сделан.'));
      return;
    }
    const catLabel = data.categories[e.baseline_category.label] || e.baseline_category.label;
    const rows = [
      ['Категория из 7 вариантов', ratio(e.category.strict),
        'с допустимыми вариантами ' + ratio(e.category.lenient) + '; ответ «всегда ' + catLabel + '» дал бы ' + Math.round(e.baseline_category.accuracy * 100) + '%'],
      ['Срочность', ratio(e.urgency.strict), 'с допустимыми вариантами ' + ratio(e.urgency.lenient)],
      ['Нужен человек: нашли из тех, кому нужен', ratio(e.needs_human.recall), 'точность ' + ratio(e.needs_human.precision)],
      ['Город', ratio(e.city), null],
      ['Бюджет', ratio(e.budget), null],
      ['Контакты не попали в ответ', (e.pii.items - e.pii.leaked) + ' из ' + e.pii.items, null],
      ['Prompt injection не сработала', e.injection.resisted + ' из ' + e.injection.cases, null],
      ['Задержка, медиана / p95', fmtMs(e.latency_ms.p50) + ' / ' + fmtMs(e.latency_ms.p95), null],
      ['Токенов на заявку', fmtInt(e.tokens_per_case), null],
    ];
    const table = h('table', { class: 'metrics' }, h('tbody', null, rows.map(([k, v, note]) =>
      h('tr', null, h('td', null, k, note ? h('div', { class: 'muted small' }, note) : null), h('td', null, v)))));
    const misses = e.misses.map((m) => h('div', { class: 'miss' },
      h('blockquote', null, m.text),
      h('p', { class: 'small' }, (FIELD_RU[m.field] || m.field) + ': разметка ', h('b', null, label(m.field, m.expected)), ', модель ', h('b', null, label(m.field, m.got))),
      h('p', { class: 'small muted' }, m.why)));
    box.replaceChildren(
      h('p', { class: 'muted small' }, 'Каждая заявка размечена вручную; где ответ спорный, в разметке несколько допустимых вариантов. Прогон от '
        + fmtDate(e.date_utc) + ', модель ' + (e.model || '—') + '. Отчёт: ', link('evals/latest.md', 'evals/latest.md'), '.'),
      table,
      misses.length ? h('h3', null, 'Промахи и почему') : '',
      ...misses);
  }
  const FIELD_RU = { category: 'Категория', urgency: 'Срочность', needs_human: 'Нужен человек', city: 'Город', budget_rub: 'Бюджет' };
  function label(field, v) {
    const one = (x) => {
      if (x === null || x === undefined) return 'нет';
      if (field === 'category') return data.categories[x] || x;
      if (field === 'urgency') return data.urgencies[x] || x;
      if (field === 'needs_human') return x ? 'да' : 'нет';
      return String(x);
    };
    return Array.isArray(v) ? v.map(one).join(' или ') : one(v);
  }

  // ---- старт ----
  for (const b of document.querySelectorAll('.step')) {
    b.addEventListener('click', () => { selected = b.dataset.step; renderDetail(); });
  }
  $('run').addEventListener('click', runLive);
  $('text').addEventListener('input', () => { updateChars(); pressChip(null); });

  fetch('/s/data.json', { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((d) => {
      data = d;
      renderPresets();
      renderEvals();
      const first = d.presets.find((p) => p.response);
      if (first) pickPreset(first, false);
      else renderDetail();
    })
    .catch(() => {
      showError('Не удалось загрузить данные песочницы. Живой прогон работает.');
      renderDetail();
    });
})();
