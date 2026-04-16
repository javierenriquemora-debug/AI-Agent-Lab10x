/**
 * Client-safe formatting utilities.
 * This file can be imported by both server and client components.
 */

/**
 * Converts Markdown formatting to HTML and turns bare URLs into clickable links.
 * Used in the web chat interface and applied to Telegram outgoing messages.
 */
export function formatMessageToHtml(text: string): string {
  let formatted = normalizeHtmlForTelegram(text);

  // If the message already contains supported HTML tags, preserve the safe subset as-is.
  // This avoids corrupting valid Telegram HTML like <b>...</b> or <code>...</code>
  // when the text also contains underscores or other markdown-like characters.
  if (/<\/?[a-z][\s\S]*?>/i.test(formatted)) {
    return formatted;
  }

  return (
    formatted
      // Bold
      .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
      .replace(/__([\s\S]+?)__/g, "<b>$1</b>")
      // Italic
      .replace(/\*([^*\n]+?)\*/g, "<i>$1</i>")
      .replace(/_([^_\n]+?)_/g, "<i>$1</i>")
      // URLs → links
      .replace(
        /(https?:\/\/[^\s<>"]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#3b82f6;text-decoration:underline;word-break:break-all;">$1</a>'
      )
  );
}

function normalizeHtmlForTelegram(text: string): string {
  const withPlainLists = text
    .replace(/<ul>\s*([\s\S]*?)\s*<\/ul>/gi, (_, items: string) =>
      extractHtmlListItems(items, "unordered")
    )
    .replace(/<ol>\s*([\s\S]*?)\s*<\/ol>/gi, (_, items: string) =>
      extractHtmlListItems(items, "ordered")
    );

  return withPlainLists
    .replace(/<strong>/gi, "<b>")
    .replace(/<\/strong>/gi, "</b>")
    .replace(/<em>/gi, "<i>")
    .replace(/<\/em>/gi, "</i>")
    .replace(/<ins>/gi, "<u>")
    .replace(/<\/ins>/gi, "</u>")
    .replace(/<(strike|del)>/gi, "<s>")
    .replace(/<\/(strike|del)>/gi, "</s>")
    .replace(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, '<a href="$2">$3</a>')
    .replace(/<(?!\/?(?:b|i|u|s|code|pre|a)\b)[^>]+>/gi, "");
}

function extractHtmlListItems(
  html: string,
  mode: "unordered" | "ordered"
): string {
  const matches = [...html.matchAll(/<li>\s*([\s\S]*?)\s*<\/li>/gi)];
  if (matches.length === 0) return html;

  return matches
    .map((match, index) => {
      const prefix = mode === "ordered" ? `${index + 1}. ` : "* ";
      return `${prefix}${match[1].replace(/<[^>]+>/g, "").trim()}`;
    })
    .join("\n");
}
