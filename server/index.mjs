/**
 * 가운데 — API 서버
 *
 * 가입이 없으므로 모임 링크의 토큰 자체가 접근 권한이다.
 * 토큰을 아는 사람은 참여자 등록·조회·결과 계산을 할 수 있다.
 */
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetroGraph, normalizeName } from './graph.mjs';
import { openStore, TRACKED_EVENTS } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

/* ------------------------------------------------------------------ 부팅 */
const graphPath = path.join(ROOT, 'data', 'graph.json');
if (!fs.existsSync(graphPath)) {
  console.error('data/graph.json 이 없습니다. `npm run build:graph` 를 먼저 실행하세요.');
  process.exit(1);
}
const graph = new MetroGraph(JSON.parse(fs.readFileSync(graphPath, 'utf8')));
const { store, kind: dbKind } = await openStore();

/* 자동완성용 역 목록은 요청마다 만들 필요가 없다 */
const stationIndex = graph.stations.map((s) => ({
  id: s.id, name: s.name, lines: s.lines, key: normalizeName(s.name),
}));
const stationPayload = JSON.stringify({
  stations: stationIndex.map(({ id, name, lines }) => ({ id, name, lines })),
  lines: graph.lines,
});

/* ------------------------------------------------------------------ 앱 */
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

/** 간단한 남용 방지 — 쓰기 요청만 IP 단위로 제한 */
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}|${req.route?.path ?? req.path}`;
    const rec = hits.get(key);
    if (!rec || now > rec.reset) { hits.set(key, { n: 1, reset: now + windowMs }); return next(); }
    if (++rec.n > max) return res.status(429).json({ error: '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60_000).unref();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clean(str, maxLen) {
  return String(str ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

/* ------------------------------------------------------------------ 측정 이벤트
 *
 * KPI = 생성된 링크 중 참여자 3명 이상 모인 비율 (목표 30%)
 *
 * 외부 분석 도구 없이 DB(events)에만 쌓는다.
 * 저장하는 건 무슨 일이 언제 어느 모임에서 일어났는지 뿐이다.
 * IP·User-Agent·쿠키·기기 식별자는 남기지 않는다.
 * 이벤트 이름 목록은 집계 쪽과 어긋나면 안 되므로 db.mjs 에서 가져온다. */

/** 기록 실패가 사용자 요청을 망치지 않게 삼킨다. 측정은 기능보다 뒤다. */
async function track(event, meeting, meta) {
  try {
    await store.logEvent(event, meeting?.id ?? null, meeting?.token ?? null, meta ?? null);
  } catch (e) {
    console.error('[track]', event, e.message);
  }
}

/** 이름이나 id 로 역을 찾는다. 동명이역이면 후보를 함께 돌려준다. */
function resolveStation(input) {
  if (input === null || input === undefined || input === '') return { error: '출발역을 입력해 주세요.' };
  if (typeof input === 'number' || /^\d+$/.test(input)) {
    const s = graph.stations[Number(input)];
    return s ? { station: s } : { error: '존재하지 않는 역입니다.' };
  }
  const hits_ = graph.findStations(input);
  if (!hits_.length) return { error: `'${input}' 역을 찾을 수 없습니다.` };
  if (hits_.length > 1) {
    return { station: hits_[0], ambiguous: hits_.map((s) => ({ id: s.id, name: s.name, lines: s.lines })) };
  }
  return { station: hits_[0] };
}

/* ------------------------------------------------------------------ 라우트 */

app.get('/api/health', (req, res) => res.json({ ok: true, db: dbKind, stations: graph.stations.length }));

/** 데이터 출처·커버리지 — 프런트 각주에 그대로 쓴다 */
app.get('/api/meta', (req, res) => res.json(graph.meta));

/** 역 목록 (자동완성용). 빌드마다 바뀌므로 짧게 캐시. */
app.get('/api/stations', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/json').send(stationPayload);
});

/** 모임 생성 → 공유 토큰 발급 */
app.post('/api/meetings', rateLimit(20, 60_000), asyncRoute(async (req, res) => {
  const name = clean(req.body?.name, 60) || '이름 없는 모임';
  const meeting = await store.createMeeting(name);
  await track('room_created', meeting);
  res.status(201).json(shapeMeeting(meeting, []));
}));

/** 모임 + 참여현황 조회 */
app.get('/api/meetings/:token', asyncRoute(async (req, res) => {
  const meeting = await store.getMeetingByToken(req.params.token);
  if (!meeting) return res.status(404).json({ error: '없는 모임입니다. 링크를 다시 확인해 주세요.' });
  res.json(shapeMeeting(meeting, await store.listParticipants(meeting.id)));
}));

/** 출발역 등록 (같은 이름이면 덮어쓰기) */
app.post('/api/meetings/:token/participants', rateLimit(60, 60_000), asyncRoute(async (req, res) => {
  const meeting = await store.getMeetingByToken(req.params.token);
  if (!meeting) return res.status(404).json({ error: '없는 모임입니다.' });

  const name = clean(req.body?.name, 20);
  if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });

  const resolved = resolveStation(req.body?.stationId ?? req.body?.station);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  if (resolved.ambiguous && req.body?.stationId === undefined) {
    return res.status(409).json({ error: '같은 이름의 역이 여러 개입니다. 하나를 골라 주세요.', candidates: resolved.ambiguous });
  }

  const existing = await store.listParticipants(meeting.id);
  if (existing.length >= 30 && !existing.some((p) => p.name === name)) {
    return res.status(400).json({ error: '한 모임에는 30명까지 참여할 수 있습니다.' });
  }

  const alreadyJoined = existing.some((x) => x.name === name);
  const p = await store.upsertParticipant(meeting.id, name, resolved.station.name, resolved.station.id);
  // meta 에는 역 이름만 남긴다. 참여자 이름은 participants 에 이미 있고 집계에 쓸 일이 없다.
  await track('origin_submitted', meeting, {
    station: resolved.station.name,
    changed: alreadyJoined,                       // 최초 등록인지 출발역 변경인지
    participantCount: existing.length + (alreadyJoined ? 0 : 1),
  });
  res.status(201).json({ participant: shapeParticipant(p) });
}));

app.delete('/api/meetings/:token/participants/:id', rateLimit(60, 60_000), asyncRoute(async (req, res) => {
  const meeting = await store.getMeetingByToken(req.params.token);
  if (!meeting) return res.status(404).json({ error: '없는 모임입니다.' });
  const ok = await store.deleteParticipant(meeting.id, req.params.id);
  res.status(ok ? 204 : 404).end();
}));

/** 중간지점 계산 */
app.get('/api/meetings/:token/result', asyncRoute(async (req, res) => {
  const meeting = await store.getMeetingByToken(req.params.token);
  if (!meeting) return res.status(404).json({ error: '없는 모임입니다.' });

  const participants = await store.listParticipants(meeting.id);
  if (participants.length < 2) {
    return res.status(400).json({ error: '두 명 이상 출발역을 등록해야 계산할 수 있습니다.', participants: participants.map(shapeParticipant) });
  }

  const originIds = participants.map((p) => {
    const s = graph.stations[p.station_id];
    // 그래프를 다시 빌드해 id 가 밀렸을 수 있으므로 이름으로 한 번 더 확인한다.
    if (s && normalizeName(s.name) === normalizeName(p.station)) return s.id;
    const byName = graph.findStations(p.station);
    return byName.length ? byName[0].id : null;
  });
  if (originIds.some((id) => id === null)) {
    return res.status(500).json({ error: '등록된 역 중 현재 노선도에 없는 역이 있습니다.' });
  }

  const result = graph.findMeetingPoint(originIds, { topN: 6 });
  if (!result) return res.status(500).json({ error: '중간지점을 계산하지 못했습니다.' });

  const shapeSpot = (spot) => ({
    station: { id: spot.station.id, name: spot.station.name, lat: spot.station.lat, lng: spot.station.lng, lines: spot.station.lines },
    maxMin: Math.round(spot.maxSec / 60),
    avgMin: Math.round(spot.avgSec / 60),
    totalMin: Math.round(spot.sumSec / 60),
    routes: spot.routes.map((r, i) => ({
      participantId: participants[i].id,
      name: participants[i].name,
      origin: r.origin,
      min: Math.round(r.sec / 60),
      transfers: r.path?.transfers ?? 0,
      estimated: !!r.path?.legs.some((l) => l.hasEstimate),
      legs: (r.path?.legs ?? []).map((l) => ({
        line: l.line, lineName: l.lineName, color: l.color,
        from: l.from, to: l.to, stops: l.stops,
      })),
    })).sort((a, b) => b.min - a.min),
  });

  // 결과가 실제로 나온 경우에만 기록한다 (참여자 2명 미만이면 위에서 이미 400 으로 빠진다).
  await track('result_viewed', meeting, {
    participants: participants.length,
    station: result.best.station.name,
    maxMin: Math.round(result.best.maxSec / 60),
  });

  res.json({
    meeting: shapeMeeting(meeting, participants),
    best: shapeSpot(result.best),
    alternatives: result.alternatives.map(shapeSpot),
    /** 가장 불리한 사람이 "누군가의 집 앞"으로 갈 때의 최대 소요시간 — 절감 효과 문구용 */
    worstIfSomeonesHomeMin: Math.round(result.worstPairwiseSec / 60),
  });
}));

/** 프런트에서만 알 수 있는 이벤트(공유 버튼 클릭 등)를 받는다.
 *  fire-and-forget 이므로 늘 204 로 답하고, 알 수 없는 이벤트는 조용히 버린다. */
app.post('/api/track', rateLimit(120, 60_000), asyncRoute(async (req, res) => {
  const event = clean(req.body?.event, 40);
  const token = clean(req.body?.token, 40);
  if (!TRACKED_EVENTS.includes(event)) return res.status(204).end();

  const meeting = token ? await store.getMeetingByToken(token) : null;
  await track(event, meeting, { source: 'client' });
  res.status(204).end();
}));

/** KPI 한 방 조회 — 집계만 나가므로 개인정보는 포함되지 않는다.
 *    curl -s https://<주소>/api/stats | jq .kpi     */
app.get('/api/stats', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await store.getStats());
}));

/* ------------------------------------------------------------------ 응답 정형화 */
function shapeParticipant(p) {
  return { id: p.id, name: p.name, station: p.station, stationId: p.station_id, joinedAt: p.created_at };
}
function shapeMeeting(m, participants) {
  return {
    token: m.token,
    name: m.name,
    createdAt: m.created_at,
    shareUrl: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/?m=${m.token}` : `/?m=${m.token}`,
    participants: participants.map(shapeParticipant),
  };
}

/* ------------------------------------------------------------------ 오류 */
app.use((req, res) => res.status(404).json({ error: '없는 경로입니다.' }));
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

const server = app.listen(PORT, () => {
  console.log(`가운데 API  http://localhost:${PORT}`);
  console.log(`  저장소 ${dbKind}`);
  console.log(`  노선도 역 ${graph.meta.counts.stations} / 구간 ${graph.meta.counts.edges} (실측 ${(graph.meta.counts.measuredRatio * 100).toFixed(0)}%)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => store.close().then(() => process.exit(0))); });
}

export { app };
