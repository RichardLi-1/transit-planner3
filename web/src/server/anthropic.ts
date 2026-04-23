import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, ChatMessage } from "./ai-provider";

export const DEFAULT_SYSTEM_PROMPT = `You are a transit route planning assistant for Toronto.

You help urban planners design new transit lines. When the user describes a route requirement,
respond conversationally and helpfully. If they ask you to generate a specific route, also output
a JSON block at the end of your message in this exact format:

\`\`\`route
{
  "name": "Route Name",
  "type": "subway" | "streetcar" | "bus",
  "color": "#hexcolor",
  "stops": [
    { "name": "Stop Name", "coords": [-79.3832, 43.6532] }
  ]
}
\`\`\`

Coordinates are [longitude, latitude] in WGS84. Only include the JSON block when generating
an actual route. Use realistic Toronto coordinates. Keep stop names concise.`;

type StoredAssistant = {
  name: string;
  systemPrompt: string;
};

type StoredMessage = {
  role: "user" | "assistant";
  content: string;
};

type StoredThread = {
  assistantId: string;
  messages: StoredMessage[];
};

// 📖 Learn: a "factory function" creates and returns an object. The Maps
// (assistantStore, threadStore) are closed over — each call to
// createAnthropicProvider() gets its own private store.
export function createAnthropicProvider(): AIProvider {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const assistantStore = new Map<string, StoredAssistant>();
  const threadStore = new Map<string, StoredThread>();

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

  function extractText(content: Anthropic.Messages.Message["content"]): string {
    return content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  return {
    async createAssistant(name, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
      const assistantId = crypto.randomUUID();
      assistantStore.set(assistantId, { name, systemPrompt });
      return assistantId;
    },

    async createThread(assistantId) {
      getAssistant(assistantId);
      const threadId = crypto.randomUUID();
      threadStore.set(threadId, { assistantId, messages: [] });
      return threadId;
    },

    async *streamMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user", content },
      ];

      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: assistant.systemPrompt,
        messages: nextMessages,
      });

      let full = "";
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            full += event.delta.text;
            yield event.delta.text;
          }
        }
      } finally {
        if (full) {
          threadStore.set(threadId, {
            ...thread,
            messages: [...nextMessages, { role: "assistant", content: full }],
          });
        }
      }
    },

    async sendMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user", content },
      ];

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: assistant.systemPrompt,
        messages: nextMessages,
      });

      const text = extractText(response.content);
      threadStore.set(threadId, {
        ...thread,
        messages: [...nextMessages, { role: "assistant", content: text }],
      });
      return text;
    },

    async *streamDirect(system, messages: ChatMessage[], model = "claude-haiku-4-5-20251001", maxTokens = 1024) {
      // 📖 Learn: we pass the full message list directly (no assistant/thread lookup)
      // so the caller controls history. Anthropic accepts this format natively.
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    },
  };
}
