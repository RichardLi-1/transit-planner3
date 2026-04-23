import { NextRequest, NextResponse } from "next/server";
import { getProvider, DEFAULT_SYSTEM_PROMPT } from "~/server/ai-provider";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      name: string;
      systemPrompt?: string;
      provider?: string;
    };

    const { name, systemPrompt = DEFAULT_SYSTEM_PROMPT, provider } = body;

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const assistantId = await getProvider(provider).createAssistant(name, systemPrompt);

    return NextResponse.json({ assistantId });
  } catch (error) {
    console.error("Anthropic API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to create assistant",
      },
      { status: 500 },
    );
  }
}
