import "server-only";

import Anthropic from "@anthropic-ai/sdk";

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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const assistantStore = new Map<string, StoredAssistant>();
const threadStore = new Map<string, StoredThread>();

function requireAnthropicKey() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }
}

function getAssistant(assistantId: string): StoredAssistant {
  const assistant = assistantStore.get(assistantId);
  if (!assistant) throw new Error(`Unknown assistant: ${assistantId}`);
  return assistant;
}

function getThread(threadId: string): StoredThread {
  const thread = threadStore.get(threadId);
  if (!thread) throw new Error(`Unknown thread: ${threadId}`);
  return thread;
}

function extractText(
  content: Anthropic.Messages.Message["content"],
): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function createAssistant(
  name: string,
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT,
): Promise<string> {
  requireAnthropicKey();

  const assistantId = crypto.randomUUID();
  assistantStore.set(assistantId, { name, systemPrompt });
  return assistantId;
}

export async function createThread(assistantId: string): Promise<string> {
  requireAnthropicKey();
  getAssistant(assistantId);

  const threadId = crypto.randomUUID();
  threadStore.set(threadId, { assistantId, messages: [] });
  return threadId;
}

export async function* streamMessage(
  threadId: string,
  content: string,
  model: string = "claude-haiku-4-5-20251001",
  maxTokens: number = 600,
): AsyncGenerator<string, void, unknown> {
  requireAnthropicKey();

  const thread = getThread(threadId);
  const assistant = getAssistant(thread.assistantId);
  const nextMessages: StoredMessage[] = [
    ...thread.messages,
    { role: "user", content },
  ];

  const stream = anthropic.messages.stream({
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
}

export async function sendMessage(
  threadId: string,
  content: string,
  model: string = "claude-haiku-4-5-20251001",
  maxTokens: number = 600,
): Promise<string> {
  requireAnthropicKey();

  const thread = getThread(threadId);
  const assistant = getAssistant(thread.assistantId);
  const nextMessages: StoredMessage[] = [
    ...thread.messages,
    { role: "user", content },
  ];

  const response = await anthropic.messages.create({
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
}
