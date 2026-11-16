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
  const topics = (env.TOPICS || DEFAULT_TOPICS.join(";"))
    .split(";")
    .map((topic) => topic.trim())
    .filter(Boolean);
  if (!topics.length) throw new Error("TOPICS contains no usable topics");
  const topic = topics[Math.floor(Math.random() * topics.length)];
  const system = [
    "Ти редактор українського Telegram-каналу про самопізнання й психологію особистості.",
    "Пиши просто, конкретно, у 3–5 абзацах, без емодзі-спаму і довгих списків хештегів.",
    "MBTI подавай як модель-гіпотезу, а не доведену істину; не став діагнозів, не давай медичних порад, не вигадуй досліджень чи цифр.",
    "Не додавай пояснень для замовника. Заверши запитанням до читачів або запрошенням пройти тест:",
    env.SITE_URL || "",
  ].join(" ");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-2.5-flash"}:generateContent`,
    {
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
                text: `Напиши готовий допис українською на тему: ${topic}. Зроби 3–5 змістовних абзаців, орієнтовно 500–1000 символів. Поверни лише сам допис.`,
              },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.8,
          thinkingConfig: { thinkingBudget: 256 },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Gemini returned HTTP ${response.status}`);
  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error(data.error?.message || "Gemini returned no generated text");
  const text = (candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty post");
  if (text.length > 4096) throw new Error("Gemini's post is too long for Telegram");
  return text;
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
    await telegram(env, "editMessageText", {
      chat_id: env.ADMIN_ID,
      message_id: placeholder.message_id,
      text: "Не вдалося створити чернетку. Перевір Gemini API key та ліміти у журналі Worker.",
    });
    throw error;
  }
}

async function sendReminder(env, localDate) {
  if (!env.ADMIN_ID) throw new Error("ADMIN_ID is required for daily reminders");
  const sentKey = `reminder:${localDate}`;
  if (await env.KV.get(sentKey)) return;
  await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_ID,
    text: "Щоденне нагадування FORMA:\n• Підготуй пост для каналу.\n• Перевір, чи потрібно поновити застосунок.",
    reply_markup: keyboard([
      [{ text: "Створити пост", callback_data: "create" }],
      [{ text: "✅ Оновлено", callback_data: "renewed" }],
    ]),
  });
  await env.KV.put(sentKey, "1", { expirationTtl: 172800 });
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
    await checkSubscription(env, chatId, senderId, text.split(/\s+/, 2)[1] || "");
    return;
  }
  if (!isAdmin(env, senderId)) return;
  if (text === "/post") {
    await createDraft(env);
    return;
  }
  if (text === "/help") {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "/post — створити чернетку. До неї можна додати фото/відео, переробити або опублікувати кнопкою.",
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
  if (data === "renewed") {
    await telegram(env, "editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: "✅ Позначено як оновлене. Наступне нагадування прийде завтра.",
    });
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
        text: "Не вдалося переробити пост. Поточна чернетка залишилась без змін.",
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

function localDateTime(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
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

  async scheduled(event, env, ctx) {
    const local = localDateTime(event.scheduledTime, env.TIMEZONE || "Europe/Kyiv");
    if (local.hour !== (env.REMINDER_HOUR || "10") || local.minute !== "00") return;
    ctx.waitUntil(sendReminder(env, `${local.year}-${local.month}-${local.day}`));
  },
};
