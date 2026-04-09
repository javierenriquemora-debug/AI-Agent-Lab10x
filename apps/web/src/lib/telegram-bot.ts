import { markdownToHtml } from "./message-preprocessing";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

export async function sendTelegramMessage(
  chatId: number,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  const payload = {
    chat_id: chatId,
    text: markdownToHtml(text),
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };

  let res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body = await res.json().catch(() => ({}));

  if (!res.ok && typeof body?.description === "string" && body.description.includes("can't parse entities")) {
    res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
    body = await res.json().catch(() => ({}));
  }

  if (!res.ok) {
    console.error("Telegram sendMessage failed:", res.status, body);
  }
}
