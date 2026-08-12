#!/usr/bin/env bash
# 수도권 전철 노선 원본을 OpenStreetMap 에서 다시 받는다.
#   사용법: bash scripts/fetch-osm.sh && npm run build:graph && npm test
#
# 새 노선이 개통하거나 역명이 바뀌었을 때 실행하면 된다.
# 결과는 data/raw/osm_routes.json (ODbL, © OpenStreetMap contributors).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=data/raw/osm_routes.json

# network 태그로 수도권 전철 전체를 잡고, 정차 노드까지 함께 받는다.
read -r -d '' Q <<'EOF' || true
[out:json][timeout:600];
rel["type"="route"]["network"~"수도권 전철|Seoul Metropolitan Subway"]["route"~"^(subway|light_rail|train|monorail)$"];
out body;
node(r);
out body;
EOF

# 우이신설선은 network 태그가 비어 있어 별도로 받아 합친다.
read -r -d '' Q2 <<'EOF' || true
[out:json][timeout:300];
rel(id:7533582,7533583);
out body;
node(r);
out body;
EOF

echo "→ Overpass 조회 (수도권 전철 전체)"
curl -sS -m 600 -X POST https://overpass-api.de/api/interpreter --data-urlencode "data=$Q" -o "$OUT.tmp"
echo "→ Overpass 조회 (우이신설선)"
curl -sS -m 300 -X POST https://overpass-api.de/api/interpreter --data-urlencode "data=$Q2" -o data/raw/osm_ui_sinseol.json

node -e '
const fs = require("fs");
const a = JSON.parse(fs.readFileSync("data/raw/osm_routes.json.tmp", "utf8"));
const b = JSON.parse(fs.readFileSync("data/raw/osm_ui_sinseol.json", "utf8"));
const have = new Set(a.elements.map((e) => e.type + e.id));
for (const e of b.elements) if (!have.has(e.type + e.id)) a.elements.push(e);
for (const e of a.elements) if (e.type === "relation" && [7533582, 7533583].includes(e.id)) e.tags.network = "수도권 전철";
fs.writeFileSync("data/raw/osm_routes.json", JSON.stringify(a));
const rels = a.elements.filter((e) => e.type === "relation").length;
console.log(`→ 관계 ${rels}개 저장`);
'
rm -f "$OUT.tmp"
