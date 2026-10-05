// Доска: последние 20 заявок + расход за сегодня. Весь текст пользователя и модели
// экранируется; внешних ресурсов и скриптов нет (CSP: default-src 'none', разрешены
// только встроенные стили). Текст спама, жалоб, неясных заявок и заявок с грубой
// лексикой не показывается: его видит только менеджер.
const pick = (name) => $(name).all().map((i) => i.json).filter((r) => r && r.ts !== undefined && r.ts !== null);
const latest = pick('Последние 20').sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, 20);
const today = pick('Расход за сегодня');

const env = (name, def) => {
  const v = $env[name];
  return v === undefined || v === null || String(v).trim() === '' ? def : String(v).trim();
};
const budget = Number(env('DAILY_BUDGET_USD', '0.5')) || 0.5;
const spent = today.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
const pct = Math.min(100, Math.round((spent / budget) * 100));
const live = env('ANTHROPIC_API_KEY', '') !== '' && env('TRIAGE_FORCE_MOCK', 'false').toLowerCase() !== 'true';
const modeNow = live ? 'LLM (' + env('LLM_MODEL', 'claude-haiku-4-5-20251001') + ')' : 'mock: ключ API не задан, работает заглушка по ключевым словам';
const tz = 'Europe/Moscow';

const cut = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

const cards = latest.map((r) => {
  const when = DateTime.fromMillis(Number(r.ts)).setZone(tz).toFormat('dd.MM HH:mm');
  const tags = [
    '<span class="tag cat-' + escapeHtml(r.category) + '">' + escapeHtml(LABEL_CATEGORY[r.category] || r.category) + '</span>',
    '<span class="tag urg-' + escapeHtml(r.urgency) + '">срочность: ' + escapeHtml(LABEL_URGENCY[r.urgency] || r.urgency) + '</span>',
    r.needs_human ? '<span class="tag human">нужен человек</span>' : '',
    '<span class="tag mode">' + escapeHtml(r.mode) + '</span>',
  ].join('');
  const hidden = hiddenReason(r);
  if (hidden) {
    return [
      '<article class="card hidden">',
      '<div class="row"><time>' + escapeHtml(when) + '</time><div class="tags">' + tags + '</div></div>',
      '<p class="muted">Текст скрыт: ' + escapeHtml(hidden) + '.</p>',
      '</article>',
    ].join('');
  }
  const facts = [];
  if (r.city) facts.push('город: ' + escapeHtml(r.city));
  if (r.budget_rub !== null && r.budget_rub !== undefined && r.budget_rub !== '') facts.push('бюджет: ' + escapeHtml(r.budget_rub) + ' ₽');
  if (Number(r.pii_masked) > 0) facts.push('скрыто контактов: ' + escapeHtml(r.pii_masked));
  return [
    '<article class="card">',
    '<div class="row"><time>' + escapeHtml(when) + '</time><div class="tags">' + tags + '</div></div>',
    '<p class="summary">' + escapeHtml(r.summary) + '</p>',
    '<p class="next"><b>Дальше:</b> ' + escapeHtml(r.next_step) + '</p>',
    facts.length ? '<p class="facts">' + facts.join(' · ') + '</p>' : '',
    '<blockquote>' + escapeHtml(cut(r.text_masked, 200)) + '</blockquote>',
    '</article>',
  ].join('');
}).join('\n');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Триаж заявок: доска</title>
<style>
:root{--bg:#f6f7f9;--fg:#1d2330;--muted:#5d6676;--card:#fff;--line:#e2e5ea;--accent:#2f6fde;--warn:#b5432b;--ok:#2d7a4f;--chip:#eef1f5}
@media (prefers-color-scheme:dark){:root{--bg:#14171c;--fg:#e6e9ee;--muted:#9aa3b2;--card:#1d2128;--line:#2c323b;--accent:#7aa7ff;--warn:#ff8a70;--ok:#6fcf97;--chip:#262b33}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}
.lead{color:var(--muted);margin:0 0 16px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:16px}
.meter{height:8px;background:var(--chip);border-radius:4px;overflow:hidden;margin-top:8px}
.meter span{display:block;height:100%;background:var(--accent)}
.small{color:var(--muted);font-size:13px;margin:6px 0 0}
a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:10px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
time{color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}
.tags{display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--chip)}
.tag.human{color:var(--warn);font-weight:600}
.tag.urg-high{color:var(--warn)}
.tag.mode{font-family:ui-monospace,Menlo,monospace}
.summary{margin:8px 0 4px;font-weight:600}
.next{margin:0 0 4px}
.facts{margin:0 0 4px;color:var(--muted);font-size:13px}
blockquote{margin:8px 0 0;padding:6px 10px;border-left:3px solid var(--line);color:var(--muted);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}
.empty{color:var(--muted);text-align:center;padding:24px}
.muted{color:var(--muted);margin:8px 0 0;font-size:13px}
.card.hidden{opacity:.85}
</style>
</head>
<body>
<main>
<h1>Триаж входящих заявок</h1>
<p class="lead">Демо на n8n: текст заявки разбирается в JSON (категория, срочность, город, бюджет, следующий шаг). Телефоны, email и ники маскируются до сохранения. Текст спама, жалоб и неясных заявок здесь не показывается. Всё, что здесь видно, публично.</p>
<section class="panel" aria-label="Расход">
<div>Потрачено сегодня: <b>${escapeHtml(formatUsd(spent))}</b> из ${escapeHtml(formatUsd(budget))}</div>
<div class="meter" role="img" aria-label="${pct}% дневного бюджета"><span style="width:${pct}%"></span></div>
<p class="small">Режим сейчас: ${escapeHtml(modeNow)}. Лимиты: ${escapeHtml(env('RATE_LIMIT_PER_IP_HOUR', '5'))} заявок в час с адреса, ${escapeHtml(env('RATE_LIMIT_GLOBAL_HOUR', '60'))} в час через форму.</p>
<p class="small"><a href="../form/triage-demo" target="_top">Отправить свою заявку</a></p>
</section>
<h2 style="font-size:16px;margin:20px 0 10px">Последние заявки: ${latest.length} из 20</h2>
${cards || '<p class="empty">Пока пусто.</p>'}
</main>
</body>
</html>`;

return [{ json: { html } }];
