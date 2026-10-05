// Маскирование персональных данных до сохранения и до отправки в LLM, а также
// повторно на выходе модели (summary, next_step, city).
// Ловит: ссылки на профили (t.me, vk.com, wa.me и др.), email (включая кириллические
// и «ivan собака mail точка ru»), номера карт, ИНН/СНИЛС/паспорт РФ, телефоны
// (РФ в любых разделителях, международные с +), @ники и ники после «тг:», «telegram» и т.п.
// Бюджеты («150 000 руб», «от 80 000-900 000»), даты и короткие числа не трогает.
// Не ловит: телефон словами, адреса, ФИО, ник без @ и без слова-маркера.

const PII_LABEL = {
  link: '[ссылка скрыта]',
  email: '[email скрыт]',
  card: '[номер карты скрыт]',
  doc: '[номер документа скрыт]',
  phone: '[телефон скрыт]',
  handle: '[ник скрыт]',
};

// разделитель между цифрами телефона: пробел, точка, дефис, скобка (с пробелами вокруг)
const PII_SEP = '(?:[ \\u00a0]?[().\\-\\u2013][ \\u00a0]?|[ \\u00a0])';
const PII_DIGIT_RUN = new RegExp('(?<![\\p{L}\\p{N}_+])\\+?\\(?\\d(?:' + PII_SEP + '?\\(?\\d\\)?)*', 'gu');

// «80 000 - 900 000», «15 000–20 000»: диапазон сумм с группами по три цифры, не телефон
function piiIsMoneyRange(run) {
  const parts = run.split(/\s*[-–]\s*/);
  return parts.length >= 2 && parts.every((p) => /^\d{1,3}(?:[  ]\d{3})+$/.test(p.trim()));
}

function piiLooksLikePhone(run) {
  const digits = run.replace(/\D/g, '');
  if (digits.length === 11 && /^[78]/.test(digits)) return true;
  if (digits.length === 11 && run.trim().startsWith('+')) return true;
  if (digits.length === 10 && digits[0] === '9') return true;
  // (495)123-45-67: код города в скобках без префикса
  if (digits.length === 10 && /^\(\s*\d(?:[  ]?\d){2}\s*\)/.test(run.trim())) return true;
  return false;
}

// В серии цифр ищет телефон: вся серия или окно из соседних групп цифр
// (телефон, за которым через пробел идёт ещё число). Возвращает серию с метками.
function piiMaskRun(run, label) {
  const groups = [];
  const re = /\d+/g;
  let g;
  while ((g = re.exec(run)) !== null) groups.push({ s: g.index, e: g.index + g[0].length, n: g[0].length });
  const start = (i) => {
    let s = groups[i].s;
    while (s > 0 && (run[s - 1] === '(' || run[s - 1] === '+' || run[s - 1] === ' ' && run[s - 2] === '+')) s--;
    return s;
  };
  let out = '';
  let pos = 0;
  for (let i = 0; i < groups.length; i++) {
    let digits = 0;
    for (let j = i; j < groups.length; j++) {
      digits += groups[j].n;
      if (digits > 11) break;
      if (digits < 10) continue;
      let end = groups[j].e;
      if (run[end] === ')') end++;
      const span = run.slice(start(i), end);
      if (piiLooksLikePhone(span) && !piiIsMoneyRange(span)) {
        out += run.slice(pos, start(i)) + label();
        pos = end;
        i = j;
        break;
      }
    }
  }
  return pos === 0 ? run : out + run.slice(pos);
}

function maskPII(input) {
  let text = String(input == null ? '' : input);
  const found = { link: 0, email: 0, card: 0, doc: 0, phone: 0, handle: 0 };
  const put = (kind) => { found[kind]++; return PII_LABEL[kind]; };

  // ссылки на профили целиком: в них бывают телефоны (wa.me/7999...) и ники
  text = text.replace(
    /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog|vk\.com|vk\.ru|m\.vk\.com|wa\.me|api\.whatsapp\.com|instagram\.com|ok\.ru|facebook\.com|fb\.com)\/[^\s,;)\]]+/giu,
    () => put('link')
  );

  // email: латиница и кириллица, IDN-домены
  text = text.replace(
    /[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}\-]+(?:\.[\p{L}\p{N}\-]+)*\.\p{L}{2,}/gu,
    () => put('email')
  );
  // email без домена верхнего уровня: «ivan@gmail»
  text = text.replace(/(?<![\p{L}\p{N}._%+\-])[\p{L}\p{N}._%+\-]{2,}@[\p{L}\p{N}\-]{2,}(?![\p{L}\p{N}.@])/gu, () => put('email'));
  // email словами: «ivan собака mail точка ru», «ivan [at] mail [dot] ru»
  // (голые «at»/«dot» без скобок не берём: «look at this dot net» — не адрес)
  text = text.replace(
    /[A-Za-z0-9._%+\-]+(?:\s*[(\[]\s*(?:at|dog|собака)\s*[)\]]\s*|\s+собака\s+)[A-Za-z0-9\-]+(?:(?:\s*[(\[]\s*(?:dot|точка)\s*[)\]]\s*|\s+точка\s+)[A-Za-z]{2,})+/giu,
    () => put('email')
  );

  // номер карты: 13-19 цифр
  text = text.replace(/(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return put('card');
  });

  // ИНН (10 или 12 цифр) рядом со словом «ИНН»
  text = text.replace(/(?<![\p{L}])(ИНН|inn)(\s*[:№#]?\s*)\d{10}(?:\d{2})?(?!\d)/giu, (m, w, sp) => w + sp + put('doc'));
  // СНИЛС: 123-456-789 01
  text = text.replace(/(?<!\d)\d{3}[- ]\d{3}[- ]\d{3}[- ]\d{2}(?!\d)/g, () => put('doc'));
  // паспорт РФ: 4510 123456, 45 10 123456, «паспорт 4510123456»
  text = text.replace(/(?<!\d)\d{2}[  ]?\d{2}[  ]?(?:№[  ]?)?\d{6}(?!\d)(?![  ]*(?:руб|р\.|₽|тыс))/gu, (m) => {
    // без пробела между частями это скорее телефон или сумма: берём только с «паспорт» рядом
    if (!/\s|№/.test(m)) return m;
    return put('doc');
  });
  text = text.replace(/(паспорт\S*\s*(?:серия\s*)?)(\d{10})(?!\d)/giu, (m, w) => w + put('doc'));

  const phonePatterns = [
    // РФ: +7 / 7 / 8, затем 10 цифр с пробелами, дефисами, скобками
    /(?<![\d+])(?:\+7|8|7)[ \-]?\(?\d{3}\)?[ \-]?\d{3}[ \-]?\d{2}[ \-]?\d{2}(?!\d)/g,
    // мобильный РФ без префикса: 9XX XXX XX XX
    /(?<![\d+])9\d{2}[ \-]?\d{3}[ \-]?\d{2}[ \-]?\d{2}(?!\d)/g,
    // международный с плюсом
    /(?<![\d+])\+\d{1,3}[ \-]?\(?\d{1,4}\)?(?:[ \-]?\d{2,4}){2,4}(?!\d)/g,
  ];
  for (const re of phonePatterns) {
    text = text.replace(re, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return m;
      return put('phone');
    });
  }
  // остальные записи телефона: «(916)123-45-67», «+7.916.123.45.67», «8 9 1 6 1 2 3 4 5 6 7»,
  // «8 (4 9 5) 123-45-67». Берём серию цифр с разделителями и смотрим на число цифр и префикс.
  text = text.replace(PII_DIGIT_RUN, (m, offset, whole) => {
    const after = whole.slice(offset + m.length, offset + m.length + 12);
    if (/^\s*(?:руб|р\.|₽|тыс|т\.р|млн|к(?![а-яё]))/i.test(after)) return m;
    return piiMaskRun(m, () => put('phone'));
  });

  // @ник
  text = text.replace(/(?<![\w@.])@[A-Za-z][A-Za-z0-9_]{4,31}(?!\w)/g, () => put('handle'));
  // ник после слова-маркера: «tg: ivan_petrov», «телеграм ivan_petrov», «инста ivan.petrov»
  text = text.replace(
    /(?<![\p{L}\p{N}_])(tg|тг|телег\p{L}*|telegram|инст\p{L}*|insta\p{L}*|skype|скайп\p{L}*|ник)(\s*[:\-—]?\s*)([A-Za-z][A-Za-z0-9_.]{3,31})(?![A-Za-z0-9_])/giu,
    (m, w, sp) => w + sp + put('handle')
  );

  const total = Object.values(found).reduce((s, n) => s + n, 0);
  return { text, found, total };
}
