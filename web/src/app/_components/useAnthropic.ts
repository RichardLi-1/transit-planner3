"use client";

import { useState, useCallback } from "react";
import { trackEvent } from "~/lib/analytics";

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AnthropicState = {
  assistantId: string | null;
  threadId: string | null;
  messages: AnthropicMessage[];
  isLoading: boolean;
  error: string | null;
};

export function useAnthropic(customSystemPrompt?: string) {
  const [state, setState] = useState<AnthropicState>({
    assistantId: null,
    threadId: null,
    messages: [],
    isLoading: false,
    error: null,
  });

  const sendMessageStreaming = useCallback(
    async (
      message: string,
      options?: {
        model?: string;
        maxTokens?: number;
        onChunk?: (chunk: string) => void;
      },
    ) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        messages: [...prev.messages, { role: "user", content: message }],
      }));

      try {
        trackEvent("AI Message Sent", {
          message_length: message.length,
          has_custom_system_prompt: Boolean(customSystemPrompt),
          max_tokens: options?.maxTokens,
          model: options?.model,
          streaming: true,
          provider: "anthropic",
        });

        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            assistantId: state.assistantId,
            threadId: state.threadId,
            systemPrompt: customSystemPrompt,
            model: options?.model,
            maxTokens: options?.maxTokens,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let assistantMessage = "";
        let newAssistantId = state.assistantId;
        let newThreadId = state.threadId;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data) as
                | { type: "metadata"; assistantId: string; threadId: string }
                | { type: "content"; text: string }
                | { type: "error"; error: string };

              if (parsed.type === "metadata") {
                newAssistantId = parsed.assistantId;
                newThreadId = parsed.threadId;
              } else if (parsed.type === "content") {
                assistantMessage += parsed.text;
                options?.onChunk?.(parsed.text);
              } else if (parsed.type === "error") {
                throw new Error(parsed.error);
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }

        setState((prev) => ({
          ...prev,
          assistantId: newAssistantId,
          threadId: newThreadId,
          messages: [
            ...prev.messages,
            { role: "assistant", content: assistantMessage },
          ],
          isLoading: false,
        }));

        trackEvent("AI Response Received", {
          message_length: message.length,
          response_length: assistantMessage.length,
          streaming: true,
          provider: "anthropic",
        });

        return assistantMessage;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        trackEvent("AI Response Failed", {
          message_length: message.length,
          error: errorMessage,
          streaming: true,
          provider: "anthropic",
        });
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
        throw error;
      }
    },
    [state.assistantId, state.threadId, customSystemPrompt],
  );

  const sendMessage = useCallback(
    async (
      message: string,
      options?: {
        model?: string;
        maxTokens?: number;
      },
    ) => {
      setState((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
        messages: [...prev.messages, { role: "user", content: message }],
      }));

      try {
        trackEvent("AI Message Sent", {
          message_length: message.length,
          has_custom_system_prompt: Boolean(customSystemPrompt),
          max_tokens: options?.maxTokens,
          model: options?.model,
          streaming: false,
          provider: "anthropic",
        });

        const response = await fetch("/api/ai/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            assistantId: state.assistantId,
            threadId: state.threadId,
            systemPrompt: customSystemPrompt,
            model: options?.model,
            maxTokens: options?.maxTokens,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = (await response.json()) as {
          response: string;
          assistantId: string;
          threadId: string;
        };

        setState((prev) => ({
          ...prev,
          assistantId: data.assistantId,
          threadId: data.threadId,
          messages: [
            ...prev.messages,
            { role: "assistant", content: data.response },
          ],
          isLoading: false,
        }));

        trackEvent("AI Response Received", {
          message_length: message.length,
          response_length: data.response.length,
          streaming: false,
          provider: "anthropic",
        });

        return data.response;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        trackEvent("AI Response Failed", {
          message_length: message.length,
          error: errorMessage,
          streaming: false,
          provider: "anthropic",
        });
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
        throw error;
      }
    },
    [state.assistantId, state.threadId, customSystemPrompt],
  );

  const reset = useCallback(() => {
    setState({
      assistantId: null,
      threadId: null,
      messages: [],
      isLoading: false,
      error: null,
    });
  }, []);

  return {
    ...state,
    sendMessage,
    sendMessageStreaming,
    reset,
  };
}
