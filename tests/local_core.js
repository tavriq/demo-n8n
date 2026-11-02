// Ядро триажа без n8n: исполняет workflows/triage-core.json по его связям.
// Code-ноды — их собранный jsCode как есть, IF — по условиям из JSON, Data Table — в памяти,
// HTTP Request — настоящий запрос (в тестах к tests/fake_openai.js), выключенные ноды
// пропускаются. Порядок как у n8n v1: ветка за веткой, в порядке связей. Это не n8n:
// поддержаны только ноды и параметры, которые есть в triage-core.json, на незнакомом
// месте исполнитель падает, а не угадывает.
//
// Как модуль: runCore(input, { env, table }) и startFake(answers) — для tests/test_escalation.js.
// Как сервер для evals/run.py (POST /webhook/triage, как вход «Триаж: вход»):
//   node tests/local_core.js [--port 18102]                          # mock: заглушка по ключевым словам
//   node tests/local_core.js --replay evals/results-...-llm-....json # модель подменена tests/fake_openai.js,
//       на каждую заявку из evals/cases.jsonl она отвечает тем, что модель ответила в этом прогоне
//   python3 evals/run.py --base http://127.0.0.1:18102 --pause 0 --out-dir /tmp/x --no-latest
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const loadWorkflow = (f = 'triage-core.json') => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'));

// $now в Code-нодах ядра нужен только как день по Москве
function moscowNow() {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  return {
    toFormat: (f) => {
      if (f !== 'yyyy-MM-dd') throw new Error('$now.toFormat: формат не поддержан: ' + f);
      return day;
    },
  };
}

function evalExpr(value, scope) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const m = /^=\{\{([\s\S]*)\}\}$/.exec(value);
  if (!m || m[1].includes('{{')) throw new Error('выражение не поддержано: ' + value.slice(0, 80));
  return new Function('$', '$json', '$env', '$now', 'return (' + m[1] + ');')(scope.$, scope.$json, scope.$env, scope.$now);
}

function condition(c, left) {
  const op = c.operator.type + ':' + c.operator.operation;
  if (op === 'boolean:true') {
    // typeValidation: strict — не boolean слева n8n считает ошибкой
    if (typeof left !== 'boolean') throw new Error('IF: ожидался boolean, пришло ' + JSON.stringify(left));
    return left === true;
  }
  if (op === 'string:equals') return left === c.rightValue;
  throw new Error('IF: оператор не поддержан: ' + op);
}

function tableFilter(rows, filters, scope) {
  const conds = (filters && filters.conditions) || [];
  return rows.filter((r) => conds.every((c) => {
    const v = evalExpr(c.keyValue, scope);
    if (c.condition === 'gte') return Number(r[c.keyName]) >= Number(v);
    if (c.condition === 'eq') return r[c.keyName] === v;
    throw new Error('Data Table: условие не поддержано: ' + c.condition);
  }));
}

async function httpNode(node, items, scope0) {
  const p = node.parameters;
  const out = [];
  for (const item of items) {
    const scope = { ...scope0, $json: item.json };
    const url = evalExpr(p.url, scope);
    const headers = { 'content-type': 'application/json' };
    for (const h of (p.headerParameters && p.headerParameters.parameters) || []) headers[h.name] = evalExpr(h.value, scope);
    try {
      const r = await fetch(url, { method: p.method, headers, body: evalExpr(p.jsonBody, scope),
        signal: AbortSignal.timeout((p.options && p.options.timeout) || 30000) });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch (e) { body = text; }
      // fullResponse + neverError: тело, заголовки и код, без исключения на 4xx/5xx
      out.push({ json: { body, headers: Object.fromEntries(r.headers), statusCode: r.status, statusMessage: r.statusText } });
    } catch (e) {
      if (node.onError !== 'continueRegularOutput') throw e;
      out.push({ json: { error: { message: String(e.message || e) } } });
    }
  }
  return out;
}

// Исполняет воркфлоу с входом input (json триггера). Возвращает json последней ноды
// (как Execute Workflow у n8n), выходы всех нод и таблицу.
async function runWorkflow(wf, input, { env = {}, table = [] } = {}) {
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const out = {};
  const $ = (name) => {
    if (!byName[name]) throw new Error('нет ноды ' + name);
    return { isExecuted: name in out, first: () => (out[name] || [])[0], all: () => out[name] || [] };
  };
  const scope = { $, $env: env, $now: moscowNow() };
  let last = null;

  async function exec(node, items) {
    let outputs;
    const p = node.parameters;
    if (node.disabled) {
      // выключенная нода у n8n пропускает данные дальше и сама не исполняется
      outputs = [items];
    } else if (node.type === 'n8n-nodes-base.executeWorkflowTrigger') {
      outputs = [items];
    } else if (node.type === 'n8n-nodes-base.code') {
      const $input = { first: () => items[0], all: () => items };
      const fn = new Function('$input', '$', '$env', '$now', 'DateTime', 'require', p.jsCode);
      outputs = [fn($input, $, env, scope.$now, undefined, require)];
    } else if (node.type === 'n8n-nodes-base.if') {
      const yes = [];
      const no = [];
      for (const item of items) {
        const ok = p.conditions.conditions.every((c) => condition(c, evalExpr(c.leftValue, { ...scope, $json: item.json })));
        (ok ? yes : no).push(item);
      }
      outputs = [yes, no];
    } else if (node.type === 'n8n-nodes-base.dataTable') {
      const s = { ...scope, $json: items[0] && items[0].json };
      if (p.resource === 'table' && p.operation === 'create') {
        outputs = [[{ json: { id: 'local', name: p.tableName } }]];
      } else if (p.operation === 'get') {
        let rows = tableFilter(table, p.filters, s).map((r) => ({ json: { ...r } }));
        if (!rows.length && node.alwaysOutputData) rows = [{ json: {} }];
        outputs = [rows];
      } else if (p.operation === 'insert') {
        outputs = [items.map((i) => {
          const row = { ...i.json, id: table.length + 1 };
          table.push(row);
          return { json: row };
        })];
      } else {
        throw new Error('Data Table: операция не поддержана: ' + p.operation);
      }
    } else if (node.type === 'n8n-nodes-base.httpRequest') {
      outputs = [await httpNode(node, items, scope)];
    } else {
      throw new Error('нода не поддержана: ' + node.type + ' (' + node.name + ')');
    }
    if (!node.disabled) {
      out[node.name] = outputs.flat();
      last = node.name;
    }
    const conns = (wf.connections[node.name] && wf.connections[node.name].main) || [];
    for (let i = 0; i < conns.length; i++) {
      if (!outputs[i] || !outputs[i].length) continue;
      for (const c of conns[i]) await exec(byName[c.node], outputs[i]);
    }
  }

  const trigger = wf.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  await exec(trigger, [{ json: input }]);
  return { json: out[last][0].json, last, out, table };
}

// Окружение по умолчанию: лимиты в час сняты (прогон не упирается в 5 заявок с адреса),
// дневной лимит токенов большой. Без LLM_* — mock.
const LOCAL_ENV = { IP_HASH_SALT: 'local', RATE_LIMIT_PER_IP_HOUR: '100000', RATE_LIMIT_GLOBAL_HOUR: '100000',
  DAILY_TOKEN_BUDGET: '1000000000' };

// Заявка через ядро, как её передаёт вебхук POST /webhook/triage.
async function runCore(text, { env = {}, table = [], wf = loadWorkflow() } = {}) {
  const input = { headers: { 'content-type': 'application/json' }, params: {}, query: {}, body: { text } };
  return runWorkflow(wf, input, { env: { ...LOCAL_ENV, ...env }, table });
}

// Текст заявки так, как его видит модель: маскирование и вырезанные теги, как в «Подготовке».
// По нему tests/fake_openai.js находит заданный ответ (FAKE_ANSWERS).
function modelView(text) {
  const ctx = vm.createContext({});
  for (const f of ['pii', 'triage']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'lib', f + '.js'), 'utf8'), ctx);
  const trimmed = String(text).replace(/\r\n/g, '\n').trim().slice(0, 1000);
  ctx.__t = trimmed;
  return vm.runInContext('stripRequestTags(maskPII(__t).text)', ctx);
}

// Поднимает tests/fake_openai.js на свободном порту с ответами answers: [{ text, answer }].
// Возвращает env для ядра (ключ, адрес, модель) и stop().
function startFake(answers, { model = 'fake-model' } = {}) {
  const map = {};
  for (const a of answers) map[modelView(a.text)] = a.answer;
  const file = path.join(require('os').tmpdir(), 'fake-answers-' + process.pid + '-' + Date.now() + '.json');
  fs.writeFileSync(file, JSON.stringify(map));
  const child = spawn(process.execPath, [path.join(__dirname, 'fake_openai.js'), '0'],
    { env: { ...process.env, FAKE_ANSWERS: file }, stdio: ['ignore', 'pipe', 'inherit'] });
  const log = [];
  return new Promise((resolve, reject) => {
    let buf = '';
    child.on('exit', (code) => reject(new Error('fake_openai.js вышел с кодом ' + code)));
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^fake openai on (\d+)/.exec(line);
        if (m) {
          resolve({
            env: { LLM_API_KEY: 'fake-key', LLM_BASE_URL: 'http://127.0.0.1:' + m[1] + '/v1', LLM_MODEL_SMART: model },
            log,
            stop: () => { child.removeAllListeners('exit'); child.kill(); fs.rmSync(file, { force: true }); },
          });
        } else if (line.startsWith('{')) log.push(JSON.parse(line));
      }
    });
  });
}

// Ответы модели из записанного прогона: поля «got» каждого кейса.
function replayAnswers(resultsFile, casesFiles = [path.join(ROOT, 'evals', 'cases.jsonl')]) {
  const rows = JSON.parse(fs.readFileSync(resultsFile, 'utf8')).rows;
  const texts = {};
  for (const f of casesFiles) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line.trim()) { const c = JSON.parse(line); texts[c.id] = c.text; }
  }
  const fields = ['category', 'urgency', 'city', 'budget_rub', 'summary', 'next_step', 'needs_human', 'confidence'];
  return rows.filter((r) => r.got && texts[r.id] !== undefined)
    .map((r) => ({ id: r.id, text: texts[r.id], answer: Object.fromEntries(fields.map((f) => [f, r.got[f]])) }));
}

async function serve() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const port = Number(arg('--port') || 18102);
  const replay = arg('--replay');
  let env = {};
  let fake = null;
  if (replay) {
    const results = JSON.parse(fs.readFileSync(replay, 'utf8'));
    const model = 'replay-' + String((results.summary.models_seen || ['model'])[0]).split('/').pop();
    fake = await startFake(replayAnswers(replay), { model });
    env = fake.env;
  }
  const wf = loadWorkflow();
  const table = [];
  let queue = Promise.resolve();  // исполнения по одному, как N8N_CONCURRENCY_PRODUCTION_LIMIT=1
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      queue = queue.then(async () => {
        if (req.method !== 'POST' || req.url !== '/webhook/triage') { res.writeHead(404); res.end(); return; }
        let body = null;
        try { body = JSON.parse(raw); } catch (e) { /* пусто */ }
        const input = { headers: req.headers, params: {}, query: {}, body };
        try {
          const r = await runWorkflow(wf, input, { env: { ...LOCAL_ENV, ...env }, table });
          res.writeHead(r.json.http_status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.json.response));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'local_core', message: String(e.message || e) }));
        }
      });
    });
  });
  server.listen(port, '127.0.0.1', () => console.log('local core on ' + port + (replay ? ', replay ' + replay : ', mock')));
  const stop = () => { if (fake) fake.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { runWorkflow, runCore, startFake, replayAnswers, modelView, loadWorkflow, LOCAL_ENV };

if (require.main === module) serve();
