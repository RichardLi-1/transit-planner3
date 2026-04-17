"use client";
// 📖 Learn: "use client" means this component runs in the browser (not server-side).
// We need this because we use useState, useRef, and browser APIs (fetch, ReadableStream).

import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "~/app/api/docs-chat/route";

type Message = ChatMessage & { streaming?: boolean };

export function DocsChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to the bottom whenever messages update.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Focus input when the panel opens.
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  async function sendMessage() {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setLoading(true);

    // Append the user's message to the conversation.
    const userMsg: Message = { role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);

    // Add an empty assistant message that we'll fill in via streaming.
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", streaming: true },
    ]);

    try {
      // 📖 Learn: fetch() with streaming.
      // We read the SSE response body as a stream instead of waiting for the whole response.
      // reader.read() returns chunks of bytes; we decode them into text.
      const res = await fetch("/api/docs-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          // Pass history (exclude the streaming placeholder we just added).
          history: messages.map(({ role, content }) => ({ role, content })),
        }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE messages are separated by "\n\n". Parse each complete message.
        // 📖 Learn: SSE (Server-Sent Events) format: "data: <payload>\n\n"
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? ""; // keep any incomplete last chunk

        for (const part of parts) {
          const line = part.replace(/^data: /, "").trim();
          if (line === "[DONE]") break;
          if (!line) continue;

          try {
            const parsed = JSON.parse(line) as { text?: string; error?: string };
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) {
              // Append the new text chunk to the last (streaming) message.
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                  updated[updated.length - 1] = {
                    ...last,
                    content: last.content + parsed.text,
                  };
                }
                return updated;
              });
            }
          } catch {
            // Ignore malformed chunks.
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = {
            ...last,
            content: "Sorry, something went wrong. Please try again.",
            streaming: false,
          };
        }
        return updated;
      });
    } finally {
      // Mark streaming as finished.
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          updated[updated.length - 1] = { ...last, streaming: false };
        }
        return updated;
      });
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Send on Enter (without Shift).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  // Simple markdown-to-HTML: bold (**text**) and inline code (`code`).
  // 📖 Learn: For production you'd use a library like react-markdown.
  // We keep it simple here to avoid adding a dependency.
  function renderContent(text: string) {
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return (
          <code
            key={i}
            style={{
              fontSize: 12, fontFamily: "ui-monospace, monospace",
              backgroundColor: "#f5f5f4", padding: "1px 5px",
              borderRadius: 4, border: "1px solid #e7e5e4",
            }}
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      // Render newlines as line breaks.
      return part.split("\n").map((line, j, arr) => (
        <span key={`${i}-${j}`}>
          {line}
          {j < arr.length - 1 && <br />}
        </span>
      ));
    });
  }

  const SUGGESTED = [
    "How do I add stops to a line?",
    "What is the AI Planning Council?",
    "How do I export GTFS?",
  ];

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Ask a question about the docs"
        style={{
          position: "fixed", bottom: 28, right: 28, zIndex: 1000,
          width: 52, height: 52, borderRadius: "50%",
          backgroundColor: "#2563eb",
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 4px 16px rgba(37,99,235,0.35)",
          transition: "transform 0.15s, box-shadow 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1.08)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.transform = "scale(1)";
        }}
      >
        {open ? (
          // X icon
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        ) : (
          // Chat bubble icon
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
              stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          style={{
            position: "fixed", bottom: 92, right: 28, zIndex: 999,
            width: 360, maxHeight: 520,
            backgroundColor: "#ffffff",
            borderRadius: 16,
            boxShadow: "0 8px 40px rgba(0,0,0,0.14)",
            border: "1px solid #e7e5e4",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: "14px 18px",
              borderBottom: "1px solid #e7e5e4",
              backgroundColor: "#fafaf9",
              display: "flex", alignItems: "center", gap: 10,
            }}
          >
            <div
              style={{
                width: 30, height: 30, borderRadius: "50%",
                backgroundColor: "#eff6ff",
                display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path
                  d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                  stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1c1917" }}>Docs Assistant</div>
              <div style={{ fontSize: 11.5, color: "#78716c" }}>Ask anything about Transit Planner</div>
            </div>
          </div>

          {/* Messages */}
          <div
            style={{
              flex: 1, overflowY: "auto",
              padding: "14px 16px",
              display: "flex", flexDirection: "column", gap: 12,
            }}
          >
            {messages.length === 0 && (
              <div>
                <p style={{ fontSize: 13, color: "#78716c", marginBottom: 12, lineHeight: 1.6 }}>
                  Hi! Ask me anything about the docs — how to use the map, how the AI council works, or technical details.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {SUGGESTED.map((q) => (
                    <button
                      key={q}
                      onClick={() => { setInput(q); inputRef.current?.focus(); }}
                      style={{
                        textAlign: "left", padding: "8px 12px",
                        borderRadius: 8, border: "1px solid #e7e5e4",
                        backgroundColor: "#fafaf9", cursor: "pointer",
                        fontSize: 12.5, color: "#57534e",
                        transition: "background 0.1s",
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "85%",
                    padding: "9px 13px",
                    borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                    backgroundColor: msg.role === "user" ? "#2563eb" : "#f5f5f4",
                    color: msg.role === "user" ? "#ffffff" : "#1c1917",
                    fontSize: 13.5,
                    lineHeight: 1.65,
                  }}
                >
                  {msg.content ? renderContent(msg.content) : (
                    // Typing indicator while streaming an empty message.
                    <span style={{ opacity: 0.5 }}>...</span>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div
            style={{
              padding: "10px 12px",
              borderTop: "1px solid #e7e5e4",
              display: "flex", gap: 8, alignItems: "flex-end",
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question…"
              rows={1}
              disabled={loading}
              style={{
                flex: 1, resize: "none", border: "1px solid #e7e5e4",
                borderRadius: 10, padding: "8px 12px",
                fontSize: 13.5, color: "#1c1917", outline: "none",
                fontFamily: "inherit", lineHeight: 1.5,
                backgroundColor: loading ? "#fafaf9" : "#ffffff",
                transition: "border-color 0.15s",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "#2563eb"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; }}
            />
            <button
              onClick={() => void sendMessage()}
              disabled={loading || !input.trim()}
              style={{
                width: 34, height: 34, borderRadius: "50%",
                backgroundColor: loading || !input.trim() ? "#e7e5e4" : "#2563eb",
                border: "none", cursor: loading || !input.trim() ? "default" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0, transition: "background 0.15s",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
