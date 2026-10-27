"""Download the Overture Maps places that mention "Speed Mart" without the `overturemaps` CLI (whose catalog request returned 403 for some networks).
Reads the public GeoParquet files straight from S3 with DuckDB and writes a GeoJSON that tools/overture-bench.mjs understands.

  pip install duckdb
  python3 tools/overture-duckdb.py --out my-places.geojson                      # newest release, Malaysia box
  python3 tools/overture-duckdb.py --release 2025-01-22.0 --out my-places.geojson   # pin a release if the lookup fails
  node tools/overture-bench.mjs my-places.geojson addresses.json > overture.md

The release is found by listing the bucket over plain HTTPS (no key). Bucket path and column names follow Overture's published
places schema; if a release changes them the query error says which column is missing.
"""
import argparse, json, re, sys, urllib.request

BUCKET = "overturemaps-us-west-2"


def latest_release():
    url = f"https://{BUCKET}.s3.amazonaws.com/?prefix=release/&delimiter=/"
    xml = urllib.request.urlopen(url, timeout=30).read().decode()
    rels = sorted(re.findall(r"<Prefix>release/([^/<]+)/</Prefix>", xml))
    if not rels:
        sys.exit("no release found in the bucket listing; pass --release YYYY-MM-DD.N")
    return rels[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release")
    ap.add_argument("--bbox", default="99.5,0.8,119.5,7.5", help="west,south,east,north (default: Malaysia)")
    ap.add_argument("--out", default="speedmart-places.geojson")
    a = ap.parse_args()
    import duckdb
    rel = a.release or latest_release()
    w, s, e, n = map(float, a.bbox.split(","))
    print(f"release {rel}, box {a.bbox}", file=sys.stderr)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
    sql = f"""
      SELECT id, names.primary AS name, ST_Y(geometry) AS lat, ST_X(geometry) AS lng,
             addresses, categories.primary AS category, confidence, brand.names.primary AS brand
      FROM read_parquet('s3://{BUCKET}/release/{rel}/theme=places/type=place/*', hive_partitioning=1)
      WHERE bbox.xmin BETWEEN {w} AND {e} AND bbox.ymin BETWEEN {s} AND {n}
        AND (names.primary ILIKE '%speed%mart%' OR brand.names.primary ILIKE '%speed%mart%')
    """
    cur = con.execute(sql)
    cols = [c[0] for c in cur.description]
    feats = []
    for row in cur.fetchall():
        r = dict(zip(cols, row))
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["lng"], r["lat"]]},
                      "properties": {"id": r["id"], "names": {"primary": r["name"]}, "addresses": r["addresses"] or [],
                                     "categories": {"primary": r["category"]}, "confidence": r["confidence"],
                                     "brand": {"names": {"primary": r["brand"]}}}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(a.out, "w"), ensure_ascii=False)
    print(f"{len(feats)} Speed Mart places written to {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
