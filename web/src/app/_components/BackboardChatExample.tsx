"use client";

import { useState } from "react";
import { useBackboard } from "./useBackboard";

/**
 * Example component demonstrating Backboard.io integration
 * This shows how to use custom prompts and interact with the AI
 */
export function BackboardChatExample() {
  const [input, setInput] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const { messages, isLoading, error, sendMessage, sendMessageStreaming, reset } =
    useBackboard(customPrompt || undefined);

  const [streamingText, setStreamingText] = useState("");

  const handleSend = async () => {
    if (!input.trim()) return;
    setInput("");
    await sendMessage(input);
  };

  const handleSendStreaming = async () => {
    if (!input.trim()) return;
    setInput("");
    setStreamingText("");
    
    await sendMessageStreaming(input, {
      onChunk: (chunk) => {
        setStreamingText((prev) => prev + chunk);
      },
    });
    
    setStreamingText("");
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-stone-900">
          Backboard.io Chat
        </h2>

        {/* Custom System Prompt */}
        <div className="mb-4">
          <label className="mb-2 block text-sm font-medium text-stone-700">
            Custom System Prompt (optional)
          </label>
          <textarea
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            placeholder="Leave empty to use default transit planner prompt..."
            className="w-full rounded-md border border-stone-300 p-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            rows={3}
          />
        </div>

        {/* Messages */}
        <div className="mb-4 max-h-96 space-y-2 overflow-y-auto rounded-md border border-stone-200 bg-stone-50 p-4">
          {messages.length === 0 ? (
            <p className="text-center text-sm text-stone-500">
              No messages yet. Start a conversation!
            </p>
          ) : (
            messages.map((msg, idx) => (
              <div
                key={idx}
                className={`rounded-lg p-3 ${
                  msg.role === "user"
                    ? "ml-8 bg-blue-100 text-blue-900"
                    : "mr-8 bg-white text-stone-900"
                }`}
              >
                <div className="mb-1 text-xs font-semibold text-stone-500">
                  {msg.role}
                </div>
                <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
              </div>
            ))
          )}
          {streamingText && (
            <div className="mr-8 rounded-lg bg-white p-3 text-stone-900">
              <div className="mb-1 text-xs font-semibold text-stone-500">
                assistant (streaming...)
              </div>
              <div className="whitespace-pre-wrap text-sm">{streamingText}</div>
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            Error: {error}
          </div>
        )}

        {/* Input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Type your message..."
            disabled={isLoading}
            className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-stone-100"
          />
          <button
            onClick={() => void handleSend()}
            disabled={isLoading || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-stone-300"
          >
            {isLoading ? "Sending..." : "Send"}
          </button>
          <button
            onClick={() => void handleSendStreaming()}
            disabled={isLoading || !input.trim()}
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:bg-stone-300"
          >
            Stream
          </button>
          <button
            onClick={reset}
            className="rounded-md bg-stone-600 px-4 py-2 text-sm font-medium text-white hover:bg-stone-700"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Usage Instructions */}
      <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-700">
        <h3 className="mb-2 font-semibold">Usage:</h3>
        <ul className="space-y-1 list-disc pl-5">
          <li>Enter a custom system prompt to change the AI's behavior</li>
          <li>Click "Send" for a complete response</li>
          <li>Click "Stream" to see the response in real-time</li>
          <li>Click "Reset" to start a new conversation</li>
        </ul>
      </div>
    </div>
  );
}
