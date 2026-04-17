// 📖 Learn: Next.js App Router API routes — a file named route.ts in app/api/...
// automatically becomes a server-side HTTP endpoint. The exported POST function
// handles POST requests to /api/docs-chat.

import Anthropic from "@anthropic-ai/sdk";
import { buildDocsCorpus } from "~/lib/docs-content";

// The Anthropic client reads ANTHROPIC_API_KEY from the environment automatically.
// 📖 Learn: never instantiate this on the client-side (browser) — the key would be exposed.
// This file only runs on the server because it's in /api/.
const anthropic = new Anthropic();

export type ChatMessage = { role: "user" | "assistant"; content: string };

export async function POST(req: Request) {
  const { question, history = [] } = (await req.json()) as {
    question: string;
    history: ChatMessage[];
  };

  if (!question?.trim()) {
    return Response.json({ error: "question is required" }, { status: 400 });
  }

  // 📖 Learn: RAG — Augmentation step.
  // We inject the full docs corpus into the system prompt. Claude will answer
  // ONLY from this context, which prevents hallucination about our specific app.
  const systemPrompt = `You are a helpful assistant for the Transit Planner documentation.
Answer questions based ONLY on the documentation provided below.
Be concise and direct. Use markdown formatting where helpful (bold, bullet lists).
If something is not covered in the docs, say so clearly rather than guessing.

${buildDocsCorpus()}`;

  // 📖 Learn: Streaming with SSE (Server-Sent Events).
  // Instead of waiting for the full response, we send chunks as they arrive.
  // The client reads these using the EventSource API (or fetch with a ReadableStream reader).
  // This makes the UI feel fast — words appear as Claude generates them.
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // 📖 Learn: anthropic.messages.stream() returns an async iterable of events.
        // Each event has a .type — we only care about "content_block_delta" with "text_delta".
        const response = await anthropic.messages.stream({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [
            // Include prior conversation turns so the bot has memory within a session.
            ...history,
            { role: "user", content: question },
          ],
        });

        for await (const event of response) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            // Each SSE message is: "data: <json>\n\n"
            const payload = JSON.stringify({ text: event.delta.text });
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
