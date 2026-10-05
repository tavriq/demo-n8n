#!/usr/bin/env node
// Собирает sandbox/data.json для песочницы на корне демо из того, что уже есть в репо:
//   промпт, JSON-схема и подписи — из src/lib (тот же текст, что уходит в Code-ноды);
//   пресеты — sandbox/content.json, записанные прогоны — sandbox/recordings.json
//   (scripts/record_presets.py); эталон — последний evals/results-*-llm-*.json,
//   только если он посчитан на текущем evals/cases.jsonl.
//   node scripts/build_sandbox.js          # записать sandbox/data.json
//   node scripts/build_sandbox.js --check  # упасть, если data.json устарел
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

function libValues(file, names) {
  const ctx = vm.createContext({});
  vm.runInContext(read(file) + '\n;globalThis.__out = {' + names.join(', ') + '};', ctx);
  return ctx.__out;
}

const triage = libValues('src/lib/triage.js', ['TRIAGE_SYSTEM_PROMPT', 'TRIAGE_SCHEMA', 'TRIAGE_CATEGORIES']);
const html = libValues('src/lib/html.js', ['LABEL_CATEGORY', 'LABEL_URGENCY']);

// лимиты по умолчанию — из .env.example; на сервере те же значения
const envExample = {};
for (const line of read('.env.example').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) envExample[m[1]] = m[2];
}
const limits = {
  ip_hour: Number(envExample.RATE_LIMIT_PER_IP_HOUR),
  source_hour: Number(envExample.RATE_LIMIT_GLOBAL_HOUR),
  daily_tokens: Number(envExample.DAILY_TOKEN_BUDGET),
  max_chars: 1000,
};

const content = readJson('sandbox/content.json');
const recPath = path.join(ROOT, 'sandbox/recordings.json');
const rec = fs.existsSync(recPath) ? JSON.parse(fs.readFileSync(recPath, 'utf8')) : { recorded_at: null, runs: {} };
const presets = content.presets.map((p) => {
  const run = rec.runs[p.id];
  // запись годится, только если текст пресета с тех пор не менялся
  const response = run && run.text === p.text ? run.response : null;
  return { ...p, recorded_at: response ? rec.recorded_at : null, response };
});

// эталон: последний прогон на модели по текущему набору кейсов
const casesSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'evals/cases.jsonl'))).digest('hex');
const resultFiles = fs.readdirSync(path.join(ROOT, 'evals'))
  .filter((f) => /^results-\d{4}-\d{2}-\d{2}-llm.*\.json$/.test(f)).sort();
let evals = null;
for (const f of resultFiles.reverse()) {
  const r = readJson('evals/' + f);
  if (r.summary.cases_sha256 !== casesSha) continue;
  const s = r.summary;
  const byId = Object.fromEntries(r.rows.map((row) => [row.id, row]));
  evals = {
    file: 'evals/' + f,
    date_utc: s.date_utc,
    model: (s.models_seen || [])[0] || null,
    cases: s.cases_total,
    category: s.accuracy.category,
    urgency: s.accuracy.urgency,
    needs_human: { recall: s.needs_human.recall, precision: s.needs_human.precision },
    city: s.accuracy.city,
    budget: s.accuracy.budget_rub,
    pii: s.pii,
    injection: s.injection,
    contract_ok: s.contract_ok,
    latency_ms: s.latency_ms,
    tokens_per_case: s.tokens.per_case_mean,
    retries: s.llm_retries,
    fallbacks: s.llm_fallbacks,
    baseline_category: s.baseline.category_majority,
    misses: content.misses.map((m) => {
      const row = byId[m.id];
      if (!row) throw new Error('промах ' + m.id + ' не найден в ' + f);
      return { id: m.id, field: m.field, text: (readCase(m.id) || {}).text || '', expected: row.expected[m.field],
        got: row.got ? row.got[m.field] : null, why: m.why };
    }),
  };
  break;
}

function readCase(id) {
  for (const line of read('evals/cases.jsonl').split('\n')) {
    if (line.trim() && JSON.parse(line).id === id) return JSON.parse(line);
  }
  return null;
}

const data = {
  categories: html.LABEL_CATEGORY,
  urgencies: html.LABEL_URGENCY,
  prompt: triage.TRIAGE_SYSTEM_PROMPT,
  schema: triage.TRIAGE_SCHEMA,
  limits,
  presets,
  evals,
};
const text = JSON.stringify(data, null, 1) + '\n';
const out = path.join(ROOT, 'sandbox/data.json');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== text) {
    console.error('устарел sandbox/data.json — запустите node scripts/build_sandbox.js');
    process.exit(1);
  }
} else {
  fs.writeFileSync(out, text);
  console.log('собрано: sandbox/data.json, пресетов с записью ' + presets.filter((p) => p.response).length + ' из '
    + presets.length + ', эталон: ' + (evals ? evals.file : 'нет прогона на текущих кейсах'));
}
