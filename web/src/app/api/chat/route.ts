import { type NextRequest } from "next/server";

const PYTHON_URL = process.env.PYTHON_SERVER_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  const body = await req.json() as unknown;

  const upstream = await fetch(`${PYTHON_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  // Proxy the SSE stream directly to the browser
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
