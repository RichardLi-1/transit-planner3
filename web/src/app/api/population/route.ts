import { NextResponse } from "next/server";

export const revalidate = 3600;
import { fetchPopulationData } from "~/server/population";

export async function GET() {
  try {
    const data = await fetchPopulationData();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Population API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch population data" },
      { status: 500 },
    );
  }
}
