// Локальная заглушка OpenAI-совместимого chat/completions для проверки LLM-ветки без
// настоящего ключа и без расхода токенов. Запускается внутри контейнера n8n:
//   node fake_openai.js [порт]       (LLM_BASE_URL=http://127.0.0.1:<порт>/v1)
// Поведение задаётся маркером в тексте заявки:
//   FAKE_INVALID_ONCE   — первый ответ с битым JSON, второй валидный (проверка повтора)
//   FAKE_INVALID_ALWAYS — оба ответа битые (проверка needs_human-заглушки)
//   FAKE_HTTP_500       — ошибка API
//   FAKE_PII_OUTPUT     — валидный ответ, но модель «восстановила» контакт в summary и next_step
// В stdout пишет только форму запроса (модель, схема, лимит ответа), флаг piiLike —
// есть ли в тексте запроса что-то похожее на email, @ник или телефон, — и первые
// 12 символов sha256 ключа из Authorization. Сам текст, ключ и заголовки не пишет.
const http = require('http');
const crypto = require('crypto');

const port = Number(process.argv[2] || 18999);

const valid = {
  category: 'repair', urgency: 'high', city: 'Казань', budget_rub: 15000,
  summary: 'Сломался генератор на складе, нужен мастер сегодня',
  next_step: 'Назначить выезд мастера на сегодня и подтвердить клиенту время.',
  needs_human: false, confidence: 0.92,
};

http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch (e) { /* пусто */ }
    const text = JSON.stringify(body.messages || '');
    const auth = String(req.headers.authorization || '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const headerOk = key.length > 0;
    const rf = body.response_format || {};
    const schemaOk = rf.type === 'json_schema' && rf.json_schema && rf.json_schema.strict === true
      && rf.json_schema.schema && rf.json_schema.schema.additionalProperties === false;
    const piiLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|@[A-Za-z][A-Za-z0-9_]{4,}|(?:\d[\s()-]*){7,}/.test(text);
    console.log(JSON.stringify({ path: req.url, model: body.model, max_completion_tokens: body.max_completion_tokens,
      headerOk, schemaOk, keySha: crypto.createHash('sha256').update(key).digest('hex').slice(0, 12),
      retry: /не прошёл проверку/.test(text), piiLike }));
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!/\/chat\/completions$/.test(req.url) || !headerOk) {
      return send(401, { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'bad' } });
    }
    if (/FAKE_HTTP_500/.test(text)) return send(500, { error: { type: 'server_error', message: 'boom' } });
    const invalid = /FAKE_INVALID_ALWAYS/.test(text) || (/FAKE_INVALID_ONCE/.test(text) && !/не прошёл проверку/.test(text));
    const answer = /FAKE_PII_OUTPUT/.test(text)
      ? { ...valid, summary: 'Сломался компрессор, клиент просит перезвонить на +7 916 123 45 67',
        next_step: 'Позвонить клиенту по 8 916 123-45-67 или написать на ivan.petrov@mail.ru.' }
      : valid;
    const content = invalid ? '{"category": "repair", "urgency": ' : JSON.stringify(answer);
    send(200, {
      id: 'chatcmpl-fake', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 812, completion_tokens: 95, total_tokens: 907 },
    });
  });
}).listen(port, '127.0.0.1', () => console.log('fake openai on ' + port));
