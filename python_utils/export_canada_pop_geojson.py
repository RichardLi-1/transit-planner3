#!/usr/bin/env python3
"""Convert can_pop.bin to can_pop.geojson for tippecanoe."""
import struct, json, os

INPUT  = "web/public/can_pop.bin"
OUTPUT = "can_pop.geojson"

with open(INPUT, "rb") as f:
    n = struct.unpack("<I", f.read(4))[0]
    print(f"Reading {n:,} points...")
    features = []
    for i in range(n):
        lng, lat, density = struct.unpack("<fff", f.read(12))
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lng, 5), round(lat, 5)]},
            "properties": {"d": round(density, 2)},
        })

print(f"Writing {OUTPUT}...")
with open(OUTPUT, "w") as f:
    json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))

print(f"Done. {os.path.getsize(OUTPUT)/1e6:.1f} MB")
