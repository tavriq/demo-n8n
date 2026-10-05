// Экранирование и форматирование для HTML (доска и страница формы).
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 200000 -> «200 000» (неразрывный пробел между разрядами)
function formatInt(x) {
  return String(Math.round(Number(x) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}

function formatRub(x) {
  return (Number(x) || 0).toFixed(2) + '\u00a0₽';
}

const LABEL_CATEGORY = {
  repair: 'Ремонт', rental: 'Аренда', installation: 'Монтаж', consultation: 'Консультация',
  complaint: 'Жалоба', spam: 'Спам', other: 'Другое',
};
const LABEL_URGENCY = { low: 'низкая', normal: 'обычная', high: 'высокая' };
