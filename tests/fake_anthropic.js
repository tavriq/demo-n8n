// Локальная заглушка Messages API для проверки LLM-ветки без настоящего ключа.
// Запускается внутри контейнера n8n: node fake_anthropic.js [порт]
// Поведение задаётся маркером в тексте заявки:
//   FAKE_INVALID_ONCE   — первый ответ с битым JSON, второй валидный (проверка повтора)
//   FAKE_INVALID_ALWAYS — оба ответа битые (проверка needs_human-заглушки)
//   FAKE_HTTP_500       — ошибка API
//   FAKE_PII_OUTPUT     — валидный ответ, но модель «восстановила» контакт в summary и next_step
// Пишет в stdout только форму запроса (модель, наличие схемы) и флаг piiLike —
// есть ли в тексте запроса что-то похожее на email, @ник или телефон. Сам текст и заголовки не пишет.
const http = require('http');

const port = Number(process.argv[2] || 18999);
const seen = {};

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
    const headerOk = typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key'].length > 0
      && req.headers['anthropic-version'] === '2023-06-01';
    const schemaOk = body.output_config && body.output_config.format && body.output_config.format.type === 'json_schema';
    const piiLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|@[A-Za-z][A-Za-z0-9_]{4,}|(?:\d[\s()-]*){7,}/.test(text);
    console.log(JSON.stringify({ path: req.url, model: body.model, max_tokens: body.max_tokens, headerOk, schemaOk,
      retry: /не прошёл проверку/.test(text), piiLike }));
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url !== '/v1/messages' || !headerOk) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'bad' } });
    if (/FAKE_HTTP_500/.test(text)) return send(500, { type: 'error', error: { type: 'api_error', message: 'boom' } });
    const key = text.slice(0, 200);
    seen[key] = (seen[key] || 0) + 1;
    const invalid = /FAKE_INVALID_ALWAYS/.test(text) || (/FAKE_INVALID_ONCE/.test(text) && !/не прошёл проверку/.test(text));
    const answer = /FAKE_PII_OUTPUT/.test(text)
      ? { ...valid, summary: 'Сломался компрессор, клиент просит перезвонить на +7 916 123 45 67',
        next_step: 'Позвонить клиенту по 8 916 123-45-67 или написать на ivan.petrov@mail.ru.' }
      : valid;
    send(200, {
      id: 'msg_fake', type: 'message', role: 'assistant', model: body.model,
      stop_reason: 'end_turn',
      usage: { input_tokens: 812, output_tokens: 95 },
      content: [{ type: 'text', text: invalid ? '{"category": "repair", "urgency": ' : JSON.stringify(answer) }],
    });
  });
}).listen(port, '127.0.0.1', () => console.log('fake anthropic on ' + port));
