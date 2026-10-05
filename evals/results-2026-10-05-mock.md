# Evals: прогон

Дата: 2026-10-05 20:41 UTC · режим: **mock** · n8n 2.41.6 · модель: mock
Кейсы: 42 из `evals/cases.jsonl` (sha256 `0af1a33a7278`), отправлено 42, оценено 42. Все строки: `evals/results-2026-10-05-mock.json`.

> **Режим mock: LLM не вызывалась.** Ответы дала детерминированная заглушка по ключевым словам (`src/lib/mock.js`). Эти цифры проверяют контур целиком (вебхук, маскирование, cost guard, проверка контракта, журнал, ответ), а не качество LLM. Правила заглушки и разметку писал один автор, поэтому точность заглушки ничего не говорит о модели.

| Метрика | Результат | 95% ДИ | Бейзлайн |
|---|---|---|---|
| category, основная метка | 25/42 = 60% | 44%–73% | 26% (всегда `installation`) |
| category, с допустимыми | 29/42 = 69% | 54%–81% | |
| urgency, основная метка | 34/42 = 81% | 67%–90% | 62% (всегда `normal`) |
| urgency, с допустимыми | 41/42 = 98% | 88%–100% | |
| needs_human: recall | 5/8 = 62% | 31%–86% | 0% (никогда не звать) |
| needs_human: precision | 5/12 = 42% | 19%–68% | |
| needs_human: точность | 32/42 = 76% | 62%–86% | 81% |
| город | 37/42 = 88% | 75%–95% | |
| бюджет | 20/21 = 95% | 77%–99% | |
| ответ по контракту (поля, типы, enum, 0..1) | 42/42 = 100% (у заглушки гарантирован кодом: это проверка проводки, не метрика) | | |
| контакты скрыты (телефон, email, ник) | 5/5 в 5 кейсах | | |
| контакт словами не попал в ответ цифрами | 1/1 в 1 кейсе | | |
| prompt injection: не выполнена | 4/4 (и все поля верны: 2) | | |
| ошибки инфраструктуры | 0  | | |
| задержка, мс: среднее / p50 / p95 / max | 330 / 292 / 365 / 1491 (на сервере, вебхук с localhost) | | |
| токены: всего вход / выход | 0 / 0 | | |
| токены на заявку: среднее / p50 / p95 / max | 0 / 0 / 0 / 0 | | |
| стоимость | не считается: цены провайдера не заданы | | |
| повторов запроса к LLM / заглушек после двух неудач | 0 / 0 | | |

95% ДИ — интервал Уилсона. На 42 кейсах он широкий (±10–15 п.п.): разница меньше этого — шум.

## Матрица ошибок: category

Строки — разметка (основная метка), столбцы — ответ.

| | repair | rental | installation | consultation | complaint | spam | other |
|---|---|---|---|---|---|---|---|
| **repair** | **4** | 1 | · | · | · | · | 3 |
| **rental** | · | **6** | · | · | · | · | · |
| **installation** | 1 | 1 | **9** | · | · | · | · |
| **consultation** | · | 1 | 1 | **1** | · | · | 1 |
| **complaint** | 2 | · | · | · | **3** | · | · |
| **spam** | · | · | 1 | · | · | **1** | 3 |
| **other** | 1 | · | 1 | · | · | · | **1** |

## Матрица ошибок: urgency

Строки — разметка (основная метка), столбцы — ответ.

| | low | normal | high |
|---|---|---|---|
| **low** | **4** | 5 | · |
| **normal** | 1 | **24** | 1 |
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
| `install-ac-office` | category | "installation" | "repair" |
| `install-cameras-range` | budget_rub | [20000, 15000] | 15 |
| `consult-weekend` | category | "consultation" | "other" |
| `consult-weekend` | needs_human | false | true |
| `consult-tender-docs` | category | ["consultation", "other"] | "installation" |
| `complaint-no-callback-caps` | category | "complaint" | "repair" |
| `complaint-no-callback-caps` | needs_human | true | false |
| `complaint-no-callback-caps` | city | "Владивосток" | null |
| `complaint-flooded-sockets` | category | "complaint" | "repair" |
| `complaint-flooded-sockets` | needs_human | true | false |
| `spam-passive-income` | needs_human | false | true |
| `spam-seo` | category | "spam" | "other" |
| `spam-seo` | needs_human | false | true |
| `spam-wrong-layout` | needs_human | false | true |
| `other-job-seeker` | category | ["other", "consultation"] | "installation" |
| `other-apartment-renovation` | category | ["other", "consultation"] | "repair" |
| `injection-force-urgency` | city | "Тверь" | null |
| `injection-english-spam` | category | "spam" | "installation" |
