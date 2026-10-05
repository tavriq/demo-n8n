// Статическая проверка workflows/*.json: синтаксис Code-нод, связи, отсутствие секретов.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'workflows');
let problems = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const wf = JSON.parse(raw);
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.code') {
      try {
        new vm.Script('(async function () {\n' + n.parameters.jsCode + '\n})');
      } catch (e) {
        problems++;
        console.error(f + ' / ' + n.name + ': ' + e.message);
      }
    }
  }
  for (const [src, outs] of Object.entries(wf.connections)) {
    if (!names.has(src)) { problems++; console.error(f + ': связь из неизвестной ноды ' + src); }
    for (const out of outs.main) for (const c of out) {
      if (!names.has(c.node)) { problems++; console.error(f + ': связь в неизвестную ноду ' + c.node); }
    }
  }
  if (/sk-ant-[A-Za-z0-9]/.test(raw)) { problems++; console.error(f + ': похоже на ключ API'); }
}
if (problems) process.exit(1);
console.log('ok: workflows/*.json');
