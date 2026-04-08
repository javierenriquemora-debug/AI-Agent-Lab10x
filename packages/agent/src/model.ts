import { ChatOpenAI } from "@langchain/openai";

type LlmProvider = "openrouter" | "gemini";

function getProvider(): LlmProvider {
  const provider = (process.env.LLM_PROVIDER ?? "openrouter").toLowerCase();
  return provider === "gemini" ? "gemini" : "openrouter";
}

export function createChatModel() {
  const provider = getProvider();

  if (provider === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

    return new ChatOpenAI({
      modelName: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      temperature: 0.3,
      configuration: {
        // Gemini exposes an OpenAI-compatible endpoint, which lets us keep
        // the same LangChain model interface and tool-calling flow.
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      },
      apiKey,
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    temperature: 0.3,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://agents.local",
      },
    },
    apiKey,
  });
}
