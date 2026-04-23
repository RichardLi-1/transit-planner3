import "server-only";

// 📖 Learn: TypeScript interfaces define a "contract" — the shape any
// implementing object must have. This file is the only place in the codebase
// that knows both providers exist; all callers just use the interface.
// This is the Strategy design pattern: swap implementations without changing callers.

export type ChatMessage = { role: "user" | "assistant"; content: string };

export interface AIProvider {
  // Creates a named assistant with a system prompt. Returns an opaque ID.
  createAssistant(name: string, systemPrompt?: string): Promise<string>;

  // Creates a conversation thread tied to an assistant. Returns an opaque ID.
  createThread(assistantId: string): Promise<string>;

  // Streams a reply to `content` in the given thread. Yields text chunks.
  streamMessage(
    threadId: string,
    content: string,
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<string, void, unknown>;

  // Non-streaming version of streamMessage. Returns the full reply.
  sendMessage(
    threadId: string,
    content: string,
    model?: string,
    maxTokens?: number,
  ): Promise<string>;

  // Stateless call: pass a system prompt + full message history directly.
  // Used by docs-chat, which manages its own history client-side.
  streamDirect(
    system: string,
    messages: ChatMessage[],
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<string, void, unknown>;
}

export { DEFAULT_SYSTEM_PROMPT } from "./anthropic";

// 📖 Learn: we cache one provider instance per name rather than a single
// global, so "anthropic" and "gemini" can each keep their own in-memory
// assistant/thread stores alive for the lifetime of the server process.
const _providers = new Map<string, AIProvider>();

export function getProvider(name?: string): AIProvider {
  // Per-request name wins; fall back to the env-var default; then "anthropic".
  const key = name === "gemini" ? "gemini" : (process.env.AI_PROVIDER ?? "anthropic");

  const cached = _providers.get(key);
  if (cached) return cached;

  let provider: AIProvider;
  if (key === "gemini") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createGeminiProvider } = require("./gemini") as {
      createGeminiProvider: () => AIProvider;
    };
    provider = createGeminiProvider();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAnthropicProvider } = require("./anthropic") as {
      createAnthropicProvider: () => AIProvider;
    };
    provider = createAnthropicProvider();
  }

  _providers.set(key, provider);
  return provider;
}
