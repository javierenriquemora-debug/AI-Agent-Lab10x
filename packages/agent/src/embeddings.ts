type EmbeddingProvider = "openrouter" | "gemini";

function normalizeProvider(value?: string | null): EmbeddingProvider {
  const provider = (value ?? "openrouter").toLowerCase();
  return provider === "gemini" ? "gemini" : "openrouter";
}

function getEmbeddingProvider(): EmbeddingProvider {
  return normalizeProvider(process.env.EMBEDDING_PROVIDER ?? process.env.COMPACTION_LLM_PROVIDER);
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const normalized = text.trim();
  if (!normalized) throw new Error("Cannot generate embedding for empty text.");

  const provider = getEmbeddingProvider();
  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    const model = process.env.GEMINI_EMBEDDING_MODEL ?? "text-embedding-004";
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: {
            parts: [{ text: normalized }],
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini embedding request failed (${response.status})`);
    }

    const payload = (await response.json()) as {
      embedding?: { values?: number[] };
    };
    const values = payload.embedding?.values;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error("Gemini embedding response did not include values.");
    }
    return values;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://agents.local",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
      input: normalized,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter embedding request failed (${response.status})`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("OpenRouter embedding response did not include an embedding.");
  }
  return embedding;
}
