/**
 * Client-safe formatting utilities.
 * This file can be imported by both server and client components.
 */

/**
 * Converts Markdown formatting to HTML and turns bare URLs into clickable links.
 * Used in the web chat interface and applied to Telegram outgoing messages.
 */
export function formatMessageToHtml(text: string): string {
  return (
    text
      // Bold
      .replace(/\*\*(.+?)\*\*/gs, "<b>$1</b>")
      .replace(/__(.+?)__/gs, "<b>$1</b>")
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
