# Ukrainian UI glossary

The terms the Ukrainian catalog (`src/i18n/messages/uk.ts`) uses. Use them
consistently; when a new string needs a term that is not here, add it.

## Terms

| English | Ukrainian |
| --- | --- |
| Expense / Expenses | Витрата / Витрати |
| Income | Дохід / Доходи |
| Transaction / Transactions | Операція / Операції (nav: «Операції») |
| Add transaction | Додати операцію |
| Quick Add | Швидке додавання |
| Category | Категорія |
| Budget | Бюджет |
| Left to spend | Залишилось витратити |
| Recurring | Регулярні платежі |
| Subscription | Підписка |
| Upcoming | Найближчі |
| Due | До сплати |
| Analytics | Аналітика |
| Dashboard / Home | Головна |
| Settings | Налаштування |
| Main currency | Основна валюта |
| Exchange rate | Курс |
| rate pending | очікує курсу |
| NBU | НБУ |
| Encryption password | Пароль шифрування |
| Recovery key | Ключ відновлення |
| Lock | Заблокувати |
| Unlock | Розблокувати |
| Backup | Резервна копія |
| Restore | Відновити |
| Remove data from this device | Видалити дані з цього пристрою |
| Account | Обліковий запис |
| Sign in | Увійти |
| Sync | Синхронізація |
| Plan | Тариф |
| Beta | Бета |
| Device | Пристрій |
| Cloud data | Дані в хмарі |
| Sync now | Синхронізувати зараз |
| Last synced | Остання синхронізація |
| Turn on sync | Увімкнути синхронізацію |
| This device | Цей пристрій |
| Delete cloud data | Видалити дані з хмари |
| Terms of Use | Умови використання |
| Privacy Policy | Політика конфіденційності |

## Style

- Formal-neutral imperative for actions and instructions: «Додайте», «Введіть», «Виберіть».
- Ukrainian quotation marks «…» in prose (also around user data such as category names in messages).
- The brand «MinimaSpend» and the currency codes `USD` / `EUR` are never translated; the hryvnia is shown as «грн» next to an amount.
- Amounts, dates and plurals come from `src/i18n/format.ts` and `plural()`; never build them by hand in a message.
- Default categories for a new Ukrainian vault: Їжа, Транспорт, Оренда, Кава, Розваги, Сервери; income: Зарплата, Фриланс, Подарунки, Інвестиції, Повернення, Інше.
