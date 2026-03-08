export type Stop = { name: string; coords: [number, number] };

export type Route = {
  id: string;
  name: string;
  shortName: string;
  color: string;
  textColor: string;
  type: "subway" | "streetcar" | "bus";
  description: string;
  frequency: string;
  stops: Stop[];
  /** Full line geometry including intermediate curve waypoints [lng, lat]. When present, used for rendering instead of deriving coords from stops. */
  shape?: [number, number][];
};

export type RouteStats = {
  cost: string;
  timeline: string;
  costedTimeline: string;
  minutesSaved: number;
  dollarsSaved: string;
  percentageChance: number;
  prNightmareScore: number;
};

export type GeneratedRoute = Route & { stats: RouteStats };

export type NeighbourhoodData = {
  trafficLevel: "Low" | "Moderate" | "High" | "Very High";
  employmentDensity: "Low" | "Moderate" | "High" | "Very High";
  populationDensity: number; // people per km²
  connectivityScore: number; // 1–10
  transitLines: string[]; // route IDs
};

export const NEIGHBOURHOOD_DATA: Record<string, NeighbourhoodData> = {
  "harbourfront":           { trafficLevel: "High",      employmentDensity: "Moderate",  populationDensity: 8200,  connectivityScore: 6,  transitLines: ["line-1"] },
  "entertainment-district": { trafficLevel: "Very High", employmentDensity: "Very High", populationDensity: 5400,  connectivityScore: 9,  transitLines: ["line-1", "line-2"] },
  "downtown-core":          { trafficLevel: "Very High", employmentDensity: "Very High", populationDensity: 9800,  connectivityScore: 10, transitLines: ["line-1", "line-2"] },
  "distillery-corktown":    { trafficLevel: "Moderate",  employmentDensity: "Moderate",  populationDensity: 6100,  connectivityScore: 6,  transitLines: ["line-1"] },
  "parkdale":               { trafficLevel: "Moderate",  employmentDensity: "Low",       populationDensity: 7800,  connectivityScore: 5,  transitLines: ["line-2"] },
  "queen-west":             { trafficLevel: "High",      employmentDensity: "Moderate",  populationDensity: 8900,  connectivityScore: 7,  transitLines: ["line-2"] },
  "kensington-market":      { trafficLevel: "Moderate",  employmentDensity: "Moderate",  populationDensity: 10200, connectivityScore: 7,  transitLines: ["line-1"] },
  "church-wellesley":       { trafficLevel: "High",      employmentDensity: "Moderate",  populationDensity: 11400, connectivityScore: 8,  transitLines: ["line-1"] },
  "regent-park":            { trafficLevel: "Low",       employmentDensity: "Low",       populationDensity: 9300,  connectivityScore: 5,  transitLines: ["line-1"] },
  "leslieville":            { trafficLevel: "Low",       employmentDensity: "Low",       populationDensity: 6700,  connectivityScore: 4,  transitLines: [] },
  "annex":                  { trafficLevel: "Moderate",  employmentDensity: "Moderate",  populationDensity: 9100,  connectivityScore: 8,  transitLines: ["line-2"] },
  "rosedale":               { trafficLevel: "Low",       employmentDensity: "Moderate",  populationDensity: 4200,  connectivityScore: 7,  transitLines: ["line-1", "line-2"] },
  "riverdale-danforth":     { trafficLevel: "Moderate",  employmentDensity: "Low",       populationDensity: 7500,  connectivityScore: 6,  transitLines: ["line-2"] },
  "midtown":                { trafficLevel: "Moderate",  employmentDensity: "High",      populationDensity: 8600,  connectivityScore: 8,  transitLines: ["line-1"] },
  "forest-hill":            { trafficLevel: "Low",       employmentDensity: "Low",       populationDensity: 3800,  connectivityScore: 4,  transitLines: [] },
  "north-york":             { trafficLevel: "Moderate",  employmentDensity: "High",      populationDensity: 5100,  connectivityScore: 7,  transitLines: ["line-1", "line-4"] },
};

// ─── TTC Subway Lines (verified against TTC GTFS data) ──────────────────────
// Coordinates averaged from northbound+southbound (or eastbound+westbound)
// platform pairs in subwaycoordinates.txt.
// `shape` adds intermediate waypoints where the track curves between stations.

export const ROUTES: Route[] = [
  {
    id: "line-1",
    name: "Line 1 – Yonge–University",
    shortName: "L1",
    color: "#FFCD00",
    textColor: "#1a1a1a",
    type: "subway",
    description: "U-shaped line running from Vaughan Metropolitan Centre south along the University/Spadina corridor to Union, then north along Yonge to Finch.",
    frequency: "Every 2–5 min",
    stops: [
      // University/Spadina branch: Vaughan MC → Union
      { name: "Vaughan MC",      coords: [-79.5279, 43.7940] },
      { name: "Highway 407",     coords: [-79.5235, 43.7834] },
      { name: "Pioneer Village", coords: [-79.5093, 43.7768] },
      { name: "York University", coords: [-79.4999, 43.7741] },
      { name: "Finch West",      coords: [-79.4911, 43.7649] },
      { name: "Downsview Park",  coords: [-79.4787, 43.7533] },
      { name: "Sheppard West",   coords: [-79.4624, 43.7497] },
      { name: "Wilson",          coords: [-79.4500, 43.7345] },
      { name: "Yorkdale",        coords: [-79.4475, 43.7246] },
      { name: "Lawrence West",   coords: [-79.4439, 43.7153] },
      { name: "Glencairn",       coords: [-79.4405, 43.7086] },
      { name: "Eglinton West",   coords: [-79.4365, 43.7000] },
      { name: "St Clair West",   coords: [-79.4156, 43.6845] },
      { name: "Dupont",          coords: [-79.4069, 43.6743] },
      { name: "Spadina",         coords: [-79.4050, 43.6697] },
      { name: "St George",       coords: [-79.3988, 43.6684] },
      { name: "Museum",          coords: [-79.3932, 43.6666] },
      { name: "Queen's Park",    coords: [-79.3905, 43.6599] },
      { name: "St Patrick",      coords: [-79.3882, 43.6547] },
      { name: "Osgoode",         coords: [-79.3867, 43.6511] },
      { name: "St Andrew",       coords: [-79.3848, 43.6477] },
      { name: "Union",           coords: [-79.3806, 43.6456] },
      // Yonge branch: Union → Finch (Union shared, not duplicated)
      { name: "King",            coords: [-79.3779, 43.6491] },
      { name: "Queen",           coords: [-79.3794, 43.6527] },
      { name: "Dundas",          coords: [-79.3810, 43.6566] },
      { name: "College",         coords: [-79.3829, 43.6608] },
      { name: "Wellesley",       coords: [-79.3836, 43.6656] },
      { name: "Bloor–Yonge",     coords: [-79.3856, 43.6706] },
      { name: "Rosedale",        coords: [-79.3883, 43.6766] },
      { name: "Summerhill",      coords: [-79.3910, 43.6827] },
      { name: "St Clair",        coords: [-79.3933, 43.6881] },
      { name: "Davisville",      coords: [-79.3971, 43.6977] },
      { name: "Eglinton",        coords: [-79.3986, 43.7056] },
      { name: "Lawrence",        coords: [-79.4024, 43.7259] },
      { name: "York Mills",      coords: [-79.4061, 43.7438] },
      { name: "Sheppard–Yonge",  coords: [-79.4108, 43.7610] },
      { name: "North York Ctr",  coords: [-79.4125, 43.7679] },
      { name: "Finch",           coords: [-79.4155, 43.7805] },
    ],
    shape: [
      // University/Spadina branch south to Union
      [-79.5279, 43.7940], // Vaughan MC
      [-79.5235, 43.7834], // Highway 407
      [-79.5093, 43.7768], // Pioneer Village
      [-79.4999, 43.7741], // York University
      [-79.4911, 43.7649], // Finch West
      [-79.4787, 43.7533], // Downsview Park
      [-79.4706, 43.7514], // curve — slight west before Sheppard West
      [-79.4624, 43.7497], // Sheppard West
      [-79.4500, 43.7345], // Wilson
      [-79.4475, 43.7246], // Yorkdale
      [-79.4439, 43.7153], // Lawrence West
      [-79.4405, 43.7086], // Glencairn
      [-79.4365, 43.7000], // Eglinton West
      [-79.4260, 43.6922], // curve — Allen corridor sweeps east
      [-79.4156, 43.6845], // St Clair West
      [-79.4069, 43.6743], // Dupont
      [-79.4050, 43.6697], // Spadina
      [-79.3988, 43.6684], // St George
      [-79.3932, 43.6666], // Museum
      [-79.3905, 43.6599], // Queen's Park
      [-79.3882, 43.6547], // St Patrick
      [-79.3867, 43.6511], // Osgoode
      [-79.3848, 43.6477], // St Andrew
      [-79.3806, 43.6456], // Union (shared bottom of U)
      // Yonge branch north from Union
      [-79.3786, 43.6474], // curve — jog east onto Yonge
      [-79.3779, 43.6491], // King
      [-79.3794, 43.6527], // Queen
      [-79.3810, 43.6566], // Dundas
      [-79.3829, 43.6608], // College
      [-79.3836, 43.6656], // Wellesley
      [-79.3856, 43.6706], // Bloor–Yonge
      [-79.3883, 43.6766], // Rosedale
      [-79.3910, 43.6827], // Summerhill
      [-79.3933, 43.6881], // St Clair
      [-79.3971, 43.6977], // Davisville
      [-79.3986, 43.7056], // Eglinton
      [-79.4024, 43.7259], // Lawrence
      [-79.4061, 43.7438], // York Mills
      [-79.4108, 43.7610], // Sheppard–Yonge
      [-79.4125, 43.7679], // North York Centre
      [-79.4155, 43.7805], // Finch
    ],
  },
  {
    id: "line-2",
    name: "Line 2 – Bloor–Danforth",
    shortName: "L2",
    color: "#00A650",
    textColor: "#ffffff",
    type: "subway",
    description: "East–west subway running from Kipling in the west to Kennedy in the east.",
    frequency: "Every 2–5 min",
    stops: [
      // Ordered west → east
      { name: "Kipling",        coords: [-79.5358, 43.6375] },
      { name: "Islington",      coords: [-79.5241, 43.6454] },
      { name: "Royal York",     coords: [-79.5096, 43.6485] },
      { name: "Old Mill",       coords: [-79.4941, 43.6498] },
      { name: "Jane",           coords: [-79.4837, 43.6500] },
      { name: "Runnymede",      coords: [-79.4758, 43.6519] },
      { name: "High Park",      coords: [-79.4678, 43.6537] },
      { name: "Keele",          coords: [-79.4595, 43.6555] },
      { name: "Dundas West",    coords: [-79.4519, 43.6573] },
      { name: "Lansdowne",      coords: [-79.4425, 43.6593] },
      { name: "Dufferin",       coords: [-79.4347, 43.6607] },
      { name: "Ossington",      coords: [-79.4270, 43.6622] },
      { name: "Christie",       coords: [-79.4181, 43.6643] },
      { name: "Bathurst",       coords: [-79.4114, 43.6658] },
      { name: "Spadina",        coords: [-79.4048, 43.6671] },
      { name: "St George",      coords: [-79.3988, 43.6684] },
      { name: "Bay",            coords: [-79.3909, 43.6700] },
      { name: "Bloor–Yonge",    coords: [-79.3864, 43.6710] },
      { name: "Sherbourne",     coords: [-79.3762, 43.6721] },
      { name: "Castle Frank",   coords: [-79.3689, 43.6738] },
      { name: "Broadview",      coords: [-79.3588, 43.6767] },
      { name: "Chester",        coords: [-79.3525, 43.6783] },
      { name: "Pape",           coords: [-79.3449, 43.6798] },
      { name: "Donlands",       coords: [-79.3383, 43.6811] },
      { name: "Greenwood",      coords: [-79.3308, 43.6827] },
      { name: "Coxwell",        coords: [-79.3228, 43.6844] },
      { name: "Woodbine",       coords: [-79.3131, 43.6865] },
      { name: "Main Street",    coords: [-79.3015, 43.6891] },
      { name: "Victoria Park",  coords: [-79.2887, 43.6949] },
      { name: "Warden",         coords: [-79.2789, 43.7115] },
      { name: "Kennedy",        coords: [-79.2642, 43.7323] },
    ],
    // Curves: Victoria Park → Warden → Kennedy bend northeast then north
    shape: [
      [-79.5358, 43.6375], // Kipling
      [-79.5241, 43.6454], // Islington
      [-79.5096, 43.6485], // Royal York
      [-79.4941, 43.6498], // Old Mill
      [-79.4837, 43.6500], // Jane
      [-79.4758, 43.6519], // Runnymede
      [-79.4678, 43.6537], // High Park
      [-79.4595, 43.6555], // Keele
      [-79.4519, 43.6573], // Dundas West
      [-79.4425, 43.6593], // Lansdowne
      [-79.4347, 43.6607], // Dufferin
      [-79.4270, 43.6622], // Ossington
      [-79.4181, 43.6643], // Christie
      [-79.4114, 43.6658], // Bathurst
      [-79.4048, 43.6671], // Spadina
      [-79.3988, 43.6684], // St George
      [-79.3909, 43.6700], // Bay
      [-79.3864, 43.6710], // Bloor–Yonge
      [-79.3762, 43.6721], // Sherbourne
      [-79.3689, 43.6738], // Castle Frank
      [-79.3588, 43.6767], // Broadview
      [-79.3525, 43.6783], // Chester
      [-79.3449, 43.6798], // Pape
      [-79.3383, 43.6811], // Donlands
      [-79.3308, 43.6827], // Greenwood
      [-79.3228, 43.6844], // Coxwell
      [-79.3131, 43.6865], // Woodbine
      [-79.3015, 43.6891], // Main Street
      [-79.2887, 43.6949], // Victoria Park
      [-79.2836, 43.7032], // curve — bends northeast toward Warden
      [-79.2789, 43.7115], // Warden
      [-79.2716, 43.7219], // curve — continues northeast toward Kennedy
      [-79.2642, 43.7323], // Kennedy
    ],
  },
  {
    id: "line-4",
    name: "Line 4 – Sheppard",
    shortName: "L4",
    color: "#B100CD",
    textColor: "#ffffff",
    type: "subway",
    description: "Short east–west line along Sheppard Ave, connecting to Line 1 at Sheppard–Yonge.",
    frequency: "Every 5–8 min",
    stops: [
      // Ordered west → east
      { name: "Sheppard–Yonge", coords: [-79.4102, 43.7616] },
      { name: "Bayview",        coords: [-79.3867, 43.7669] },
      { name: "Bessarion",      coords: [-79.3763, 43.7692] },
      { name: "Leslie",         coords: [-79.3659, 43.7713] },
      { name: "Don Mills",      coords: [-79.3464, 43.7754] },
    ],
  },
];

// ─── AI-Generated Route Suggestions ─────────────────────────────────────────

export const GENERATED_ROUTES: GeneratedRoute[] = [
  {
    id: "gen-relief-south",
    name: "Relief Line South",
    shortName: "RL",
    color: "#FF6B35",
    textColor: "#ffffff",
    type: "subway",
    description:
      "Downtown relief subway reducing overcrowding on Line 1. Runs from Pape to Osgoode via the King–Queen corridor, serving dense areas currently underserved.",
    frequency: "Every 3–6 min",
    stops: [
      { name: "Pape",       coords: [-79.3447, 43.6783] },
      { name: "Broadview",  coords: [-79.3572, 43.6650] },
      { name: "Parliament", coords: [-79.3633, 43.6556] },
      { name: "King East",  coords: [-79.3700, 43.6487] },
      { name: "Sherbourne", coords: [-79.3764, 43.6490] },
      { name: "Yonge–King", coords: [-79.3792, 43.6487] },
      { name: "Bay–King",   coords: [-79.3870, 43.6480] },
      { name: "University", coords: [-79.3900, 43.6510] },
      { name: "Osgoode",    coords: [-79.3892, 43.6508] },
    ],
    stats: {
      cost: "$4.8B",
      timeline: "7 years",
      costedTimeline: "11 years",
      minutesSaved: 18,
      dollarsSaved: "$820M/year",
      percentageChance: 62,
      prNightmareScore: 7.2,
    },
  },
  {
    id: "gen-waterfront",
    name: "Waterfront West LRT",
    shortName: "WF",
    color: "#0096C7",
    textColor: "#ffffff",
    type: "streetcar",
    description:
      "New LRT connecting Humber Bay to Union Station along the waterfront, serving rapidly growing condo developments and the Port Lands.",
    frequency: "Every 5–8 min",
    stops: [
      { name: "Humber Bay",            coords: [-79.4800, 43.6267] },
      { name: "Mimico GO",             coords: [-79.4550, 43.6247] },
      { name: "Sunnyside",             coords: [-79.4400, 43.6300] },
      { name: "Dufferin–Lakeshore",    coords: [-79.4289, 43.6331] },
      { name: "Strachan",              coords: [-79.4100, 43.6350] },
      { name: "Bathurst–Harbourfront", coords: [-79.4014, 43.6367] },
      { name: "Rees",                  coords: [-79.3900, 43.6383] },
      { name: "Union Station",         coords: [-79.3806, 43.6453] },
    ],
    stats: {
      cost: "$1.2B",
      timeline: "4 years",
      costedTimeline: "6 years",
      minutesSaved: 8,
      dollarsSaved: "$210M/year",
      percentageChance: 71,
      prNightmareScore: 4.1,
    },
  },
  {
    id: "gen-scarborough",
    name: "Scarborough Connector",
    shortName: "SC",
    color: "#7B2D8B",
    textColor: "#ffffff",
    type: "subway",
    description:
      "Extended rapid transit from Kennedy to Malvern, addressing the transit desert in northeast Scarborough and connecting high-density corridors.",
    frequency: "Every 5–10 min",
    stops: [
      { name: "Kennedy",       coords: [-79.2553, 43.7181] },
      { name: "Lawrence East", coords: [-79.2500, 43.7317] },
      { name: "Ellesmere",     coords: [-79.2422, 43.7508] },
      { name: "Midland",       coords: [-79.2350, 43.7636] },
      { name: "Scarborough TC",coords: [-79.2303, 43.7753] },
      { name: "McCowan",       coords: [-79.2175, 43.7814] },
      { name: "Bellamy",       coords: [-79.2050, 43.7872] },
      { name: "Malvern",       coords: [-79.1936, 43.7931] },
    ],
    stats: {
      cost: "$3.1B",
      timeline: "9 years",
      costedTimeline: "14 years",
      minutesSaved: 22,
      dollarsSaved: "$540M/year",
      percentageChance: 45,
      prNightmareScore: 8.8,
    },
  },
];
