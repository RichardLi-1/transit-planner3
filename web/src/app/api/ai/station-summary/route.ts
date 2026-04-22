import { NextRequest, NextResponse } from "next/server";
import {
  createAssistant,
  createThread,
  sendMessage,
} from "~/server/anthropic";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      stationName: string;
      routeName: string;
      ridership?: number;
      populationServed?: number;
      connections?: string[];
      allStations?: Array<{ name: string; ridership?: number }>;
    };

    const {
      stationName,
      routeName,
      ridership,
      populationServed,
      connections = [],
      allStations = [],
    } = body;

    if (!stationName || !routeName) {
      return NextResponse.json(
        { error: "stationName and routeName are required" },
        { status: 400 },
      );
    }

    const prompt = buildStationAnalysisPrompt(
      stationName,
      routeName,
      ridership,
      populationServed,
      connections,
      allStations,
    );

    const systemPrompt = `You are a Toronto Transit Commission (TTC) station analyst.
Your role is to provide concise, data-driven insights about transit stations.

Guidelines:
- Keep responses to 2-3 sentences maximum
- Focus on ridership levels, crowding, and operational status
- Compare to other stations when data is available
- Use terms like "high-traffic", "moderate", "low-traffic", "crowded", "overloaded", "underutilized"
- Be specific with numbers when provided
- Mention notable connections to other lines`;

    const assistantId = await createAssistant(
      "TTC Station Analyst",
      systemPrompt,
    );
    const threadId = await createThread(assistantId);
    const response = await sendMessage(
      threadId,
      prompt,
      "claude-haiku-4-5-20251001",
      200,
    );

    return NextResponse.json({
      summary: response,
      stationName,
      routeName,
    });
  } catch (error) {
    console.error("Station summary API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to generate summary",
      },
      { status: 500 },
    );
  }
}

function buildStationAnalysisPrompt(
  stationName: string,
  routeName: string,
  ridership?: number,
  populationServed?: number,
  connections: string[] = [],
  allStations: Array<{ name: string; ridership?: number }> = [],
): string {
  const lines: string[] = [`Analyze ${stationName} station on ${routeName}.`];

  if (populationServed !== undefined) {
    lines.push(
      `Population served (nearest-station Voronoi assignment, 5km cutoff): ${populationServed.toLocaleString()} people.`,
    );
  }

  if (ridership !== undefined) {
    lines.push(`Estimated daily ridership: ${ridership.toLocaleString()} passengers.`);

    if (allStations.length > 0) {
      const stationsWithRidership = allStations.filter((s) => s.ridership !== undefined);
      if (stationsWithRidership.length > 1) {
        const allRidershipValues = stationsWithRidership.map((s) => s.ridership!);
        const avgRidership =
          allRidershipValues.reduce((a, b) => a + b, 0) / allRidershipValues.length;
        const maxRidership = Math.max(...allRidershipValues);
        const minRidership = Math.min(...allRidershipValues);

        lines.push(`Network average: ${Math.round(avgRidership).toLocaleString()} passengers.`);
        lines.push(`Network range: ${minRidership.toLocaleString()} to ${maxRidership.toLocaleString()}.`);

        const sorted = [...allRidershipValues].sort((a, b) => a - b);
        const position = sorted.indexOf(ridership);
        const percentile = Math.round((position / sorted.length) * 100);
        lines.push(`This station ranks at ${percentile}th percentile.`);
      }
    }
  }

  if (connections.length > 0) {
    lines.push(`Connections: ${connections.join(", ")}.`);
  }

  lines.push(
    "\nProvide a brief 2-3 sentence analysis: Is this station crowded, overloaded, or underutilized based on the population it serves? How does the ridership compare to nearby population density?",
  );

  return lines.join(" ");
}
