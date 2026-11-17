// FORMA Telegram manager and subscription-check API for Cloudflare Workers.
// Bind a Workers KV namespace as KV; configure the documented variables/secrets.
const DEFAULT_TOPICS = [
  "когнітивні функції простими словами",
  "різниця між схожими типами",
  "типові помилки в мисленні",
  "як працювати з сильними сторонами",
  "MBTI і Big Five: що відомо науці",
];
const TTL = 172800;
const POST_HISTORY_KEY = "post-history";
const POST_HISTORY_LIMIT = 12;
const POST_FORMATS = [
  "сценка з повсякденного життя",
  "двоє людей — одна ситуація — різні реакції",
  "міф і як буває насправді",
  "питання-опитування",
  "мікропорада, яку можна спробувати сьогодні",
  "впізнавана коротка історія",
];
const j = (data, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
const keyboard = (rows) => ({ inline_keyboard: rows });

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed: ${result.description || "unknown error"}`);
  return result.result;
}

function isAdmin(env, userId) {
  return Boolean(env.ADMIN_ID) && String(userId) === String(env.ADMIN_ID);
}

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function draftKeyboard(id) {
  return keyboard([
    [
      { text: "Опублікувати", callback_data: `pub:${id}` },
      { text: "Переробити", callback_data: `regen:${id}` },
    ],
    [{ text: "Додати фото/відео (необов'язково)", callback_data: `media:${id}` }],
    [{ text: "Відхилити", callback_data: `rej:${id}` }],
  ]);
}

function draftText(draft) {
  return `Чернетка поста:\n\n${draft.text}${draft.mediaType ? "\n\n✅ Медіа додано." : ""}`;
}

async function getDraft(env, id) {
  const value = await env.KV.get(`d:${id}`);
  return value ? JSON.parse(value) : null;
}

async function getPostHistory(env) {
  const value = await env.KV.get(POST_HISTORY_KEY);
  if (!value) return [];
  const history = JSON.parse(value);
  if (
    !Array.isArray(history) ||
    history.some(
      (entry) =>
        !entry ||
        typeof entry.text !== "string" ||
        typeof entry.topic !== "string" ||
        typeof entry.format !== "string" ||
        typeof entry.invitedToTest !== "boolean",
    )
  ) {
    throw new Error("Stored post history has an invalid format");
  }
  return history.slice(-POST_HISTORY_LIMIT);
}

async function updateDraftMessage(env, id, draft) {
  await env.KV.put(`d:${id}`, JSON.stringify(draft), { expirationTtl: TTL });
  await telegram(env, "editMessageText", {
    chat_id: env.ADMIN_ID,
    message_id: draft.messageId,
    text: draftText(draft),
    reply_markup: draftKeyboard(id),
  });
}

async function checkSubscription(env, chatId, userId, token) {
  if (!/^[0-9a-f]{24}$/.test(token)) {
    return telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "Відкрийте бота за кнопкою на сайті тесту.",
    });
  }
  const member = await telegram(env, "getChatMember", {
    chat_id: env.CHANNEL,
    user_id: userId,
  });
  if (["member", "administrator", "creator"].includes(member.status)) {
    await env.KV.put(`t:${token}`, "1", { expirationTtl: 86400 });
    return telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "Підписку підтверджено. Поверніться на сайт: тест уже відкрився.",
    });
  }
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text: "Підписки на канал ще немає. Підпишіться й натисніть «перевірити».",
    reply_markup: keyboard([
      [{ text: "Підписатися на канал", url: `https://t.me/${env.CHANNEL.replace(/^@/, "")}` }],
      [{ text: "Я підписався(лась), перевірити", callback_data: `chk:${token}` }],
    ]),
  });
}

async function generatePost(env) {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const history = await getPostHistory(env);
  const topics = (env.TOPICS || DEFAULT_TOPICS.join(";"))
    .split(";")
    .map((topic) => topic.trim())
    .filter(Boolean);
  if (!topics.length) throw new Error("TOPICS contains no usable topics");
  const recentTopics = history.slice(-5).map((post) => post.topic);
  const availableTopics = topics.filter((topic) => !recentTopics.includes(topic));
  const topicPool = availableTopics.length ? availableTopics : topics;
  const topic = topicPool[Math.floor(Math.random() * topicPool.length)];
  const recentFormats = history.slice(-3).map((post) => post.format);
  const availableFormats = POST_FORMATS.filter((format) => !recentFormats.includes(format));
  const formatPool = availableFormats.length ? availableFormats : POST_FORMATS;
  const format = formatPool[Math.floor(Math.random() * formatPool.length)];
  const maxLength = 1000;
  const invitedToTest =
    history.slice(-3).every((post) => !post.invitedToTest) && Math.random() < 0.25;
  const priorPosts = history.length
    ? history.map((post) => post.text).join("\n\n---\n\n")
    : "Історія дописів поки порожня.";
  const system = [
    "Ти автор українського Telegram-каналу про те, як люди мислять, відчувають і ухвалюють рішення на основі моделі MBTI та когнітивних функцій.",
    "Твоя мета — зацікавити читача, допомогти йому впізнати себе й захотіти читати далі.",
    "Голос: кмітливий друг у кав'ярні, не підручник і не лектор. Пиши живою, чистою українською, звертайся на «ви», тепло й без канцеляриту та кальок.",
    "Починай із чіпкого першого рядка: впізнавана сценка, несподіване питання або сміливе, але чесне твердження. Не починай із теми чи визначення.",
    "Покажи 1–3 конкретні побутові приклади. Термінів мінімум; якщо вживаєш Ni, Fe чи інший термін, одразу поясни його просто.",
    `Для цього допису використай формат: ${format}.`,
    "Закінчи запитанням до читачів або маленьким прикладом, який можна спробувати сьогодні.",
    invitedToTest
      ? `Цього разу доречно ненав'язливо запросити пройти тест: ${env.SITE_URL || ""}`
      : "Цього разу не запрошуй проходити тест.",
    `Зазвичай пиши 450–800 символів разом із пробілами; рідко можна до ${maxLength}, якщо цього потребує думка чи міні-історія. Зроби 2–4 короткі абзаци.`,
    "Поверни простий текст без Markdown. Емодзі — 0–2, хештеги — не більше одного й лише за потреби.",
    "Подавай MBTI як модель для саморефлексії, а не доведену істину. Не вигадуй досліджень, цитат, імен учених чи цифр. Не став діагнозів і не давай медичних чи психотерапевтичних порад.",
    "Не висміюй людей і типи, не створюй стереотипів, не діли типи на кращі й гірші, не лякай і не маніпулюй. Не вдавай, що маєш особистий людський досвід.",
    "Чергуй подачу. Не повторюй попередні гачки, сцени, приклади, висновки, формулювання чи структуру.",
  ].join(" ");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-2.5-flash"}:generateContent`;
  let lastIssue = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = attempt
      ? `Попередній варіант не підійшов: ${lastIssue}. Напиши інший допис, суворо дотримайся довжини 450–${maxLength} символів і не повторюй історію.`
      : "";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  `Напиши готовий допис українською на тему: ${topic}.`,
                  `Формат: ${format}.`,
                  invitedToTest
                    ? "Запрошення до тесту можна додати ненав'язливо."
                    : "Не додавай запрошення до тесту.",
                  `Не повторюй ці попередні згенеровані дописи:\n\n${priorPosts}`,
                  retry,
                  "Поверни лише текст допису.",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.9,
          thinkingConfig: { thinkingBudget: 256 },
        },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      let detail = body;
      try {
        detail = JSON.parse(body).error?.message || body;
      } catch {
        // Keep the provider's plain-text response for diagnostics.
      }
      throw new Error(`Gemini API HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) throw new Error(data.error?.message || "Gemini returned no generated text");
    const text = (candidate.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();
    if (!text) throw new Error("Gemini returned an empty post");
    const length = Array.from(text).length;
    const duplicate = history.some(
      (post) => post.text.toLowerCase().replace(/\s+/g, " ").trim() ===
        text.toLowerCase().replace(/\s+/g, " ").trim(),
    );
    if (length < 450 || length > maxLength) {
      lastIssue = `згенеровано ${length} символів`;
      continue;
    }
    if (duplicate) {
      lastIssue = "текст повторює попередній допис";
      continue;
    }
    history.push({ text, topic, format, invitedToTest });
    await env.KV.put(POST_HISTORY_KEY, JSON.stringify(history.slice(-POST_HISTORY_LIMIT)));
    return text;
  }
  throw new Error(`Gemini did not generate a unique 450–${maxLength}-character post: ${lastIssue}`);
}

async function createDraft(env) {
  const placeholder = await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_ID,
    text: "Готую чернетку поста…",
  });
  const id = newId();
  try {
    const text = await generatePost(env);
    const draft = { text, mediaType: null, mediaId: null, messageId: placeholder.message_id };
    await env.KV.put(`d:${id}`, JSON.stringify(draft), { expirationTtl: TTL });
    await telegram(env, "editMessageText", {
      chat_id: env.ADMIN_ID,
      message_id: placeholder.message_id,
      text: draftText(draft),
      reply_markup: draftKeyboard(id),
    });
  } catch (error) {
    console.error("Post generation failed:", error);
    const reason = error instanceof Error ? error.message : String(error);
    await telegram(env, "editMessageText", {
      chat_id: env.ADMIN_ID,
      message_id: placeholder.message_id,
      text: `Не вдалося створити чернетку.\nПричина: ${reason.slice(0, 300)}`,
    });
  }
}

async function sendAdminMenu(env) {
  await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_ID,
    text: "Адмін-панель. Створи чернетку будь-коли; автоматичних нагадувань немає.",
    reply_markup: keyboard([
      [{ text: "Створити пост зараз", callback_data: "create" }],
    ]),
  });
}

async function publishDraft(env, draft) {
  if (!draft.mediaId) {
    return telegram(env, "sendMessage", { chat_id: env.CHANNEL, text: draft.text });
  }
  const method = draft.mediaType === "photo" ? "sendPhoto" : "sendVideo";
  const mediaField = draft.mediaType === "photo" ? "photo" : "video";
  if (draft.text.length <= 1000) {
    return telegram(env, method, {
      chat_id: env.CHANNEL,
      [mediaField]: draft.mediaId,
      caption: draft.text,
    });
  }
  await telegram(env, method, { chat_id: env.CHANNEL, [mediaField]: draft.mediaId });
  return telegram(env, "sendMessage", { chat_id: env.CHANNEL, text: draft.text });
}

async function handleMessage(update, env) {
  const message = update.message;
  const senderId = message.from?.id;
  const chatId = message.chat.id;
  const text = message.text || "";

  if (text.startsWith("/start")) {
    const token = text.split(/\s+/, 2)[1] || "";
    if (isAdmin(env, senderId) && !token) {
      await sendAdminMenu(env);
      return;
    }
    await checkSubscription(env, chatId, senderId, token);
    return;
  }
  if (!isAdmin(env, senderId)) return;
  if (text === "/admin") {
    await sendAdminMenu(env);
    return;
  }
  if (text === "/post") {
    await createDraft(env);
    return;
  }
  if (text === "/help") {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "/admin — відкрити кнопку створення поста без зміни нагадування.\n/post — створити чернетку командою. До неї можна додати фото/відео, переробити або опублікувати кнопкою.",
    });
    return;
  }

  const draftId = await env.KV.get(`awaiting:${senderId}`);
  if (!draftId) return;
  const draft = await getDraft(env, draftId);
  if (!draft) {
    await env.KV.delete(`awaiting:${senderId}`);
    return;
  }
  let mediaType;
  let mediaId;
  if (message.photo?.length) {
    mediaType = "photo";
    mediaId = message.photo[message.photo.length - 1].file_id;
  } else if (message.video?.file_id) {
    mediaType = "video";
    mediaId = message.video.file_id;
  } else {
    return;
  }
  draft.mediaType = mediaType;
  draft.mediaId = mediaId;
  await env.KV.delete(`awaiting:${senderId}`);
  await updateDraftMessage(env, draftId, draft);
  await telegram(env, "sendMessage", { chat_id: chatId, text: "Медіа прикріплено до чернетки." });
}

async function handleCallback(query, env) {
  const { data = "", from, message } = query;
  await telegram(env, "answerCallbackQuery", { callback_query_id: query.id });
  if (data.startsWith("chk:")) {
    await checkSubscription(env, message.chat.id, from.id, data.slice(4));
    return;
  }
  if (!isAdmin(env, from.id)) return;
  if (data === "create") {
    await createDraft(env);
    return;
  }
  const [action, id] = data.split(":");
  if (!id) return;
  const draft = await getDraft(env, id);
  if (!draft) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "Термін зберігання цієї чернетки минув. Створи нову командою /post.",
    });
    return;
  }
  if (action === "media") {
    await env.KV.put(`awaiting:${from.id}`, id, { expirationTtl: TTL });
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "Надішли сюди фото або відео для цієї чернетки.",
    });
    return;
  }
  if (action === "regen") {
    try {
      draft.text = await generatePost(env);
      draft.mediaType = null;
      draft.mediaId = null;
      await env.KV.delete(`awaiting:${from.id}`);
      await updateDraftMessage(env, id, draft);
    } catch (error) {
      console.error("Post regeneration failed:", error);
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `Не вдалося переробити пост. Поточна чернетка залишилась без змін.\nПричина: ${
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        }`,
      });
    }
    return;
  }
  if (action === "pub") {
    await publishDraft(env, draft);
    await env.KV.delete(`d:${id}`);
    await env.KV.delete(`awaiting:${from.id}`);
    await telegram(env, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: "✅ Опубліковано в каналі.",
    });
    return;
  }
  if (action === "rej") {
    await env.KV.delete(`d:${id}`);
    await env.KV.delete(`awaiting:${from.id}`);
    await telegram(env, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: "Чернетку відхилено.",
    });
  }
}

async function handle(update, env) {
  if (update.message) return handleMessage(update, env);
  if (update.callback_query) return handleCallback(update.callback_query, env);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = env.SITE_ORIGIN || "*";
    if (request.method === "OPTIONS") return j({}, 200, origin);
    if (url.pathname === "/status" && request.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const ok = /^[0-9a-f]{24}$/.test(token) && Boolean(await env.KV.get(`t:${token}`));
      return j({ ok }, 200, origin);
    }
    if (
      url.pathname === `/webhook/${env.WEBHOOK_SECRET}` &&
      request.method === "POST"
    ) {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(
        handle(update, env).catch(async (error) => {
          console.error("Telegram update failed:", error);
          const userId =
            update.message?.from?.id || update.callback_query?.from?.id;
          if (isAdmin(env, userId)) {
            try {
              await telegram(env, "sendMessage", {
                chat_id: env.ADMIN_ID,
                text: "Сталася помилка. Спробуй ще раз; деталі доступні в журналах Worker.",
              });
            } catch (notifyError) {
              console.error("Could not notify admin:", notifyError);
            }
          }
        }),
      );
      return new Response("ok");
    }
    if (url.pathname === `/setup/${env.WEBHOOK_SECRET}` && request.method === "GET") {
      const result = await telegram(env, "setWebhook", {
        url: `${url.origin}/webhook/${env.WEBHOOK_SECRET}`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
      });
      return j({ ok: result }, 200, origin);
    }
    return new Response("FORMA");
  },
};
