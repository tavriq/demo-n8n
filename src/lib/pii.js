// Маскирование персональных данных до сохранения и до отправки в LLM.
// Ловит: email, номера карт (13-19 цифр), телефоны (РФ и международные с +), @-ники.
// Бюджеты ("150 000 руб"), даты и короткие числа не трогает.
function maskPII(input) {
  let text = String(input == null ? '' : input);
  const found = { email: 0, phone: 0, card: 0, handle: 0 };

  text = text.replace(
    /[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g,
    () => { found.email++; return '[email скрыт]'; }
  );

  text = text.replace(/(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    found.card++;
    return '[номер карты скрыт]';
  });

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
      found.phone++;
      return '[телефон скрыт]';
    });
  }

  text = text.replace(/(?<![\w@.])@[A-Za-z][A-Za-z0-9_]{4,31}(?!\w)/g, () => {
    found.handle++;
    return '[ник скрыт]';
  });

  const total = found.email + found.phone + found.card + found.handle;
  return { text, found, total };
}
