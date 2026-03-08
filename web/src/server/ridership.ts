import "server-only";

/**
 * Fetch ridership (boardings) data for a specific station from the Python backend.
 * The Python server has access to the stop_demand_summary table with boardings data.
 * 
 * @param stationName - Name of the station to get ridership for
 * @returns Daily ridership number, or null if not found
 */
export async function fetchStationRidership(
  stationName: string
): Promise<number | null> {
  try {
    // The Python server should be running on port 8000
    const pythonServerUrl = process.env.PYTHON_SERVER_URL ?? "http://localhost:8000";
    
    const response = await fetch(`${pythonServerUrl}/api/ridership/station`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        station_name: stationName,
      }),
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch ridership for ${stationName}: ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as {
      station_name: string;
      total_boardings: number;
    };

    return data.total_boardings;
  } catch (error) {
    console.error(`Error fetching ridership for ${stationName}:`, error);
    return null;
  }
}

/**
 * Fetch ridership data for all stations on a specific route/line.
 * 
 * @param lineName - Name of the line (e.g., "Line 1", "Line 2")
 * @returns Array of stations with their ridership data
 */
export async function fetchLineRidership(
  lineName: string
): Promise<Array<{ name: string; ridership: number }>> {
  try {
    const pythonServerUrl = process.env.PYTHON_SERVER_URL ?? "http://localhost:8000";
    
    const response = await fetch(`${pythonServerUrl}/api/ridership/line`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        line_name: lineName,
      }),
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch line ridership for ${lineName}: ${response.status} ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as {
      line_name: string;
      stations: Array<{ name: string; ridership: number }>;
    };

    return data.stations;
  } catch (error) {
    console.error(`Error fetching line ridership for ${lineName}:`, error);
    return [];
  }
}
