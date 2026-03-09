import { NextResponse } from "next/server";

export const revalidate = 3600;
import { fetchTrafficData } from "~/server/traffic";

export async function GET() {
  try {
    const data = await fetchTrafficData();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Traffic API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch traffic data" },
      { status: 500 },
    );
  }
}
