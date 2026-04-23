import "server-only";

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AIProvider, ChatMessage } from "./ai-provider";

// 📖 Learn: Gemini and Anthropic both take "system prompt + message history",
// but the SDKs look different in three ways:
//   1. System prompt → passed as `systemInstruction` on the model, not in the message list
//   2. History roles → "model" instead of "assistant"
//   3. Message format → { role, parts: [{ text }] } instead of { role, content }

// Maps Claude model names to Gemini equivalents so council.ts needs no changes.
// 📖 Learn: this keeps the mapping in one place — if Gemini releases a better
// model, you only edit this function.
function mapModel(claudeOrGeminiModel: string): string {
  if (claudeOrGeminiModel.includes("haiku")) return "gemini-1.5-flash";
  if (claudeOrGeminiModel.includes("sonnet") || claudeOrGeminiModel.includes("opus")) return "gemini-1.5-pro";
  // If the caller already passes a Gemini model name, use it directly.
  if (claudeOrGeminiModel.startsWith("gemini-")) return claudeOrGeminiModel;
  return "gemini-1.5-flash";
}

type StoredAssistant = { name: string; systemPrompt: string };
type StoredMessage  = { role: "user" | "assistant"; content: string };
type StoredThread   = { assistantId: string; messages: StoredMessage[] };

export function createGeminiProvider(): AIProvider {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const assistantStore = new Map<string, StoredAssistant>();
  const threadStore    = new Map<string, StoredThread>();

  function getAssistant(id: string): StoredAssistant {
    const a = assistantStore.get(id);
    if (!a) throw new Error(`Unknown assistant: ${id}`);
    return a;
  }

  function getThread(id: string): StoredThread {
    const t = threadStore.get(id);
    if (!t) throw new Error(`Unknown thread: ${id}`);
    return t;
  }

  // Converts our internal message format to what Gemini's chat history expects.
  // 📖 Learn: Gemini calls the assistant role "model", not "assistant".
  function toGeminiHistory(messages: StoredMessage[]) {
    return messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  }

  return {
    async createAssistant(name, systemPrompt) {
      const assistantId = crypto.randomUUID();
      assistantStore.set(assistantId, {
        name,
        systemPrompt: systemPrompt ?? "",
      });
      return assistantId;
    },

    async createThread(assistantId) {
      getAssistant(assistantId);
      const threadId = crypto.randomUUID();
      threadStore.set(threadId, { assistantId, messages: [] });
      return threadId;
    },

    async *streamMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread    = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      // 📖 Learn: unlike Anthropic, Gemini wants the system prompt on the model
      // object, not mixed into the message list. Then we give it prior messages
      // as "history" and the new message via sendMessageStream().
      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
      });

      const chat = geminiModel.startChat({
        history: toGeminiHistory(thread.messages),
      });

      const result = await chat.sendMessageStream(content);

      let full = "";
      try {
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) {
            full += text;
            yield text;
          }
        }
      } finally {
        if (full) {
          const nextMessages: StoredMessage[] = [
            ...thread.messages,
            { role: "user",      content },
            { role: "assistant", content: full },
          ];
          threadStore.set(threadId, { ...thread, messages: nextMessages });
        }
      }
    },

    async sendMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread    = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
      });

      const chat   = geminiModel.startChat({ history: toGeminiHistory(thread.messages) });
      const result = await chat.sendMessage(content);
      const text   = result.response.text();

      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user",      content },
        { role: "assistant", content: text },
      ];
      threadStore.set(threadId, { ...thread, messages: nextMessages });
      return text;
    },

    async *streamDirect(system, messages: ChatMessage[], model = "claude-haiku-4-5-20251001", maxTokens = 1024) {
      // Split the message list: everything before the last message is history,
      // the last message is the new user turn to send.
      const history = messages.slice(0, -1);
      const last    = messages[messages.length - 1];
      if (!last) return;

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: system,
        generationConfig: { maxOutputTokens: maxTokens },
      });

      const chat = geminiModel.startChat({
        history: history.map((m) => ({
          role:  m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      });

      const result = await chat.sendMessageStream(last.content);
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
      }
    },
  };
}
