# FORMA: адаптивний тест MBTI з калібруванням

Безкоштовний стек: **GitHub Pages** (сайт) + **Supabase** (база проходжень) + **Cloudflare Workers Free** (Telegram webhook, API перевірки підписки, нагадування й Gemini-чернетки).

```
index.html       сайт і калібрування (#calibrate)
schema.sql       таблиці, права й адмінські функції Supabase
worker.js        Telegram webhook, API /status, Gemini-чернетки й Cron-нагадування
server.py        попередній Python-варіант; для Cloudflare запуску не потрібен
```

## 1. Supabase
1. Створи проєкт на supabase.com.
2. У SQL Editor встав `schema.sql`, заміни `ВАШ_СИЛЬНИЙ_ПАРОЛЬ` на пароль сторінки `#calibrate` і виконай запит.
3. У Project Settings → API скопіюй Project URL і publishable/anon key.
4. У `index.html` ці два значення можуть бути публічними. Не вставляй у сайт `service_role` або secret key. У базі працюють обмеження RLS з `schema.sql`.

## 2. Telegram і Gemini
1. Створи бота через [@BotFather](https://t.me/BotFather) командою `/newbot`. Токен нікому не надсилай.
2. Додай бота адміністратором публічного каналу з правом публікації; запам'ятай канал як `@імʼя_каналу`.
3. Дізнайся свій числовий Telegram ID через [@userinfobot](https://t.me/userinfobot).
4. Створи Gemini API key у [Google AI Studio](https://aistudio.google.com/app/apikey).

## 3. Безкоштовний бот на Cloudflare Workers
1. Cloudflare → **Workers & Pages** → створи Worker і встав код із `worker.js`.
2. У **Storage & Databases → KV** створи namespace та прив'яжи його до Worker з binding name `KV`.
3. У **Settings → Variables and Secrets** задай:
   - Secrets: `BOT_TOKEN`, `GEMINI_API_KEY`, `WEBHOOK_SECRET` (довгий випадковий рядок із літер і цифр).
   - Variables: `CHANNEL`, `ADMIN_ID`, `GEMINI_MODEL=gemini-2.5-flash`, `SITE_URL=https://krytuidima.github.io/FORMA_MBTI/`, `SITE_ORIGIN=https://krytuidima.github.io`, `TIMEZONE=Europe/Kyiv`, `REMINDER_HOUR=10`.
   - Необов'язково: `TOPICS` — теми через крапку з комою.
4. Зроби Deploy. У **Triggers → Cron Triggers** додай `0 * * * *` — Worker перевірятиме час щогодини й надсилатиме нагадування о 10:00 за Києвом.
5. Після Deploy відкрий `https://ІМʼЯ-ТВОГО-WORKER.ТВІЙ-SUBDOMAIN.workers.dev/setup/WEBHOOK_SECRET`. `WEBHOOK_SECRET` у URL має бути той самий, що в налаштуваннях; URL не публікуй. У відповіді очікується `{"ok":true}`.
6. Напиши мені лише публічну адресу Worker, наприклад `https://назва.піддомен.workers.dev` — без секрету. Я підключу її до GitHub Pages замість зупиненого JustRun API й перевірю `/status`.

### Робота менеджера
- Щодня бот нагадає про пост і перевірку/продовження хостингу. Кнопка «Оновлено» лише позначає нагадування — сама підписку чи оплату не змінює.
- Натисни «Створити пост», щоб Gemini підготував чернетку. Її можна переробити, відхилити або опублікувати; фото/відео можна прикріпити окремо.
- Для ручної чернетки також можна надіслати боту `/post`.

## 4. GitHub Pages
Сайт уже опублікований: https://krytuidima.github.io/FORMA_MBTI/. Після отримання адреси Worker у `index.html` буде встановлено її в `GATE.api`; `SITE_ORIGIN` має бути `https://krytuidima.github.io` без шляху репозиторію.

## Калібрування
- Якщо людина дає згоду на збір, сайт зберігає відповіді й результат у Supabase; ім'я та пошту не збираємо. На сторінці результату можна вказати попередній тип і оцінку.
- Відкрий `ВАШ-САЙТ/#calibrate`, введи пароль зі схеми, натисни «Завантажити й порахувати». Для відкладеної перевірки потрібно близько 35 проходжень із зазначеним типом; краще публікувати калібрування лише на значно більшій вибірці.
- Калібрування спирається на самооцінку, яка теж може бути неточною; результат не призначений для найму чи клінічних рішень.

## Додавання питань
У `index.html` знайди `<script type="application/json" id="bank">`, допиши питання за наявним форматом і зміни `BANK_VER`.

## Обмеження та безпека
- Підписка перевіряється ботом через Telegram `getChatMember`; бот має бути адміністратором каналу.
- Тестові питання вбудовані у браузер, тому доступ можна обійти зміною клієнтського коду. Для жорсткого обмеження питання потрібно видавати із сервера.
- Не додавай `.env` чи секрети до GitHub. Додавай на сайт лише публічний Supabase publishable/anon key.
- Додай політику конфіденційності й спосіб видалення даних за запитом.
