import { ChatOpenAI } from "@langchain/openai";

type LlmProvider = "openrouter" | "gemini";

function normalizeProvider(value?: string | null): LlmProvider {
  const provider = (value ?? "openrouter").toLowerCase();
  return provider === "gemini" ? "gemini" : "openrouter";
}

function getProvider(): LlmProvider {
  return normalizeProvider(process.env.LLM_PROVIDER);
}

function createGeminiModel(modelName: string, temperature: number) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      // Gemini exposes an OpenAI-compatible endpoint, which lets us keep
      // the same LangChain model interface and tool-calling flow.
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    apiKey,
  });
}

function createOpenRouterModel(modelName: string, temperature: number) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agents.local",
      },
    },
    apiKey,
  });
}

export function createChatModel() {
  const provider = getProvider();
  if (provider === "gemini") {
    return createGeminiModel(process.env.GEMINI_MODEL ?? "gemini-2.5-flash", 0.3);
  }

  return createOpenRouterModel(
    process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    0.3
  );
}

export function createCompactionModel() {
  const provider = normalizeProvider(
    process.env.COMPACTION_LLM_PROVIDER ?? process.env.LLM_PROVIDER
  );

  try {
    if (provider === "gemini") {
      return createGeminiModel(
        process.env.GEMINI_COMPACTION_MODEL ??
          process.env.GEMINI_MODEL ??
          "gemini-2.5-flash",
        0.1
      );
    }

    return createOpenRouterModel(
      process.env.OPENROUTER_COMPACTION_MODEL ??
        process.env.OPENROUTER_MODEL ??
        "openai/gpt-4o-mini",
      0.1
    );
  } catch {
    return createChatModel();
  }
}
