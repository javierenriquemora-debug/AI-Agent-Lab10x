import { CallbackHandler } from "@langfuse/langchain";
import { getLangfuseTracerProvider } from "@langfuse/tracing";

/**
 * Langfuse reads LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, and LANGFUSE_BASE_URL from the environment.
 * Returns null when keys are missing so the agent runs without tracing.
 *
 * En despliegues serverless, LangChain puede ejecutar callbacks en segundo plano; si los traces quedan incompletos,
 * define `LANGCHAIN_CALLBACKS_BACKGROUND=false` (ver documentación de LangChain / Langfuse).
 */
export function createLangfuseCallbackHandler(input: {
  userId: string;
  sessionId: string;
}): CallbackHandler | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return null;

  return new CallbackHandler({
    userId: input.userId,
    sessionId: input.sessionId,
    tags: ["agent-graph"],
  });
}

/** Best-effort flush so spans export before the Next.js request finishes (short-lived workers). */
export async function flushLangfuseTracing(): Promise<void> {
  try {
    const provider = getLangfuseTracerProvider() as unknown as {
      forceFlush?: () => Promise<void>;
    };
    await provider.forceFlush?.();
  } catch {
    // ignore
  }
}
