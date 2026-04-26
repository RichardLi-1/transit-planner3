import "server-only";

import { GoogleGenerativeAI, FunctionCallingMode } from "@google/generative-ai";
import type { AIProvider, ChatMessage, ToolDefinition, ToolStreamChunk } from "./ai-provider";

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

    // 📖 Learn: Gemini calls this "function calling" rather than "tool use", but
    // the idea is identical. Key differences from Anthropic:
    //   1. Functions are declared inside a `tools` array as `functionDeclarations`
    //   2. `toolConfig.functionCallingConfig.mode = "ANY"` forces a function call
    //   3. The function arguments don't stream — they're in result.response after the
    //      stream completes. Text tokens stream normally; we get the call at the end.
    async *streamMessageWithTool(threadId, content, tool: ToolDefinition, model = "claude-haiku-4-5-20251001", maxTokens = 900): AsyncGenerator<ToolStreamChunk> {
      const thread    = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
        // 📖 Learn: tools are declared as functionDeclarations inside the tools array.
        // The parameters field accepts the same JSON Schema format Anthropic uses.
        tools: [{ functionDeclarations: [{
          name: tool.name,
          description: tool.description,
          // 📖 Learn: Gemini's SDK has a strict FunctionDeclarationSchema type, but our
          // inputSchema is already the right JSON Schema shape — we cast through unknown
          // to satisfy TypeScript without rewriting the schema in Gemini's enum format.
          parameters: tool.inputSchema as unknown as Parameters<typeof Object>[0],
        }]}],
        // FunctionCallingMode.ANY = model must call a function (same as Anthropic's tool_choice: "tool")
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
      });

      const chat = geminiModel.startChat({ history: toGeminiHistory(thread.messages) });
      const result = await chat.sendMessageStream(content);

      let fullText = "";
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          fullText += text;
          yield { type: "text", text };
        }
      }

      // 📖 Learn: result.response is a Promise that resolves once the stream is fully
      // consumed. It holds the complete response including any function calls that the
      // model made. Unlike Anthropic, the args arrive all at once, not streamed.
      const response = await result.response;
      const calls = response.functionCalls();
      const call = calls?.find((fc) => fc.name === tool.name);

      if (fullText) {
        threadStore.set(threadId, {
          ...thread,
          messages: [...thread.messages, { role: "user", content }, { role: "assistant", content: fullText }],
        });
      }

      if (call?.args) {
        yield { type: "tool", input: call.args as Record<string, unknown> };
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
