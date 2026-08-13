#!/usr/bin/env node
/**
 * 수도권 전철 그래프 빌더
 *
 * 입력
 *   data/raw/osm_routes.json               — OpenStreetMap route relations (ODbL)
 *   data/raw/seoul_metro_interstation.csv  — 서울교통공사 역간거리 및 소요시간 (공공누리 1유형)
 *
 * 출력
 *   data/graph.json        — 역·구간·노선 그래프 (런타임이 읽는 유일한 데이터 파일)
 *   data/build-report.json — 커버리지·보정·검증 리포트
 *
 * 소요시간 모델
 *   measured : 서울교통공사 공표 실측 주행시간 (1~8호선 자사 운영구간)
 *   modeled  : t_run = (A + B*km) * speedFactor[노선등급]
 *              A, B는 위 실측 267개 구간의 최소제곱 적합값
 *   두 경우 모두 "주행시간"이며 정차시간(dwell)은 포함하지 않는다.
 *   경로 계산 시 중간 정차역마다 DWELL_SEC 를 별도로 더한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'data');

/** 중간 정차역 1곳당 정차시간(초).
 *  근거: 서울교통공사 실측 "주행시간" 합계와 공표 전구간 소요시간의 차이.
 *  2호선 순환 주행합 65.0분 vs 공표 약 87분 → 43개 정차 기준 약 31초. */
const DWELL_SEC = 30;

/* ------------------------------------------------------------------ 노선 정의 */
/* headwayMin : 평일 낮 대표 배차간격(분) — 환승·최초승차 대기(headway/2) 산출용 추정치
   class      : 주행속도 등급 (speedFactor 적용 단위)
   extraFare  : 수도권 통합요금 위에 붙는 노선 별도운임(원). 근사치이며 구간별 차등은 반영하지 않는다.
                대부분 노선은 통합요금에 포함되어 0. ODsay 어댑터를 붙이면 실제 요금으로 대체된다. */
const LINES = {
  '1':      { name: '1호선',       color: '#0052A4', headwayMin: 6,  class: 'commuter', extraFare: 0 },
  '2':      { name: '2호선',       color: '#00A84D', headwayMin: 4,  class: 'metro', extraFare: 0 },
  '3':      { name: '3호선',       color: '#EF7C1C', headwayMin: 5,  class: 'metro', extraFare: 0 },
  '4':      { name: '4호선',       color: '#00A5DE', headwayMin: 5,  class: 'metro', extraFare: 0 },
  '5':      { name: '5호선',       color: '#996CAC', headwayMin: 5,  class: 'metro', extraFare: 0 },
  '6':      { name: '6호선',       color: '#CD7C2F', headwayMin: 6,  class: 'metro', extraFare: 0 },
  '7':      { name: '7호선',       color: '#747F00', headwayMin: 5,  class: 'metro', extraFare: 0 },
  '8':      { name: '8호선',       color: '#E6186C', headwayMin: 6,  class: 'metro', extraFare: 0 },
  '9':      { name: '9호선',       color: '#BB8336', headwayMin: 5,  class: 'metro', extraFare: 0 },
  '경의중앙': { name: '경의중앙선',   color: '#77C4A3', headwayMin: 14, class: 'commuter', extraFare: 0 },
  '수인분당': { name: '수인분당선',   color: '#F5A200', headwayMin: 9,  class: 'commuter', extraFare: 0 },
  '경춘':    { name: '경춘선',      color: '#0C8E72', headwayMin: 16, class: 'commuter', extraFare: 0 },
  '경강':    { name: '경강선',      color: '#003DA5', headwayMin: 16, class: 'commuter', extraFare: 0 },
  '서해':    { name: '서해선',      color: '#8FC31F', headwayMin: 14, class: 'commuter', extraFare: 0 },
  '공항철도': { name: '공항철도',     color: '#0090D2', headwayMin: 9,  class: 'express', extraFare: 0 },
  '신분당':   { name: '신분당선',    color: '#D4003B', headwayMin: 6,  class: 'express', extraFare: 1000 },
  '인천1':   { name: '인천1호선',   color: '#7CA8D5', headwayMin: 7,  class: 'metro', extraFare: 0 },
  '인천2':   { name: '인천2호선',   color: '#F5A251', headwayMin: 6,  class: 'metro', extraFare: 0 },
  '의정부':   { name: '의정부경전철', color: '#FDA600', headwayMin: 6,  class: 'lightrail', extraFare: 0 },
  '용인':    { name: '용인경전철',   color: '#509F22', headwayMin: 6,  class: 'lightrail', extraFare: 0 },
  '우이신설': { name: '우이신설선',   color: '#B7C452', headwayMin: 5,  class: 'lightrail', extraFare: 0 },
  '신림':    { name: '신림선',      color: '#6789CA', headwayMin: 5,  class: 'lightrail', extraFare: 0 },
  '김포골드': { name: '김포골드라인',  color: '#A17E46', headwayMin: 5,  class: 'lightrail', extraFare: 0 },
  'GTX-A':  { name: 'GTX-A',      color: '#9A6292', headwayMin: 17, class: 'gtx', extraFare: 1650 },
};

/* 주행시간 배율 — 도시철도 실측으로 적합한 식 대비 얼마나 빠른가. 1.0 미만 = 더 빠름.
 * calibrate-speed.mjs 가 아래 REFERENCES(공표 전구간 소요시간)로부터 산출한다.
 * 공표치 기준점이 있는 노선은 노선별 값을, 없는 노선은 등급 기본값을 쓴다. */
const SPEED_FACTOR_CLASS = {
  metro: 1.000,      // 실측 적합식 자체가 도시철도 기준이므로 1.0
  lightrail: 1.000,  // 경전철도 역간거리·속도가 도시철도와 유사
  commuter: 0.792,  // 광역철도 기본값 = 경춘·경의중앙 기준점의 평균
  express: 0.786,   // 급행형 기본값 = 공항철도·신분당 기준점의 평균
  gtx: 0.342,
};
const SPEED_FACTOR_LINE = {
  '경춘': 0.649,
  '경의중앙': 0.934,
  '공항철도': 0.779,
  '신분당': 0.792,
  'GTX-A': 0.342,
};
const speedFactorFor = (lineKey) =>
  SPEED_FACTOR_LINE[lineKey] ?? SPEED_FACTOR_CLASS[LINES[lineKey].class] ?? 1;

/* 배율 산출 근거 — 공표 전구간 소요시간(정차시간 포함) */
const REFERENCES = [
  { line: '경춘',    from: '청량리', to: '춘천',          minutes: 82,  src: '표정속도 64km/h 공표치(나무위키 경춘선) × 실거리' },
  { line: '경의중앙', from: '문산',   to: '용문',          minutes: 165, src: '완행 전구간 2시간40분~3시간05분(나무위키)의 중앙값' },
  { line: '공항철도', from: '서울역', to: '인천공항1터미널', minutes: 59,  src: '공항철도 일반열차 공표 소요시간' },
  { line: '신분당',   from: '신사',   to: '광교',          minutes: 42,  src: '표정속도 48.3km/h 공표치 × 실거리' },
  { line: 'GTX-A',   from: '운정중앙', to: '서울역',       minutes: 22,  src: 'GTX-A 개통 공표 소요시간' },
];

/* OSM ref 태그 -> 내부 노선 키 */
const REF_MAP = {
  '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
  '경의·중앙': '경의중앙', '수인·분당': '수인분당', '경춘': '경춘', '경강': '경강',
  '서해': '서해', '공항철도': '공항철도', '신분당': '신분당',
  '인천1': '인천1', 'I2': '인천2', 'U': '의정부', '용인': '용인',
  'W': '우이신설', 'Silim': '신림', '김포 골드라인': '김포골드', 'GTX-A': 'GTX-A',
};

/* 정차역을 건너뛰는 등급 열차 — 인접관계 추출에서 제외.
 * GTX-A 는 노선명 자체에 '광역급행'이 들어가므로 예외 처리. */
const SKIP_PATTERN = /급행|특급|직통/;

/* 개명 역 — 서울교통공사 CSV(2024-08) 의 옛 이름을 현재 이름으로 옮긴다 */
const STATION_ALIAS = {
  '당고개': '불암산',   // 2024-08 개명. CSV 는 옛 이름, OSM 은 새 이름을 쓴다.
};

/* OSM 오태깅 수동 보정 — 각 항목에 근거를 남긴다 */
const NODE_RENAME = {
  // 우이신설선 삼양사거리 정거장이 '삼양'으로 오태깅되어 삼양역이 2개로 분리됨.
  // (37.62115,127.02048) 는 삼양사거리역 실제 위치.
  9459739637: '삼양사거리',
};

/* ------------------------------------------------------------------ 유틸 */
const R_EARTH = 6371.0088;
function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

/** 역명 정규화 키: 괄호 부제·공백·구분자 제거, 접미 '역' 제거 */
function normName(raw) {
  return String(raw || '').trim()
    .replace(/\(.*?\)/g, '')
    .replace(/[\s·.\-–]/g, '')
    .replace(/역$/, '');
}

const report = { warnings: [], droppedRelations: [], fixes: [] };

/* ------------------------------------------------------------------ 1) OSM 파싱 */
const osm = JSON.parse(fs.readFileSync(path.join(RAW, 'osm_routes.json'), 'utf8'));
const osmNodes = new Map();
for (const e of osm.elements) if (e.type === 'node') osmNodes.set(e.id, e);
const relations = osm.elements.filter((e) => e.type === 'relation');

function rawName(n) {
  const nm = NODE_RENAME[n.id] || n.tags?.['name:ko'] || n.tags?.name;
  return nm ? String(nm).trim() : null;
}

/* 이름 없는 정차 노드는 최근접 유명 정차 노드의 이름으로 해석한다.
 * (OSM 공항철도 홍대입구/디지털미디어시티 승강장에 name 태그 누락) */
const namedPts = [];
for (const n of osmNodes.values()) if (rawName(n)) namedPts.push({ name: rawName(n), lat: n.lat, lng: n.lon });
const NAME_RESOLVE_KM = 0.3;
const resolvedNames = new Map();
function resolveName(n) {
  const direct = rawName(n);
  if (direct) return direct;
  if (resolvedNames.has(n.id)) return resolvedNames.get(n.id);
  let best = null, bestD = Infinity;
  for (const p of namedPts) {
    const d = haversineKm({ lat: n.lat, lng: n.lon }, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  const out = bestD <= NAME_RESOLVE_KM ? best.name : null;
  if (out) report.fixes.push(`이름 없는 정차 노드 ${n.id} → '${out}' (최근접 ${(bestD * 1000).toFixed(0)}m)`);
  else report.warnings.push(`이름 없는 정차 노드 ${n.id} 해석 실패 (최근접 ${(bestD * 1000).toFixed(0)}m)`);
  resolvedNames.set(n.id, out);
  return out;
}

function stopSequence(rel) {
  const out = [];
  for (const m of rel.members || []) {
    if (m.type !== 'node') continue;
    if (!/^stop(_entry_only|_exit_only)?$/.test(m.role)) continue;   // inactive_stop 제외
    const n = osmNodes.get(m.ref);
    if (!n) continue;
    const name = resolveName(n);
    if (!name) continue;
    out.push({ osmId: n.id, name, lat: n.lat, lng: n.lon });
  }
  return out;
}

const usableRels = [];
for (const rel of relations) {
  const t = rel.tags || {};
  const lineKey = REF_MAP[t.ref];
  const nm = t.name || '';
  if (!lineKey) { report.droppedRelations.push({ id: rel.id, name: nm, why: 'unmapped ref' }); continue; }
  if (lineKey !== 'GTX-A' && SKIP_PATTERN.test(nm)) { report.droppedRelations.push({ id: rel.id, name: nm, why: 'express/limited-stop service' }); continue; }
  const seq = stopSequence(rel);
  if (seq.length < 2) { report.droppedRelations.push({ id: rel.id, name: nm, why: `stop members = ${seq.length}` }); continue; }
  usableRels.push({ id: rel.id, name: nm, lineKey, seq });
}

/* ------------------------------------------------------------------ 2) 역사 클러스터링
 * 같은 정규화 역명 + 반경 CLUSTER_KM 이내를 하나의 물리 역사로 묶는다.
 * 방향별 승강장 노드(보통 200~350m 이격)는 병합되고,
 * 동명이역(5호선 양평 vs 경의중앙선 양평 등)은 분리된다. */
const CLUSTER_KM = 0.45;
const byName = new Map();
for (const rel of usableRels) {
  for (const s of rel.seq) {
    const k = normName(s.name);
    if (!byName.has(k)) byName.set(k, new Map());
    byName.get(k).set(s.osmId, s);
  }
}

const stations = [];
const nodeToStation = new Map();

for (const [key, nodesMap] of byName) {
  const pts = [...nodesMap.values()];
  const clusters = [];
  for (const p of pts) {
    const hit = clusters.find((c) => c.some((q) => haversineKm(q, p) <= CLUSTER_KM));
    if (hit) hit.push(p); else clusters.push([p]);
  }
  for (let changed = true; changed;) {           // 전이적 병합
    changed = false;
    outer:
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[i].some((a) => clusters[j].some((b) => haversineKm(a, b) <= CLUSTER_KM))) {
          clusters[i] = clusters[i].concat(clusters[j]); clusters.splice(j, 1); changed = true; break outer;
        }
      }
    }
  }
  clusters.forEach((cl) => {
    const st = {
      id: stations.length, key,
      name: cl[0].name.replace(/\s+/g, ' ').trim(),
      lat: cl.reduce((s, p) => s + p.lat, 0) / cl.length,
      lng: cl.reduce((s, p) => s + p.lng, 0) / cl.length,
      lines: new Set(),
    };
    for (const p of cl) nodeToStation.set(p.osmId, st.id);
    stations.push(st);
  });
  if (clusters.length > 1) report.warnings.push(`동명이역 분리: '${key}' → ${clusters.length}개 역사`);
}

/* ------------------------------------------------------------------ 3) 인접 구간 */
const edgeMap = new Map();
function addEdge(aId, bId, lineKey) {
  if (aId === bId) return;
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const k = `${lo}|${hi}|${lineKey}`;
  if (!edgeMap.has(k)) {
    edgeMap.set(k, { a: lo, b: hi, line: lineKey, straightKm: haversineKm(stations[lo], stations[hi]), km: null, sec: null, source: null });
  }
}
for (const rel of usableRels) {
  let prev = null;
  for (const s of rel.seq) {
    const sid = nodeToStation.get(s.osmId);
    if (sid === undefined) continue;
    stations[sid].lines.add(rel.lineKey);
    if (prev !== null && prev !== sid) addEdge(prev, sid, rel.lineKey);
    prev = sid;
  }
}

/* ------------------------------------------------------------------ 4) 실측 결합 */
const csvRows = fs.readFileSync(path.join(RAW, 'seoul_metro_interstation.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1)
  .map((l) => { const c = l.split(','); return { line: c[1].trim(), name: c[2].trim(), time: c[3].trim(), km: parseFloat(c[4]) }; });

const lineNameIndex = new Map();
for (const st of stations) for (const ln of st.lines) lineNameIndex.set(`${ln}|${st.key}`, st.id);

let measuredApplied = 0;
const unmatchedRows = [];
const factorSamples = [];
for (let i = 1; i < csvRows.length; i++) {
  const prev = csvRows[i - 1], cur = csvRows[i];
  if (cur.line !== prev.line) continue;
  const [mm, ss] = cur.time.split(':').map(Number);
  const sec = mm * 60 + ss;
  if (!sec) continue;
  const csvKey = (n) => normName(STATION_ALIAS[n.trim()] ?? n);
  const aId = lineNameIndex.get(`${cur.line}|${csvKey(prev.name)}`);
  const bId = lineNameIndex.get(`${cur.line}|${csvKey(cur.name)}`);
  if (aId === undefined || bId === undefined) { unmatchedRows.push(`${cur.line}호선 ${prev.name}→${cur.name}: 역 미매칭`); continue; }
  const [lo, hi] = aId < bId ? [aId, bId] : [bId, aId];
  const e = edgeMap.get(`${lo}|${hi}|${cur.line}`);
  if (!e) { unmatchedRows.push(`${cur.line}호선 ${prev.name}→${cur.name}: 인접구간 아님(지선 경계)`); continue; }
  e.sec = sec; e.km = cur.km; e.source = 'measured';
  measuredApplied++;
  if (cur.km > 0 && e.straightKm > 0.05) factorSamples.push(cur.km / e.straightKm);
}

/* ------------------------------------------------------------------ 5) 모델 적합 */
const routeFactor = factorSamples.reduce((s, v) => s + v, 0) / factorSamples.length;

const fit = [...edgeMap.values()].filter((e) => e.source === 'measured' && e.km > 0);
const n = fit.length;
const sx = fit.reduce((s, e) => s + e.km, 0), sy = fit.reduce((s, e) => s + e.sec, 0);
const sxx = fit.reduce((s, e) => s + e.km * e.km, 0), sxy = fit.reduce((s, e) => s + e.km * e.sec, 0);
const B = (n * sxy - sx * sy) / (n * sxx - sx * sx);
const A = (sy - B * sx) / n;
const mae = fit.reduce((s, e) => s + Math.abs(A + B * e.km - e.sec), 0) / n;

for (const e of edgeMap.values()) {
  if (e.source === 'measured') continue;
  e.km = e.straightKm * routeFactor;
  const factor = speedFactorFor(e.line);
  e.sec = Math.max(45, Math.round((A + B * e.km) * factor));
  e.source = 'modeled';
}

/* ------------------------------------------------------------------ 6) 출력 */
const stationsOut = stations
  .filter((s) => s.lines.size > 0)
  .map((s) => ({ id: s.id, name: s.name, lat: +s.lat.toFixed(6), lng: +s.lng.toFixed(6), lines: [...s.lines] }));
const keptIds = new Set(stationsOut.map((s) => s.id));
const edgesOut = [...edgeMap.values()]
  .filter((e) => keptIds.has(e.a) && keptIds.has(e.b))
  .map((e) => ({ a: e.a, b: e.b, line: e.line, sec: e.sec, km: +e.km.toFixed(3), src: e.source === 'measured' ? 'm' : 'e' }));

const counts = {
  stations: stationsOut.length,
  edges: edgesOut.length,
  measuredEdges: edgesOut.filter((e) => e.src === 'm').length,
  modeledEdges: edgesOut.filter((e) => e.src === 'e').length,
  lines: Object.keys(LINES).length,
};
counts.measuredRatio = +(counts.measuredEdges / counts.edges).toFixed(4);

const graph = {
  meta: {
    generatedAt: new Date().toISOString(),
    scope: '수도권 전철 (서울·경기·인천 및 연장 운행구간)',
    sources: [
      { name: 'OpenStreetMap route relations', use: '역 목록·좌표·노선별 인접관계·환승 판정', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' },
      { name: '서울교통공사 역간거리 및 소요시간 (2024-08-10 기준)', use: '1~8호선 자사 운영구간 실측 주행시간·역간거리', license: '공공누리 제1유형(출처표시)', url: 'https://data.seoul.go.kr/dataList/OA-12034/S/1/datasetView.do' },
    ],
    model: {
      runFormula: 't_run_sec = (A + B * km) * speedFactor[class]',
      A: +A.toFixed(2), B: +B.toFixed(2),
      fitSamples: n, fitMAEsec: +mae.toFixed(1),
      impliedMetroCruiseKmh: +(3600 / B).toFixed(1),
      routeFactor: +routeFactor.toFixed(4),
      routeFactorNote: '직선거리→선로거리 보정. 실측 역간거리/직선거리의 평균.',
      speedFactorClass: SPEED_FACTOR_CLASS,
      speedFactorLine: SPEED_FACTOR_LINE,
      speedFactorNote: '주행시간 배율. 공표 전구간 소요시간(REFERENCES)에 맞춰 보정. 노선별 값이 있으면 우선, 없으면 등급 기본값.',
      dwellSec: DWELL_SEC,
      dwellNote: '중간 정차역 1곳당 정차시간. 실측 주행시간 합과 공표 전구간 소요시간의 차이에서 산출.',
      transferWalkSec: 150,
      transferNote: '환승비용 = 도보 150초 + (환승할 노선 배차간격/2). 최초 승차에도 배차간격/2를 적용.',
      caveats: [
        '1호선 경부/경인/경원 계통, 2호선 지선, 5호선 마천지선은 동일 노선으로 취급하여 계통 간 환승 대기를 반영하지 않는다.',
        '급행·특급 열차는 제외하고 각역정차 기준으로만 계산한다.',
        'GTX-A 성남역이 OSM 관계에 누락되어 있어 수서~구성 사이 정차가 반영되지 않는다.',
        '배차간격은 평일 낮 대표값 추정치이며 시간대별 변동을 반영하지 않는다.',
      ],
    },
    counts,
  },
  lines: LINES,
  stations: stationsOut,
  edges: edgesOut,
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify(graph));

Object.assign(report, {
  measuredApplied, unmatchedRows, usableRelations: usableRels.length, counts, model: graph.meta.model,
  linesCovered: Object.fromEntries(Object.keys(LINES).map((k) => [k, {
    stations: stationsOut.filter((s) => s.lines.includes(k)).length,
    edges: edgesOut.filter((e) => e.line === k).length,
    measured: edgesOut.filter((e) => e.line === k && e.src === 'm').length,
  }])),
  references: REFERENCES,
});
fs.writeFileSync(path.join(OUT, 'build-report.json'), JSON.stringify(report, null, 2));

console.log(`역 ${counts.stations} / 구간 ${counts.edges}  (실측 ${counts.measuredEdges} = ${(counts.measuredRatio * 100).toFixed(1)}%, 추정 ${counts.modeledEdges})`);
console.log(`모델 t_run = (${A.toFixed(1)} + ${B.toFixed(1)}·km) × factor   MAE ${mae.toFixed(1)}s (n=${n}), 경로계수 ${routeFactor.toFixed(3)}, dwell ${DWELL_SEC}s`);
console.log(`보정 ${report.fixes.length}건, 경고 ${report.warnings.length}건, 실측 미결합 ${unmatchedRows.length}행`);
