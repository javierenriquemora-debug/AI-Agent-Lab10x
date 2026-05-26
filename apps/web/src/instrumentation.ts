/**
 * Arranca OpenTelemetry con Langfuse para que el CallbackHandler de LangChain
 * (@langfuse/langchain) exporte trazas al servidor Langfuse.
 * Ver: https://langfuse.com/integrations/frameworks/langchain (pestaña JS/TS).
 *
 * El exportador usa OTLP HTTP contra `{LANGFUSE_BASE_URL}/api/public/otel/v1/traces`.
 * Requiere una versión de Langfuse que exponga ese endpoint (si ves 404 al exportar, actualiza la imagen OSS).
 */
export async function register() {
  // Solo omitir Edge: en algunos entornos `NEXT_RUNTIME` no es exactamente "nodejs" y el SDK no arrancaba.
  if (process.env.NEXT_RUNTIME === "edge") return;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = process.env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return;

  const baseUrl =
    process.env.LANGFUSE_BASE_URL?.trim() ||
    process.env.LANGFUSE_BASEURL?.trim() ||
    undefined;

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { LangfuseSpanProcessor } = await import("@langfuse/otel");

  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor(
        baseUrl
          ? { publicKey, secretKey, baseUrl }
          : { publicKey, secretKey }
      ),
    ],
  });

  sdk.start();

  if (process.env.NODE_ENV === "development") {
    // Sin secretos: solo confirma que el hook corrió.
    console.info(
      "[langfuse] OTEL iniciado; ingestión OTLP →",
      `${baseUrl ?? "(LANGFUSE_BASE_URL por defecto)"}/api/public/otel/v1/traces`
    );
  }
}
