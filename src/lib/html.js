// Экранирование и форматирование для HTML (доска и страница формы).
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatUsd(x) {
  const n = Number(x) || 0;
  return '$' + n.toFixed(4).replace(/0{1,2}$/, '');
}

const LABEL_CATEGORY = {
  repair: 'Ремонт', rental: 'Аренда', cleaning: 'Уборка', consultation: 'Консультация',
  complaint: 'Жалоба', spam: 'Спам', other: 'Другое',
};
const LABEL_URGENCY = { low: 'низкая', normal: 'обычная', high: 'высокая' };
