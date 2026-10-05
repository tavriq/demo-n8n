# Evals: последний прогон

Дата: 2026-10-05 07:52 UTC · режим: **mock** · n8n 2.41.6 · модель: mock
Кейсы: 40 из `evals/cases.jsonl` (sha256 `8a0d67f28152`), отправлено 40, оценено 40. Все строки: `evals/results-2026-10-05-mock.json`.

> **Режим mock: Claude не вызывался.** Ответы дала детерминированная заглушка по ключевым словам (`src/lib/mock.js`). Эти цифры проверяют контур целиком (вебхук, маскирование, cost guard, проверка контракта, журнал, ответ), а не качество LLM. Правила заглушки и разметку писал один автор, поэтому точность заглушки ничего не говорит о модели.

| Метрика | Результат | 95% ДИ | Бейзлайн |
|---|---|---|---|
| category, основная метка | 24/40 = 60% | 45%–74% | 25% (всегда `cleaning`) |
| category, с допустимыми | 28/40 = 70% | 55%–82% | |
| urgency, основная метка | 32/40 = 80% | 65%–90% | 60% (всегда `normal`) |
| urgency, с допустимыми | 39/40 = 98% | 87%–100% | |
| needs_human: recall | 5/8 = 62% | 31%–86% | 0% (никогда не звать) |
| needs_human: precision | 5/14 = 36% | 16%–61% | |
| needs_human: точность | 28/40 = 70% | 55%–82% | 80% |
| город | 35/40 = 88% | 74%–94% | |
| бюджет | 18/19 = 95% | 75%–99% | |
| ответ по контракту (поля, типы, enum, 0..1) | 40/40 = 100% | | |
| контакты скрыты (телефон, email, ник) | 5/5 в 5 кейсах | | |
| prompt injection: не выполнена | 3/3 (и все поля верны: 1) | | |
| ошибки инфраструктуры | 0  | | |
| задержка, мс: среднее / p50 / p95 / max | 292 / 261 / 326 / 1185 | | |
| стоимость: всего / на заявку | $0 / $0 | | |
| повторов запроса к LLM | 0 | | |

95% ДИ — интервал Уилсона. На 40 кейсах он широкий (±10–15 п.п.): разница меньше этого — шум.

## Матрица ошибок: category

Строки — разметка (основная метка), столбцы — ответ.

| | repair | rental | cleaning | consultation | complaint | spam | other |
|---|---|---|---|---|---|---|---|
| **repair** | **3** | 1 | · | · | · | · | 3 |
| **rental** | · | **6** | · | · | · | · | · |
| **cleaning** | · | 1 | **8** | · | · | · | 1 |
| **consultation** | · | 1 | 1 | **1** | · | · | 1 |
| **complaint** | 2 | · | · | · | **3** | · | · |
| **spam** | · | · | 1 | · | · | **1** | 3 |
| **other** | 1 | · | · | · | · | · | **2** |

## Матрица ошибок: urgency

Строки — разметка (основная метка), столбцы — ответ.

| | low | normal | high |
|---|---|---|---|
| **low** | **4** | 5 | · |
| **normal** | 1 | **22** | 1 |
| **high** | · | 1 | **6** |

## Расхождения с разметкой

Только те, где ответ не совпал ни с одной допустимой меткой.

| Кейс | Поле | Разметка | Ответ |
|---|---|---|---|
| `repair-scrubber-typos` | category | "repair" | "other" |
| `repair-scrubber-typos` | needs_human | false | true |
| `repair-scrubber-typos` | city | "Иркутск" | null |
| `repair-compressor-maintenance` | category | "repair" | "other" |
| `repair-compressor-maintenance` | needs_human | false | true |
| `repair-laundry-phone` | category | "repair" | "other" |
| `repair-laundry-phone` | needs_human | false | true |
| `repair-then-rent-out` | category | ["repair", "consultation"] | "rental" |
| `repair-then-rent-out` | needs_human | true | false |
| `rental-heat-gun-tonight` | city | "Подольск" | null |
| `rental-scrubber-longterm` | urgency | ["normal", "low"] | "high" |
| `rental-steam-slang` | city | "Химки" | null |
| `cleaning-windows-range` | budget_rub | [20000, 15000] | 15 |
| `cleaning-move-out-colloquial` | category | "cleaning" | "other" |
| `cleaning-move-out-colloquial` | needs_human | false | true |
| `consult-weekend` | category | "consultation" | "other" |
| `consult-weekend` | needs_human | false | true |
| `consult-tender-docs` | category | ["consultation", "other"] | "cleaning" |
| `complaint-no-callback-caps` | category | "complaint" | "repair" |
| `complaint-no-callback-caps` | needs_human | true | false |
| `complaint-no-callback-caps` | city | "Владивосток" | null |
| `complaint-flooded-sockets` | category | "complaint" | "repair" |
| `complaint-flooded-sockets` | needs_human | true | false |
| `spam-passive-income` | needs_human | false | true |
| `spam-seo` | category | "spam" | "other" |
| `spam-seo` | needs_human | false | true |
| `spam-wrong-layout` | needs_human | false | true |
| `other-job-seeker` | needs_human | false | true |
| `other-apartment-renovation` | category | ["other", "consultation"] | "repair" |
| `injection-force-urgency` | city | "Тверь" | null |
| `injection-english-spam` | category | "spam" | "cleaning" |
