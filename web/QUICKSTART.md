# Anthropic Integration Quickstart

## What Changed

The web app now talks directly to Anthropic instead of Backboard. The main reusable pieces are:

- `web/src/server/anthropic.ts`
- `web/src/app/api/ai/*`
- `web/src/app/_components/useAnthropic.ts`
- `web/src/app/_components/AnthropicChatExample.tsx`
- `web/src/app/anthropic-test/page.tsx`

## Local Test

1. Start the web app with `cd web && npm run dev`
2. Visit `http://localhost:3000/anthropic-test`
3. Or run `./test_ai.sh` from the `web/` directory

## Minimal Usage

```tsx
import { useAnthropic } from "~/app/_components/useAnthropic";

function MyComponent() {
  const { messages, sendMessage, isLoading } = useAnthropic(
    "You are a helpful transit planning assistant.",
  );

  const handleAsk = async () => {
    await sendMessage("Suggest a new subway line for Toronto");
  };

  return (
    <div>
      <button onClick={handleAsk} disabled={isLoading}>
        Ask AI
      </button>
      {messages.map((msg, i) => (
        <p key={i}>
          <strong>{msg.role}:</strong> {msg.content}
        </p>
      ))}
    </div>
  );
}
```

## Required Environment Variable

```bash
ANTHROPIC_API_KEY=your_key_here
```
