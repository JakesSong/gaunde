/**
 * 가운데 — API 서버
 *
 * 가입이 없으므로 모임 링크의 토큰 자체가 접근 권한이다.
 * 토큰을 아는 사람은 참여자 등록·조회·결과 계산을 할 수 있다.
 */
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetroGraph, normalizeName } from './graph.mjs';
import { openStore, TRACKED_EVENTS, deviceKey } from './db.mjs';
import { createRouter } from './routing/index.mjs';
import { TOLERANCE_MIN, FARE, LAST_TRAIN_APPROX, BUSY_AREA_NAMES, MODES, DEFAULT_MODE } from './config.mjs';
import { parseRange } from './daterange.mjs';
import { lookupEgressIp } from './egress-ip.mjs';

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
const router = await createRouter({ graph, store });

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

/**
 * 기록이 조용히 실패한 흔적.
 *
 * 측정 쓰기는 사용자 요청을 망치지 않으려고 예외를 삼킨다. 그런데 삼키기만 하면
 * 안 쌓이는 걸 알아챌 방법이 로그뿐이고, Render 로그는 재시작하면 날아간다.
 * (실제로 피드백 버튼을 넣은 날 저녁 서버가 부팅에 실패하는 동안 표가 유실됐는데,
 *  집계가 1건인 걸 사람이 눈으로 보고서야 알았다.)
 * 그래서 실패를 세어 /api/health 와 /api/stats 에 같이 내보낸다 — 0 이 아니면 문제다.
 */
const writeFailures = { events: 0, feedback: 0, resultView: 0, lastError: null, lastAt: null };

function noteWriteFailure(kind, event, e) {
  writeFailures[kind]++;
  writeFailures.lastError = `${event}: ${e.message}`;
  writeFailures.lastAt = new Date().toISOString();
  // 스택까지 남긴다. 방언 오류나 인덱스 누락은 메시지 한 줄로는 짚기 어렵다.
  console.error(`[track] 저장 실패 (${kind}/${event}) — 누적 ${writeFailures[kind]}건:`, e.stack || e.message);
}

/** 기록 실패가 사용자 요청을 망치지 않게 삼킨다. 측정은 기능보다 뒤다 — 다만 조용히는 아니다. */
async function track(event, meeting, meta) {
  try {
    await store.logEvent(event, meeting?.id ?? null, meeting?.token ?? null, meta ?? null);
  } catch (e) {
    noteWriteFailure('events', event, e);
  }
}

/* ------------------------------------------------------------------ 결과 스냅샷 캐시
 *
 * 결과 링크(?m=토큰&r=1)로 다시 들어올 때마다 후보 130개 minimax 를 다시 돌리고
 * ODsay 를 다시 부르는 건 낭비다. 참여자 구성이 그대로면 계산 결과도 그대로다.
 *
 * 키에는 응답에 드러나는 것을 전부 넣는다 — 출발역뿐 아니라 이름·인원도 응답에 실리므로
 * 이름만 바뀌어도 캐시는 무효가 돼야 한다. 순서와 무관하게 같은 값이 나오도록 정렬한다.
 * 노선도를 다시 빌드하면 역 id 가 밀릴 수 있어 그래프 생성시각도 함께 섞는다. */
const RESULT_CACHE_TTL_DAYS = 7;
/* 응답 모양이 바뀌면 옛 스냅샷은 새 화면과 맞지 않는다(후보 개수·환승 필드 등).
   모양을 바꿀 때마다 올려서 캐시를 통째로 무효화한다. */
/* 6: 레그 없는 옛 route_cache 행을 걸러내기 시작했다. 그 전에 만들어진 스냅샷에는
   그래프 폴백 경로가 그대로 굳어 있어서(요약의 환승 수와 그림이 어긋난 채로),
   route_cache 가 다시 채워져도 스냅샷을 버리지 않으면 화면이 그대로다.
   7: 계산이 두 군데 바뀌었다 — 기준별 minMaxSec 가 후보 풀 전체 값으로 통일됐고,
   요금·환승 기준에서는 참여자 개인 경로도 그 기준으로 다시 뽑는다. 옛 스냅샷에는
   기준마다 다른 최선값과 시간 최소 경로가 굳어 있어서, 버리지 않으면 고친 화면이
   그 모임에서만 예전 그대로다.
   8: ODsay 로 답한 참여자의 개인 경로도 기준으로 다시 뽑는다. 7 까지는 지하철 그래프로
   답한 사람만 그랬고, ODsay 쪽은 늘 '가장 빠른' 경로였다 — 요금 기준인데 그 사람 요금이
   최소가 아닌 채로 스냅샷에 굳어 있다. */
const RESULT_SHAPE_REV = 8;
const graphFingerprint = graph.meta.generatedAt || '';
const resultCacheStats = { hits: 0, misses: 0 };

function participantsHash(participants) {
  const parts = participants
    .map((p) => `${p.id}|${p.name}|${p.station_id}`)
    .sort();
  return crypto.createHash('sha256')
    .update(`v${RESULT_SHAPE_REV}\n${graphFingerprint}\n${parts.join('\n')}`)
    .digest('hex')
    .slice(0, 32);
}

/* 번화가 표식은 이름으로 대조한다 — 그래프를 다시 빌드해도 id 와 달리 안 밀린다. */
const BUSY_AREAS = new Set(BUSY_AREA_NAMES.map(normalizeName));

/**
 * 추천역의 노선별 막차 — 정적 근사치.
 *
 * 시각표 데이터가 없으므로 "막차를 놓치는가" 는 계산하지 않는다.
 * 노선 등급별 통상 범위만 내려주고, 화면은 이 값을 늘 '대략' 으로 표시한다.
 * 범위를 모르는 노선은 아예 빼서, 모르는 걸 지어내지 않는다.
 */
function lastTrainFor(lines) {
  return lines
    .map((l) => ({ line: l, lineName: graph.lines[l]?.name || l, approx: LAST_TRAIN_APPROX.byLine[l] }))
    .filter((x) => x.approx);
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

/** 배포된 빌드를 구분하기 위한 표식. 배포 확인이 필요한 변경마다 손으로 올린다. */
const REV = 'mode-routes-odsay-1';

app.get('/api/health', (req, res) => res.json({
  ok: true, rev: REV, db: dbKind, stations: graph.stations.length,
  routing: router.name, hubs: graph.hubIds.length, toleranceMin: TOLERANCE_MIN,
  // ODsay 를 쓸 때만 붙는다. 키는 절대 싣지 않는다.
  resultCache: { ...resultCacheStats, ttlDays: RESULT_CACHE_TTL_DAYS },
  // 0 이 아니면 집계가 유실되고 있다는 뜻이다. 재발을 사람 눈이 아니라 여기서 잡는다.
  writeFailures: { ...writeFailures },
  ...(router.health ? { odsay: router.health } : {}),
}));

/**
 * 이 서버가 밖으로 나갈 때 쓰는 공인 IP.
 *
 * ODsay 처럼 호출자 IP 를 화이트리스트로 받는 서비스에 등록하려고 쓴다.
 * 캐시하지 않는다 — 인스턴스가 바뀌면 IP 도 바뀌므로 부를 때마다 확인해야
 * 로테이션을 알아챌 수 있다. 서버 공인 IP 라 민감정보가 아니고 인증도 걸지 않는다.
 * (헬스체크에는 넣지 않는다. 매번 외부 호출이 붙어 느려진다.)
 */
app.get('/api/egress-ip', rateLimit(30, 60_000), asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await lookupEgressIp();
  if (!r.ok) {
    return res.status(502).json({ error: '외부 IP 확인에 실패했습니다.', tried: r.tried });
  }
  res.json({ ip: r.ip, source: r.source, checkedAt: r.checkedAt });
}));

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

  const clientId = clean(req.body?.clientId, 64) || null;
  const alreadyJoined = clientId ? existing.some((x) => x.client_id === clientId) : false;
  const p = await store.upsertParticipant(
    meeting.id, name, resolved.station.name, resolved.station.id, clientId,
  );
  // meta 에는 역 이름만 남긴다. 참여자 이름은 participants 에 이미 있고 집계에 쓸 일이 없다.
  await track('origin_submitted', meeting, {
    station: resolved.station.name,
    changed: alreadyJoined,                       // 최초 등록인지 출발역 변경인지
    participantCount: existing.length + (alreadyJoined ? 0 : 1),
  });
  res.status(201).json({ participant: shapeParticipant(p) });
}));

/** 등록한 내용 고치기 — 링크를 아는 사람이면 누구나 할 수 있다(단톡방 도구라 그게 맞다). */
app.patch('/api/meetings/:token/participants/:id', rateLimit(60, 60_000), asyncRoute(async (req, res) => {
  const meeting = await store.getMeetingByToken(req.params.token);
  if (!meeting) return res.status(404).json({ error: '없는 모임입니다.' });

  const fields = {};
  if (req.body?.name !== undefined) {
    const name = clean(req.body.name, 20);
    if (!name) return res.status(400).json({ error: '이름을 입력해 주세요.' });
    fields.name = name;
  }
  if (req.body?.station !== undefined || req.body?.stationId !== undefined) {
    const resolved = resolveStation(req.body.stationId ?? req.body.station);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    if (resolved.ambiguous && req.body.stationId === undefined) {
      return res.status(409).json({ error: '같은 이름의 역이 여러 개입니다. 하나를 골라 주세요.', candidates: resolved.ambiguous });
    }
    fields.station = resolved.station.name;
    fields.stationId = resolved.station.id;
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: '바꿀 내용이 없습니다.' });

  const p = await store.updateParticipant(meeting.id, req.params.id, fields);
  if (!p) return res.status(404).json({ error: '없는 참여자입니다.' });
  res.json({ participant: shapeParticipant(p) });
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

  /* 참여자 구성이 그대로면 저장해둔 결과를 그대로 돌려준다.
   * 조회 측정(result_viewed)은 캐시 히트여도 계속 남긴다. */
  const hash = participantsHash(participants);
  const cached = await store.getMeetingResult(meeting.id, hash, router.name, RESULT_CACHE_TTL_DAYS)
    .catch((e) => { console.error('[result-cache] 조회 실패:', e.message); return null; });

  if (cached) {
    resultCacheStats.hits++;
    let payload;
    try {
      payload = JSON.parse(cached);
    } catch (e) {
      console.error('[result-cache] 파싱 실패, 다시 계산합니다:', e.message);
      payload = null;
    }
    if (payload) {
      await track('result_viewed', meeting, {
        participants: participants.length,
        station: payload.best?.station?.name,
        maxMin: payload.best?.maxMin,
        cached: true,
      });
      payload.selection = { ...payload.selection, cached: true };
      return res.json(payload);
    }
  }
  resultCacheStats.misses++;

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

  /* 후보를 6개까지 보여줬더니 "너무 많다" 는 피드백이 있었다.
     best + 대안 2개 = 목록 3개면 비교하기에 충분하다.

     세 기준을 한 번에 계산해 내려보낸다. 토글할 때마다 다시 물어보면 ODsay 쿼터를
     세 배로 쓰고, 캐시도 기준마다 따로 생긴다. 계산 자체는 3모드 합쳐 2ms 수준이다(실측). */
  const result = await router.findMeetingPoint(originIds, { topN: 3, modes: MODES });
  if (!result) return res.status(500).json({ error: '중간지점을 계산하지 못했습니다.' });

  const shapeSpot = (spot) => {
    const routes = spot.routes.map((r, i) => {
      const timeSource = r.timeSource ?? 'graph';
      /* 시간을 잰 그 경로(ODsay 실제 경로)를 같이 내려보낸다. 화면은 이게 있으면 이걸 그리고,
         없으면(예전 캐시 행·그래프 경로) 아래 legs 로 되돌아간다. */
      const odsayLegs = timeSource === 'odsay' && Array.isArray(r.odsayLegs) && r.odsayLegs.length
        ? r.odsayLegs.map((l) => ({
          mode: l.mode, line: l.line, lineName: l.lineName, color: l.color,
          from: l.from, to: l.to, stops: l.stops, min: l.min,
        }))
        : null;
      return {
        participantId: participants[i].id,
        name: participants[i].name,
        origin: r.origin,
        originId: r.originId,
        /* 방위 힌트용 좌표. 지도를 그리는 게 아니라 "만날 역이 어느 쪽인가" 만 낸다. */
        originLat: graph.stations[r.originId]?.lat ?? null,
        originLng: graph.stations[r.originId]?.lng ?? null,
        min: Math.round(r.sec / 60),
        fare: r.fare,
        surcharges: r.surcharges,
        timeSource,
        /* 시간 오차 폭. ODsay 실시간 값에는 붙이지 않는다 — 그건 근사가 아니다.
           같은 역이면 이동이 없으니 0. */
        marginMin: timeSource === 'graph' ? Math.round((r.marginSec ?? 0) / 60) : 0,
        // ODsay 로 계산된 경로면 실제 환승 횟수, 아니면 그래프가 찾은 경로의 환승 횟수
        transfers: Number.isFinite(r.transfersOverride) ? r.transfersOverride : (r.path?.transfers ?? 0),
        estimated: !!r.path?.legs.some((l) => l.hasEstimate),
        legs: (r.path?.legs ?? []).map((l) => ({
          line: l.line, lineName: l.lineName, color: l.color,
          from: l.from, to: l.to, stops: l.stops, estimated: !!l.hasEstimate,
        })),
        ...(odsayLegs ? { odsayLegs } : {}),
      };
    }).sort((a, b) => b.min - a.min);

    /* 이 후보의 시간을 무엇으로 냈는가 — 화면 배지가 이 값 하나만 보고 문구를 고른다.
       "요금은 근사치" 라고만 써 있고 시간은 확정처럼 보인다는 피드백에 대한 답이다.
       움직이지 않는 사람(same-station)은 판정에서 뺀다. */
    const moving = routes.filter((r) => r.timeSource !== 'same-station');
    const live = moving.filter((r) => r.timeSource === 'odsay').length;
    const timeBasis = !moving.length ? 'none'
      : live === moving.length ? 'odsay'
        : live > 0 ? 'mixed' : 'graph';

    return {
      station: { id: spot.station.id, name: spot.station.name, lat: spot.station.lat, lng: spot.station.lng, lines: spot.station.lines },
      maxMin: Math.round(spot.maxSec / 60),
      avgMin: Math.round(spot.avgSec / 60),
      totalMin: Math.round(spot.sumSec / 60),
      fareAvg: spot.fareAvg,
      fareTotal: spot.fareTotal,
      /* 환승 수는 화면에 나간 값에서 다시 센다. spot.transfersTotal 은 그래프가 짐작한
         값이라, ODsay 가 실제 환승 횟수를 준 경로에서는 표와 어긋난다. */
      transfersTotal: routes.reduce((a, r) => a + r.transfers, 0),
      transfersMax: Math.max(0, ...routes.map((r) => r.transfers)),
      inBand: spot.inBand,
      timeBasis,
      /* 그래프로 낸 사람 중 가장 큰 오차 폭. 화면에는 "대략 ±N분" 으로 나간다. */
      marginMin: Math.max(0, ...routes.map((r) => r.marginMin)),
      /* 시간 말고 다른 기준 — 순위에는 쓰지 않고 표식만 단다 */
      tags: {
        transferLines: spot.station.lines.length,
        busyArea: BUSY_AREAS.has(normalizeName(spot.station.name)),
      },
      /* 막차는 계산이 아니라 통상 범위 표시다. 화면 문구에 '대략' 이 반드시 붙는다. */
      lastTrain: { note: LAST_TRAIN_APPROX.note, lines: lastTrainFor(spot.station.lines) },
      routes,
    };
  };

  // 결과가 실제로 나온 경우에만 기록한다 (참여자 2명 미만이면 위에서 이미 400 으로 빠진다).
  await track('result_viewed', meeting, {
    participants: participants.length,
    station: result.best.station.name,
    maxMin: Math.round(result.best.maxSec / 60),
    cached: false,
  });

  const shapeSelection = (sel) => ({
    ...sel,
    routing: router.name,
    // ODsay 가 요금을 준 경우엔 근사치가 아니다
    fareApprox: (sel.fareSource ?? 'estimate') !== 'odsay' && FARE.approx,
    /* "환승 시간은 따진 건가?" 라는 질문이 반복돼서 응답에 명시한다.
       자체 그래프는 환승마다 도보 150초 + 배차의 절반을 더하고,
       ODsay 경로는 실제 환승 대기가 포함된 시간이라 어느 쪽이든 참이다. */
    includesTransferTime: true,
    cached: false,
  });

  /* 기준(시간·요금·환승)별 결과를 통째로 내려보낸다 — 화면 토글이 재요청 없이 갈아끼운다.
     최상위 best/alternatives/selection 은 예전 그대로 기본 기준(시간)이다. 오래된 캐시나
     modes 를 모르는 화면이 와도 그 자리만 읽으면 지금까지와 똑같이 동작한다. */
  const shapedModes = {};
  for (const [name, m] of Object.entries(result.modes || {})) {
    shapedModes[name] = {
      best: shapeSpot(m.best),
      alternatives: m.alternatives.map(shapeSpot),
      selection: shapeSelection(m.selection),
    };
  }
  const primary = shapedModes[result.selection?.mode || DEFAULT_MODE] || {
    best: shapeSpot(result.best),
    /** 프런트에서 후보를 눌러 바로 전환할 수 있게 경로까지 통째로 내려준다 */
    alternatives: result.alternatives.map(shapeSpot),
    /** 어떻게 골랐는지 — 화면 각주와 디버깅용 */
    selection: shapeSelection(result.selection),
  };

  const payload = {
    meeting: shapeMeeting(meeting, participants),
    best: primary.best,
    alternatives: primary.alternatives,
    selection: primary.selection,
    ...(Object.keys(shapedModes).length > 1 ? { modes: shapedModes } : {}),
    /** 가장 불리한 사람이 "누군가의 집 앞"으로 갈 때의 최대 소요시간 — 절감 효과 문구용 */
    worstIfSomeonesHomeMin: Math.round(result.worstPairwiseSec / 60),
  };

  /* 저장 실패가 응답을 막지 않게 한다. 다음 요청에서 다시 계산하면 그만이다.
   * 동시에 두 요청이 계산했더라도 같은 키로 upsert 되므로 결과는 같다. */
  try {
    await store.putMeetingResult(meeting.id, hash, JSON.stringify(payload), router.name);
  } catch (e) {
    console.error('[result-cache] 저장 실패:', e.message);
  }

  res.json(payload);
}));

/** 프런트에서만 알 수 있는 이벤트(공유 버튼 클릭 등)를 받는다.
 *  fire-and-forget 이므로 늘 204 로 답하고, 알 수 없는 이벤트는 조용히 버린다. */
app.post('/api/track', rateLimit(120, 60_000), asyncRoute(async (req, res) => {
  const event = clean(req.body?.event, 40);
  const token = clean(req.body?.token, 40);
  if (!TRACKED_EVENTS.includes(event)) return res.status(204).end();

  const meeting = token ? await store.getMeetingByToken(token) : null;

  if (event === 'result_feedback') {
    await recordFeedback(meeting, req.body);
    return res.status(204).end();
  }

  if (event === 'result_view') {
    await recordResultView(meeting, req.body);
    return res.status(204).end();
  }

  await track(event, meeting, { source: 'client' });
  res.status(204).end();
}));

/** 불만족 이유는 화면에 있는 칩만 받는다 (자유 입력을 그대로 저장하지 않는다) */
const FEEDBACK_REASONS = ['too_far', 'many_transfers', 'odd_station', 'other'];

/**
 * 결과 만족/불만족.
 *
 * 모임·기기당 한 표만 세고, 다시 누르면 마지막 값으로 갱신한다.
 * 기기 식별자는 그대로 저장하지 않고 모임별로 해시한다 — 같은 모임 안에서
 * 중복만 걸러내면 되고, 모임을 가로질러 같은 기기를 따라다닐 이유는 없다.
 */
async function recordFeedback(meeting, body) {
  if (!meeting) return;
  const value = clean(body?.value, 8);
  if (value !== 'good' && value !== 'bad') return;

  const rawReason = clean(body?.reason, 24);
  const reason = value === 'bad' && FEEDBACK_REASONS.includes(rawReason) ? rawReason : null;
  const station = clean(body?.station, 40) || null;
  const clientId = clean(body?.clientId, 64);
  if (!clientId) return;

  try {
    await store.upsertFeedback(meeting.id, meeting.token, deviceKey(meeting.id, clientId),
      { value, reason, station });
  } catch (e) {
    noteWriteFailure('feedback', 'result_feedback', e);
  }
}

/**
 * 결과 화면을 실제로 본 기기.
 *
 * result_viewed 는 결과 API 가 불릴 때마다 쌓이는 모임 단위 조회수라
 * "참여자 중 몇 명이 결과를 봤나" 를 셀 수 없다 — 한 사람이 새로고침해도 늘고,
 * 세 명이 한 화면을 같이 봐도 1 이다. 그래서 사람(기기) 단위 신호를 따로 받는다.
 *
 * clientId 가 없으면 셀 수 없는 신호이므로 그냥 버린다(구버전 프런트·직접 호출).
 * 프런트에도 localStorage 가드가 있지만 사파리 프라이빗 모드나 캐시 삭제로 뚫리므로
 * 실제 중복 제거는 여기 유니크 인덱스가 책임진다.
 */
async function recordResultView(meeting, body) {
  if (!meeting) return;
  const clientId = clean(body?.clientId, 64);
  if (!clientId) return;

  try {
    await store.upsertResultView(meeting.id, meeting.token, deviceKey(meeting.id, clientId));
  } catch (e) {
    noteWriteFailure('resultView', 'result_view', e);
  }
}

/** KPI 한 방 조회 — 집계만 나가므로 개인정보는 포함되지 않는다.
 *
 *   curl -s https://<주소>/api/stats | jq .kpi
 *
 * 날짜로 좁히려면 from/to 를 준다. 한국 날짜 기준이고 to 는 exclusive 다.
 *   ?from=2026-08-13&to=2026-08-14   → KST 8/13 하루
 */
app.get('/api/stats', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { range, error } = parseRange({ from: req.query.from, to: req.query.to });
  if (error) return res.status(400).json({ error });
  /* 집계를 읽는 자리에서 "이 숫자를 믿어도 되는지" 도 같이 보여준다.
     프로세스가 살아 있는 동안의 실패 수라 재시작하면 0 으로 돌아간다 —
     그래도 0 이 아닌 걸 보면 지금 유실 중이라는 건 확실히 안다. */
  res.json({ ...await store.getStats(range), writeFailures: { ...writeFailures } });
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
