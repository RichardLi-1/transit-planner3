import { AnthropicChatExample } from "~/app/_components/AnthropicChatExample";

export default function AnthropicTestPage() {
  return (
    <div className="min-h-screen bg-stone-100 py-8">
      <div className="mx-auto max-w-4xl px-4">
        <h1 className="mb-6 text-3xl font-bold text-stone-900">
          Anthropic Integration Test
        </h1>
        <AnthropicChatExample />
      </div>
    </div>
  );
}
