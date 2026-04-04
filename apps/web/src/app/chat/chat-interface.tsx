"use client";

import { useState, useRef, useEffect } from "react";
import { formatMessageToHtml } from "@/lib/format-message";

interface PendingConfirmation {
  toolCallId: string;
  toolName: string;
  message: string;
}

interface Message {
  role: string;
  content: string;
  created_at?: string;
  pendingConfirmation?: PendingConfirmation | null;
}

interface Props {
  agentName: string;
  initialMessages: Array<{
    role: string;
    content: string;
    created_at?: string;
    structured_payload?: Record<string, unknown> | null;
    tool_call_id?: string | null;
  }>;
  pendingToolCallIds: string[];
}

function getPendingConfirmation(
  structuredPayload: Record<string, unknown> | null | undefined,
  pendingToolCallIds: Set<string>
): PendingConfirmation | null {
  if (structuredPayload?.type !== "pending_confirmation") {
    return null;
  }

  const toolCallId =
    typeof structuredPayload.toolCallId === "string" ? structuredPayload.toolCallId : null;
  const message =
    typeof structuredPayload.message === "string" ? structuredPayload.message : null;

  if (!toolCallId || !message || !pendingToolCallIds.has(toolCallId)) {
    return null;
  }

  return {
    toolCallId,
    toolName: typeof structuredPayload.toolName === "string" ? structuredPayload.toolName : "",
    message,
  };
}

export function ChatInterface({ agentName, initialMessages, pendingToolCallIds }: Props) {
  const [messages, setMessages] = useState<Message[]>(() => {
    const pendingIds = new Set(pendingToolCallIds);
    return initialMessages.map((message) => ({
      role: message.role,
      content: message.content,
      created_at: message.created_at,
      pendingConfirmation: getPendingConfirmation(message.structured_payload, pendingIds),
    }));
  });
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmingToolCallId, setConfirmingToolCallId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });

      const data = await res.json();

      if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }

      if (data.pendingConfirmation) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: data.pendingConfirmation.message,
            pendingConfirmation: data.pendingConfirmation,
          },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al procesar tu mensaje. Intenta de nuevo." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function handleToolConfirmation(
    messageIndex: number,
    toolCallId: string,
    action: "approve" | "reject"
  ) {
    setConfirmingToolCallId(toolCallId);

    try {
      const response = await fetch(`/api/tool-calls/${toolCallId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "No se pudo procesar la acción.");
      }

      setMessages((prev) => {
        const next = [...prev];
        next[messageIndex] = {
          ...next[messageIndex],
          pendingConfirmation: null,
        };
        return [...next, { role: "assistant", content: data.message }];
      });
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            error instanceof Error
              ? error.message
              : "No se pudo procesar la acción. Intenta de nuevo.",
        },
      ]);
    } finally {
      setConfirmingToolCallId(null);
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-neutral-400 py-20">
              <p className="text-lg font-medium text-neutral-600 dark:text-neutral-300">
                ¡Hola! Soy {agentName}
              </p>
              <p className="mt-1">Escribe un mensaje para comenzar.</p>
            </div>
          )}
          {messages.map((msg, i) => {
            const pendingConfirmation = msg.pendingConfirmation;

            return (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                  }`}
                >
                  <p
                    className="whitespace-pre-wrap"
                    // Content is generated by our own LLM, not user input
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{
                      __html: msg.role === "assistant"
                        ? formatMessageToHtml(msg.content)
                        : msg.content,
                    }}
                  />
                  {pendingConfirmation && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() =>
                          handleToolConfirmation(i, pendingConfirmation.toolCallId, "approve")
                        }
                        disabled={confirmingToolCallId === pendingConfirmation.toolCallId}
                        className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        Aprobar
                      </button>
                      <button
                        onClick={() =>
                          handleToolConfirmation(i, pendingConfirmation.toolCallId, "reject")
                        }
                        disabled={confirmingToolCallId === pendingConfirmation.toolCallId}
                        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-700"
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm dark:bg-neutral-800">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-2xl gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu mensaje..."
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
