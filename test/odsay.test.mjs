/**
 * ODsay 어댑터 검증.
 *
 * 실제 ODsay 는 부르지 않는다 — 키는 배포 서버에만 있고, 여기서는 fetch 를 목으로 갈아끼워
 * 응답 파싱·실패 처리·캐시·동시성·키 유출 여부만 본다.
 */
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetroGraph } from '../server/graph.mjs';
import {
  OdsayRouter, parseOdsay, decodeIfEncoded, scrub,
  pickVariants, pickRouteVariant, normalizeVariants, encodeLegs, decodeLegs,
} from '../server/routing/odsay-router.mjs';
import { GraphRouter } from '../server/routing/graph-router.mjs';
import { createRouter } from '../server/routing/index.mjs';
import { ODSAY } from '../server/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let G;
before(() => {
  G = new MetroGraph(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')));
});

const FAKE_KEY = 'test-key-DO-NOT-USE/+abc==';

/** route_cache 를 흉내내는 메모리 저장소 */
function memStore() {
  const m = new Map();
  return {
    rows: m,
    async getRouteCache(a, b) { return m.get(`${a}|${b}`) ?? null; },
    async putRouteCache(a, b, minutes, fare, transfers, legs) {
      m.set(`${a}|${b}`, { minutes, fare, transfers: transfers ?? null, legs: legs ?? null });
    },
    async getRouteCacheCount() { return m.size; },
  };
}

const okBody = (minutes, payment, extra = []) => ({
  result: { path: [{ pathType: 3, info: { totalTime: minutes, payment } }, ...extra] },
});

const realFetch = globalThis.fetch;
let calls;
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), calls.length - 1);
  };
}
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
});
afterEach(() => { globalThis.fetch = realFetch; });

/* 타이밍을 보는 테스트가 아니면 호출 간격을 낮춰 둔다.
 * 기본값(250ms)으로 전부 돌리면 스위트가 80초까지 늘어난다. */
const mk = (store = memStore(), opts = {}) =>
  new OdsayRouter({ graph: G, store, apiKey: FAKE_KEY, intervalMs: 1, ...opts });
/** 간격 동작 자체를 보는 테스트용 — 운영과 같은 설정 */
const mkTimed = (store = memStore()) => new OdsayRouter({ graph: G, store, apiKey: FAKE_KEY });
const sid = (n) => G.findStations(n)[0].id;

/* ============================================================ 응답 파싱 */
describe('ODsay 응답 파싱', () => {
  test('최소 소요시간 경로를 고르고 시간·요금을 읽는다', () => {
    const r = parseOdsay({
      result: { path: [
        { pathType: 2, info: { totalTime: 51, payment: 1500 } },
        { pathType: 3, info: { totalTime: 38, payment: 1750 } },
        { pathType: 1, info: { totalTime: 44, payment: 1550 } },
      ] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.minutes, 38);
    assert.equal(r.value.fare, 1750);
    assert.equal(r.value.pathType, 3);
  });

  test('실패 응답들을 전부 방어한다', () => {
    const bad = [
      [undefined, '빈 응답'],
      [{}, 'result 없음'],
      [{ error: { code: -99, msg: '검색결과가 없습니다' } }, 'error 객체'],
      [{ result: { error: { code: 500 } } }, 'result.error'],
      [{ result: {} }, 'path 없음'],
      [{ result: { path: [] } }, 'path 빈 배열'],
      [{ result: { path: [{ info: {} }] } }, 'totalTime 없음'],
      [{ result: { path: [{ info: { totalTime: 0 } }] } }, 'totalTime 0'],
      [{ result: { path: [{ info: { totalTime: 'x' } }] } }, 'totalTime 문자열'],
    ];
    for (const [body, label] of bad) {
      const r = parseOdsay(body);
      assert.equal(r.ok, false, label + ' 은 실패로 처리되어야 함');
      assert.ok(r.reason, label + ' 사유 없음');
    }
  });

  test('오류 사유에 코드뿐 아니라 실제 문구까지 담는다', () => {
    // 운영에서 "odsay ?" 만 보이면 키 문제인지 좌표 문제인지 구분이 안 된다
    const cases = [
      // 실제 ODsay 가 돌려준 모양 (error 가 배열이다)
      [{ error: [{ code: '500', message: '[ApiKeyAuthFailed] ApiKey authentication failed.' }] },
        /500/, /ApiKeyAuthFailed/],
      [{ error: { code: -8, msg: '필수 입력값 오류' } }, /-8/, /필수 입력값 오류/],
      [{ error: { message: 'Invalid API Key' } }, /\?/, /Invalid API Key/],
      [{ error: 'service not registered' }, /\?/, /service not registered/],
      [{ result: { error: { code: 500, msg: 'server' } } }, /500/, /server/],
      [{ error: [] }, /no path|\?/, /.*/],
    ];
    for (const [body, codeRe, msgRe] of cases) {
      const r = parseOdsay(body);
      assert.equal(r.ok, false);
      assert.match(r.reason, codeRe, JSON.stringify(body));
      assert.match(r.reason, msgRe, JSON.stringify(body));
    }
  });

  test('응답 모양이 예상과 다르면 최상위 키를 사유에 남긴다', () => {
    const r = parseOdsay({ weird: 1, other: 2 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /keys: weird,other/);
  });

  test('요금이 없거나 이상하면 null 로 두고 시간은 살린다', () => {
    for (const payment of [undefined, null, 'x', -1, NaN]) {
      const r = parseOdsay({ result: { path: [{ info: { totalTime: 30, payment } }] } });
      assert.equal(r.ok, true);
      assert.equal(r.value.minutes, 30);
      assert.equal(r.value.fare, null, String(payment));
    }
  });

  test('탑승 구간(subPath)을 뽑고 도보는 뺀다', () => {
    const r = parseOdsay({
      result: { path: [{ info: { totalTime: 44, payment: 1650, subwayTransitCount: 1, busTransitCount: 1 },
        subPath: [
          { trafficType: 3, sectionTime: 4, distance: 300 },                    // 도보
          { trafficType: 1, sectionTime: 22, stationCount: 12, startName: '서울역', endName: '사당',
            lane: [{ name: '수도권 4호선', subwayCode: 4 }] },
          { trafficType: 3, sectionTime: 3 },                                   // 환승 도보
          { trafficType: 2, sectionTime: 15, stationCount: 6, startName: '사당역', endName: '과천청사',
            lane: [{ busNo: '11-3', type: 11, busID: 999 }] },
        ] }] },
    });
    assert.equal(r.ok, true);
    assert.equal(r.value.legs.length, 2, '도보가 섞여 들어왔다');
    assert.deepEqual(r.value.legs[0],
      { mode: 'subway', name: '수도권 4호선', code: 4, type: null, from: '서울역', to: '사당', stops: 12, min: 22 });
    assert.deepEqual(r.value.legs[1],
      { mode: 'bus', name: '11-3', code: null, type: 11, from: '사당역', to: '과천청사', stops: 6, min: 15 });
    // 환승 수는 그림과 같은 데서 나와야 한다 — 레그 2개면 환승 1회
    assert.equal(r.value.transfers, 1);
  });

  test('subPath 가 없으면 레그는 null 이고 환승은 info 로 센다', () => {
    const r = parseOdsay({
      result: { path: [{ info: { totalTime: 40, payment: 1650, subwayTransitCount: 2, busTransitCount: 1 } }] },
    });
    assert.equal(r.value.legs, null);
    assert.equal(r.value.transfers, 2);
  });
});

/* ============================================ 기준별 경로 3벌 (variants)
 *
 * ODsay 응답의 result.path 에는 이미 요금·환승이 다른 대안 경로가 들어 있다.
 * 예전에는 가장 빠른 것 하나만 쓰고 버려서, 요금 기준에서도 그 사람 요금이 최소가
 * 아니었다. 추가 호출 없이 같은 응답에서 세 벌을 뽑는지 본다.
 */
describe('기준별 경로 3벌', () => {
  /** 지하철 레그 하나 */
  const leg = (name, code, from, to, stops, min) => ({
    trafficType: 1, sectionTime: min, stationCount: stops, startName: from, endName: to,
    lane: [{ name, subwayCode: code }],
  });
  /* 빠르지만 비싼 경로 / 느리지만 싼 경로 / 중간이고 환승 0회인 경로 */
  const THREE = {
    result: {
      path: [
        { info: { totalTime: 30, payment: 2500 },
          subPath: [leg('신분당선', 101, 'A', 'X', 5, 12), leg('수도권 2호선', 2, 'X', 'B', 8, 15)] },
        { info: { totalTime: 38, payment: 1400 },
          subPath: [leg('수도권 1호선', 1, 'A', 'Y', 9, 18), leg('수도권 2호선', 2, 'Y', 'Z', 7, 16),
            leg('수도권 4호선', 4, 'Z', 'B', 2, 3)] },
        { info: { totalTime: 35, payment: 1600 }, subPath: [leg('수도권 3호선', 3, 'A', 'B', 20, 33)] },
      ],
    },
  };

  test('대안 경로에서 시간·요금·환승 최소를 각각 뽑는다', () => {
    const r = parseOdsay(THREE);
    assert.equal(r.ok, true);
    assert.equal(r.value.candidates, 3);

    // 최상위는 예전 그대로 "가장 빠른 경로" — 이 자리를 읽던 코드가 안 깨져야 한다
    assert.equal(r.value.minutes, 30);
    assert.equal(r.value.fare, 2500);

    const v = r.value.variants;
    assert.equal(v.time.minutes, 30);
    assert.equal(v.fare.fare, 1400, '요금 최소가 아니다');
    assert.equal(v.fare.minutes, 38);
    assert.equal(v.transfers.transfers, 0, '환승 최소가 아니다');
    assert.equal(v.transfers.minutes, 35);
  });

  test('세 기준 모두 요약(환승수)과 그림(legs)이 같은 경로에서 나온다', () => {
    // "요약은 환승 2회인데 그림은 4회" 가 다시 생기지 않게 하는 조건이다
    const v = parseOdsay(THREE).value.variants;
    for (const [mode, one] of Object.entries(v)) {
      assert.equal(one.transfers, one.legs.length - 1, `${mode}: 요약과 그림이 다른 경로다`);
    }
    assert.equal(v.fare.legs.length, 3);
    assert.equal(v.transfers.legs.length, 1);
  });

  test('목적함수가 같으면 빠른 경로를 준다', () => {
    const tie = pickVariants([
      { minutes: 50, fare: 1400, transfers: 1, legs: null },
      { minutes: 33, fare: 1400, transfers: 1, legs: null },
    ]);
    assert.equal(tie.fare.minutes, 33);
  });

  test('요금·환승을 모르는 경로가 최소로 이기지는 않는다', () => {
    // payment 가 없다고 "0원" 으로 읽히면 그 경로가 늘 요금 기준 1등이 된다
    const v = pickVariants([
      { minutes: 40, fare: null, transfers: null, legs: null },
      { minutes: 45, fare: 1500, transfers: 2, legs: null },
    ]);
    assert.equal(v.fare.fare, 1500);
    assert.equal(v.transfers.transfers, 2);
  });

  test('후보가 하나뿐이면 세 벌이 같은 경로다', () => {
    const v = parseOdsay(okBody(22, 1550)).value.variants;
    assert.equal(v.fare.minutes, 22);
    assert.equal(v.transfers.minutes, 22);
  });

  test('캐시 블롭을 왕복해도 3벌이 그대로다', () => {
    const src = parseOdsay(THREE).value.variants;
    const back = decodeLegs(encodeLegs(src));
    assert.deepEqual(back, normalizeVariants(src));
    assert.equal(back.fare.fare, 1400);
    assert.equal(back.transfers.legs.length, 1);
  });

  test('깨진 블롭은 캐시 없음으로 본다', () => {
    for (const bad of [null, undefined, '', 'not json', '{}', '[]', 5, {}]) {
      assert.equal(decodeLegs(bad), null, `decodeLegs(${JSON.stringify(bad)})`);
      assert.equal(encodeLegs(bad), null, `encodeLegs(${JSON.stringify(bad)})`);
    }
  });

  describe('개인 경로 재선택 규칙', () => {
    const nv = () => normalizeVariants(parseOdsay(THREE).value.variants);

    test('시간 여유 안이면 그 기준의 경로를 쓴다', () => {
      const v = nv();
      assert.equal(pickRouteVariant(v, 'fare', 10 * 60).fare, 1400);
      assert.equal(pickRouteVariant(v, 'transfers', 10 * 60).transfers, 0);
      assert.equal(pickRouteVariant(v, 'time', 10 * 60).minutes, 30);
    });

    test('여유를 넘으면 그 사람만 시간 최소로 되돌린다', () => {
      /* 순수 최소화는 답이 무너진다 — 200원 아끼려고 40분 더 걸리는 경로는 아무도 안 간다.
         지하철 그래프(scoreForMode)와 같은 규칙·같은 여유값을 쓴다. */
      const v = nv();
      const tight = pickRouteVariant(v, 'fare', 5 * 60);          // 38 > 30+5
      assert.equal(tight.minutes, 30);
      assert.equal(tight.fare, 2500);
      assert.equal(pickRouteVariant(v, 'transfers', 5 * 60).minutes, 35);   // 35 = 30+5, 경계는 포함
      assert.equal(pickRouteVariant(v, 'transfers', 4 * 60).minutes, 30);
    });

    test('시간을 못 읽으면 null — 호출부가 그래프 값으로 남긴다', () => {
      assert.equal(pickRouteVariant(null, 'fare', 600), null);
      assert.equal(pickRouteVariant({ time: { minutes: null } }, 'fare', 600), null);
      assert.equal(pickRouteVariant(nv(), 'nope', 600).minutes, 30, '모르는 기준은 시간 기준으로');
    });
  });
});

/* ============================================================ 키 취급 */
describe('키 취급', () => {
  test('이미 인코딩된 키는 한 번 풀어 이중 인코딩을 막는다', () => {
    assert.equal(decodeIfEncoded('abc%2Bdef%3D'), 'abc+def=');
    assert.equal(decodeIfEncoded('plain-key'), 'plain-key');
    assert.equal(decodeIfEncoded('100%'), '100%');          // 깨진 인코딩은 그대로
  });

  test('로그 문자열에서 키를 지운다', () => {
    assert.ok(!scrub(`failed apiKey=${FAKE_KEY} boom`, FAKE_KEY).includes(FAKE_KEY));
    assert.ok(!scrub(`err ${encodeURIComponent(FAKE_KEY)}`, FAKE_KEY).includes(encodeURIComponent(FAKE_KEY)));
  });

  test('요청 URL 에는 키가 실리지만 health 에는 절대 안 실린다', async () => {
    mockFetch(() => jsonRes(okBody(30, 1550)));
    const r = mk();
    await r.fetchPair(sid('서울역'), sid('강남'));
    assert.ok(calls[0].url.includes('apiKey='), '요청에는 키가 있어야 한다');
    const health = JSON.stringify(r.health);
    assert.ok(!health.includes(FAKE_KEY), 'health 에 키가 노출됨');
    assert.ok(!health.includes(encodeURIComponent(FAKE_KEY)));
  });

  test('앞뒤 공백·줄바꿈은 털어낸다 (환경변수 붙여넣기 사고 방지)', () => {
    const r = new OdsayRouter({ graph: G, store: memStore(), apiKey: `  ${FAKE_KEY}\n`, intervalMs: 1 });
    assert.equal(r.apiKey, FAKE_KEY);
    assert.equal(r.keyInfo.trimmed, true);
    assert.equal(r.keyInfo.length, FAKE_KEY.length);
  });

  test('진단 정보에는 길이·형태만 담고 키 값은 없다', () => {
    const r = new OdsayRouter({ graph: G, store: memStore(), apiKey: FAKE_KEY, intervalMs: 1 });
    const dump = JSON.stringify(r.health);
    assert.ok(!dump.includes(FAKE_KEY));
    assert.equal(r.health.key.length, FAKE_KEY.length);
    assert.equal(typeof r.health.key.urlEncodedInput, 'boolean');
  });

  test('실패 로그에도 키가 남지 않는다', async () => {
    mockFetch(() => jsonRes({ error: { code: -99, msg: `bad key ${FAKE_KEY}` } }));
    const r = mk();
    await r.fetchPair(sid('서울역'), sid('강남'));
    assert.ok(!String(r.stats.lastError).includes(FAKE_KEY));
  });
});

/* ============================================================ 요청 구성 */
describe('요청 구성', () => {
  test('SX/SY/EX/EY 에 경도·위도를 올바른 순서로 넣는다', async () => {
    mockFetch(() => jsonRes(okBody(25, 1550)));
    const r = mk();
    const from = sid('서울역'), to = sid('강남');
    await r.fetchPair(from, to);

    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, ODSAY.url);
    assert.equal(u.searchParams.get('output'), 'json');
    assert.equal(u.searchParams.get('lang'), '0');
    // X = 경도(126~128), Y = 위도(37 근처)
    assert.equal(Number(u.searchParams.get('SX')), G.stations[from].lng);
    assert.equal(Number(u.searchParams.get('SY')), G.stations[from].lat);
    assert.equal(Number(u.searchParams.get('EX')), G.stations[to].lng);
    assert.equal(Number(u.searchParams.get('EY')), G.stations[to].lat);
    assert.ok(Number(u.searchParams.get('SX')) > 125 && Number(u.searchParams.get('SX')) < 130, '경도 자리에 위도가 들어감');
    assert.ok(Number(u.searchParams.get('SY')) > 33 && Number(u.searchParams.get('SY')) < 39, '위도 자리에 경도가 들어감');
  });
});

/* ============================================================ 실패 처리 */
describe('실패 처리 — 그 쌍만 조용히 포기한다', () => {
  test('HTTP 4xx / ODsay error / 빈 결과 는 null', async () => {
    for (const handler of [
      () => jsonRes({}, 403),
      () => jsonRes({ error: { code: -99 } }),
      () => jsonRes({ result: { path: [] } }),
    ]) {
      mockFetch(handler);
      const r = mk();
      assert.equal(await r.fetchPair(sid('서울역'), sid('강남')), null);
      assert.equal(r.stats.failed, 1);
      assert.equal(r.liveOk, false);
    }
  });

  test('429 는 backoff 후 재시도하고, 계속 실패하면 포기한다', async () => {
    mockFetch(() => jsonRes({}, 429));
    const r = mk();
    const out = await r.fetchPair(sid('서울역'), sid('강남'));
    assert.equal(out, null);
    assert.equal(calls.length, ODSAY.maxRetry + 1, '재시도 횟수가 설정과 다름');
  });

  test('429 뒤에 성공하면 그 값을 쓴다', async () => {
    mockFetch((_u, i) => (i === 0 ? jsonRes({}, 429) : jsonRes(okBody(33, 1650))));
    const r = mk();
    const out = await r.fetchPair(sid('서울역'), sid('강남'));
    assert.deepEqual({ m: out.minutes, f: out.fare }, { m: 33, f: 1650 });
    assert.equal(r.liveOk, true);
  });

  test('네트워크 예외를 던지지 않는다', async () => {
    mockFetch(() => { throw new Error('ECONNRESET'); });
    const r = mk();
    assert.equal(await r.fetchPair(sid('서울역'), sid('강남')), null);
  });

  test('좌표가 없는 역은 호출하지 않는다', async () => {
    mockFetch(() => jsonRes(okBody(10, 1550)));
    const r = mk();
    const broken = new MetroGraph(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')));
    broken.stations[0] = { ...broken.stations[0], lat: undefined, lng: undefined };
    r.graph = broken;
    assert.equal(await r.fetchPair(0, sid('강남')), null);
    assert.equal(calls.length, 0, '좌표 없는데도 호출함');
  });
});

/* ============================================================ 캐시 */
describe('캐시', () => {
  test('같은 역쌍은 두 번째부터 호출하지 않는다', async () => {
    mockFetch(() => jsonRes(okBody(28, 1550)));
    const store = memStore();
    const r = mk(store);
    const a = sid('서울역'), b = sid('강남');

    const first = await r.lookupPair(a, b);
    const second = await r.lookupPair(a, b);
    // 캐시가 담는 것과 신선 응답의 모양이 같아야 한다 (시간·요금·환승·경로)
    assert.deepEqual(
      { minutes: first.minutes, fare: first.fare, transfers: first.transfers, legs: first.legs },
      { minutes: 28, fare: 1550, transfers: null, legs: null });
    assert.ok(first.variants, '기준별 3벌이 빠졌다');
    assert.deepEqual(second, first, '캐시 히트와 신선 응답의 모양이 다르다');
    assert.equal(calls.length, 1, 'API 를 두 번 불렀다');
    assert.equal(r.stats.cacheHits, 1);
    assert.equal(store.rows.size, 1);
  });

  test('환승 횟수도 캐시를 타고 그대로 돌아온다', async () => {
    /* 화면에 "환승 N회" 를 적으려면 ODsay 가 실제로 찾은 경로의 환승 수여야 한다.
       그래프가 따로 찾은 경로의 환승 수를 적으면 표시와 시간이 어긋난다.
       환승 수는 탄 교통수단 수 - 1 이다. */
    mockFetch(() => jsonRes({
      result: { path: [{ pathType: 3, info: { totalTime: 40, payment: 1650, subwayTransitCount: 2, busTransitCount: 1 } }] },
    }));
    const store = memStore();
    const r = mk(store);
    const a = sid('서울역'), b = sid('노원');

    const fresh = await r.lookupPair(a, b);
    assert.equal(fresh.transfers, 2, '3개 수단 = 환승 2회');
    const cached = await r.lookupPair(a, b);
    assert.deepEqual(cached, fresh, '캐시에서 환승 수가 빠졌다');
    assert.equal(calls.length, 1);
  });

  test('경로 레그도 캐시를 타고 그대로 돌아온다', async () => {
    /* 시간을 잰 그 경로를 화면에 그리려면 레그가 캐시에도 남아야 한다.
       캐시 히트에서 레그가 빠지면, 캐시가 차오른 뒤부터 화면이 조용히
       지하철 그래프 경로로 되돌아가 요약의 환승 수와 어긋난다. */
    mockFetch(() => jsonRes({
      result: { path: [{ info: { totalTime: 44, payment: 1650, subwayTransitCount: 1, busTransitCount: 1 },
        subPath: [
          { trafficType: 1, sectionTime: 22, stationCount: 12, startName: '서울역', endName: '사당',
            lane: [{ name: '수도권 4호선', subwayCode: 4 }] },
          { trafficType: 2, sectionTime: 15, stationCount: 6, startName: '사당역', endName: '과천청사',
            lane: [{ busNo: '11-3', type: 11 }] },
        ] }] },
    }));
    const store = memStore();
    const r = mk(store);
    const a = sid('서울역'), b = sid('사당');

    const fresh = await r.lookupPair(a, b);
    assert.equal(fresh.legs.length, 2);
    assert.equal(fresh.transfers, 1);
    const cached = await r.lookupPair(a, b);
    assert.deepEqual(cached, fresh, '캐시에서 경로가 빠졌다');
    assert.equal(calls.length, 1);

    // 화면이 그릴 수 있게 우리 노선 키·색이 붙는다 (버스는 키가 없고 버스색으로)
    const painted = r.decorateLegs(cached.legs);
    assert.equal(painted[0].line, '4');
    assert.equal(painted[0].lineName, G.lines['4'].name);
    assert.equal(painted[0].color, G.lines['4'].color);
    assert.equal(painted[1].mode, 'bus');
    assert.equal(painted[1].line, null);
    assert.equal(painted[1].lineName, '11-3');
    assert.ok(painted[1].color, '버스 레그에도 색이 있어야 한다');
  });

  test('기준별 3벌도 캐시를 타고 그대로 돌아온다', async () => {
    /* 3벌이 캐시에서 빠지면, 캐시가 차오른 뒤부터 요금 기준이 조용히
       "가장 빠른 경로" 로 되돌아간다 — 고치기 전과 똑같은 상태가 된다. */
    mockFetch(() => jsonRes({
      result: { path: [
        { info: { totalTime: 30, payment: 2500 },
          subPath: [{ trafficType: 1, sectionTime: 30, stationCount: 10, startName: 'A', endName: 'B',
            lane: [{ name: '신분당선', subwayCode: 101 }] }] },
        { info: { totalTime: 36, payment: 1400 },
          subPath: [{ trafficType: 1, sectionTime: 36, stationCount: 18, startName: 'A', endName: 'B',
            lane: [{ name: '수도권 2호선', subwayCode: 2 }] }] },
      ] },
    }));
    const store = memStore();
    const r = mk(store);
    const a = sid('서울역'), b = sid('강남');

    const fresh = await r.lookupPair(a, b);
    assert.equal(fresh.variants.fare.fare, 1400);
    const cached = await r.lookupPair(a, b);
    assert.deepEqual(cached, fresh, '캐시에서 기준별 3벌이 빠졌다');
    assert.equal(calls.length, 1);
  });

  test('실패한 쌍은 캐시에 남기지 않는다', async () => {
    mockFetch(() => jsonRes({ error: { code: -99 } }));
    const store = memStore();
    await mk(store).lookupPair(sid('서울역'), sid('강남'));
    assert.equal(store.rows.size, 0);
  });
});

/* ============================================================ 중간지점 계산 */
describe('중간지점 계산', () => {
  const origins = () => ['강남', '노원', '인천'].map(sid);

  test('동시 호출 수가 설정값을 넘지 않는다', async () => {
    let inFlight = 0, peak = 0;
    globalThis.fetch = async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return jsonRes(okBody(30, 1550));
    };
    await mk().findMeetingPoint(origins(), { topN: 5 });
    // 최소 간격 게이트가 걸린 뒤로는 실제 동시 실행이 1까지 떨어질 수 있다.
    // 여기서 지켜야 하는 건 "한도를 넘지 않는다" 뿐이다.
    assert.ok(peak <= ODSAY.concurrency, `동시 ${peak}개 (한도 ${ODSAY.concurrency})`);
  });

  test('호출 간 최소 간격을 지킨다 (429 방지)', async () => {
    const at = [];
    globalThis.fetch = async () => { at.push(Date.now()); return jsonRes(okBody(20, 1550)); };
    await mkTimed().findMeetingPoint(['강남', '노원'].map(sid), { topN: 3 });

    at.sort((a, b) => a - b);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    assert.ok(at.length >= 6, `호출이 너무 적어 간격을 볼 수 없다 (${at.length})`);
    // 타이머 오차를 감안해 약간 여유를 둔다
    const floor = ODSAY.minIntervalMs - 40;
    const tooFast = gaps.filter((g) => g < floor);
    assert.equal(tooFast.length, 0, `간격이 ${floor}ms 미만인 호출 ${tooFast.length}건: ${tooFast}`);
  });

  test('429 를 만나면 호출 간격 자체가 넓어진다', async () => {
    const r = mkTimed();
    let n = 0;
    const at = [], intervals = [];
    calls = [];
    globalThis.fetch = async () => {
      calls.push('x'); at.push(Date.now()); intervals.push(r.interval);
      return ++n === 1 ? jsonRes({}, 429) : jsonRes(okBody(20, 1550));
    };
    await r.findMeetingPoint(['강남', '노원'].map(sid), { topN: 3 });
    assert.ok(r.stats.throttled >= 1, '429 카운트가 안 올라갔다');

    /* 간격 자체가 늘어나야 한다. 예약 슬롯만 뒤로 밀면 큐가 이미 길 때
     * 아무 효과가 없고 초당 호출 수도 그대로다.
     * (뒤이어 성공이 쌓이면 다시 좁아지므로 최종값이 아니라 최댓값을 본다) */
    assert.ok(Math.max(...intervals) >= ODSAY.minIntervalMs * 2,
      `간격이 안 늘었다: 최대 ${Math.max(...intervals)}ms (기본 ${ODSAY.minIntervalMs}ms)`);

    at.sort((a, b) => a - b);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    assert.ok(Math.max(...gaps) >= ODSAY.minIntervalMs * 2 - 40,
      `429 뒤 최대 공백 ${Math.max(...gaps)}ms — 실제 호출 간격이 안 벌어졌다`);
  });

  test('계속 성공하면 간격이 원래대로 돌아온다', async () => {
    mockFetch(() => jsonRes(okBody(20, 1550)));
    const r = mkTimed();
    r.interval = ODSAY.maxIntervalMs;          // 이미 느려진 상태에서 시작
    r.okStreak = ODSAY.intervalRecoverAfter - 1;
    await r.fetchPair(sid('서울역'), sid('강남'));
    assert.ok(r.interval < ODSAY.maxIntervalMs, `간격이 안 줄었다: ${r.interval}ms`);
  });

  test('호출 수가 후보×참여자를 넘지 않고 예산 안에 있다', async () => {
    mockFetch(() => jsonRes(okBody(30, 1550)));
    const r = mk();
    await r.findMeetingPoint(origins(), { topN: 5 });
    const maxPairs = 3 * ODSAY.shortlist;
    assert.ok(calls.length <= maxPairs, `${calls.length}회 > 후보쌍 ${maxPairs}`);
    assert.ok(calls.length <= ODSAY.maxCallsPerRequest, '요청당 예산 초과');
  });

  test('ODsay 시간·요금이 결과에 반영된다', async () => {
    // 모든 쌍을 12분·1234원으로 답하면, 출발역이 아닌 후보는 전부 12분이 되어야 한다
    mockFetch(() => jsonRes(okBody(12, 1234)));
    const r = mk();
    const out = await r.findMeetingPoint(origins(), { topN: 5 });
    assert.equal(out.selection.fareSource, 'odsay');
    assert.ok(out.selection.odsayPairs > 0);

    const moved = out.best.routes.filter((x) => x.timeSource === 'odsay');
    assert.ok(moved.length > 0, 'ODsay 로 채워진 경로가 없다');
    for (const x of moved) {
      assert.equal(x.sec, 12 * 60);
      assert.equal(x.fare, 1234);
    }
    assert.equal(out.best.maxSec, Math.max(...out.best.routes.map((x) => x.sec)));
    assert.equal(out.best.sumSec, out.best.routes.reduce((a, x) => a + x.sec, 0));
    assert.equal(out.best.fareTotal, out.best.routes.reduce((a, x) => a + x.fare, 0));
  });

  test('요금 기준에서는 개인 경로도 요금 최소로 바뀐다', async () => {
    /* 예전에는 기준을 바꿔도 ODsay 로 답한 사람의 경로는 늘 "가장 빠른" 것이었다.
       같은 응답 안에 더 싼 대안이 있는데도 요금 기준의 요금이 최소가 아니었다.
       시간 기준은 그대로 가장 빠른 경로여야 한다. */
    mockFetch(() => jsonRes({
      result: { path: [
        { info: { totalTime: 24, payment: 2500 },
          subPath: [{ trafficType: 1, sectionTime: 24, stationCount: 9, startName: 'A', endName: 'B',
            lane: [{ name: '신분당선', subwayCode: 101 }] }] },
        // 6분 더 걸리지만 1,100원 싸고 환승도 없다 (여유 10분 안이라 채택되어야 한다)
        { info: { totalTime: 30, payment: 1400 },
          subPath: [{ trafficType: 1, sectionTime: 30, stationCount: 16, startName: 'A', endName: 'B',
            lane: [{ name: '수도권 2호선', subwayCode: 2 }] }] },
      ] },
    }));
    const out = await mk().findMeetingPoint(origins(), { topN: 3, modes: ['time', 'fare'] });

    const moved = (m) => out.modes[m].best.routes.filter((x) => x.timeSource === 'odsay');
    assert.ok(moved('time').length > 0 && moved('fare').length > 0, 'ODsay 로 채워진 경로가 없다');

    for (const x of moved('time')) {
      assert.equal(x.sec, 24 * 60, '시간 기준은 가장 빠른 경로 그대로여야 한다');
      assert.equal(x.fare, 2500);
    }
    for (const x of moved('fare')) {
      assert.equal(x.fare, 1400, '요금 기준인데 요금이 최소가 아니다');
      // 시간·환승·그림도 그 경로의 값이어야 한다 (요약과 그림이 어긋나면 안 된다)
      assert.equal(x.sec, 30 * 60);
      assert.equal(x.transfersOverride, 0);
      assert.equal(x.odsayLegs.length, 1);
      assert.equal(x.odsayLegs[0].line, '2');
    }
    assert.equal(out.modes.fare.selection.routeBasis, 'fare');
    assert.equal(out.modes.time.selection.routeBasis, 'time');
  });

  test('요금 경로가 너무 느리면 그 사람만 시간 최소로 남는다', async () => {
    // 300원 아끼려고 40분을 더 쓰는 경로는 아무도 안 간다 — 여유(10분)를 넘으면 되돌린다
    mockFetch(() => jsonRes({
      result: { path: [
        { info: { totalTime: 20, payment: 1600 },
          subPath: [{ trafficType: 1, sectionTime: 20, stationCount: 8, startName: 'A', endName: 'B',
            lane: [{ name: '수도권 2호선', subwayCode: 2 }] }] },
        { info: { totalTime: 60, payment: 1300 },
          subPath: [{ trafficType: 2, sectionTime: 60, stationCount: 30, startName: 'A', endName: 'B',
            lane: [{ busNo: '741', type: 11 }] }] },
      ] },
    }));
    const out = await mk().findMeetingPoint(origins(), { topN: 3, modes: ['time', 'fare'] });
    for (const x of out.modes.fare.best.routes.filter((r) => r.timeSource === 'odsay')) {
      assert.equal(x.sec, 20 * 60, '여유를 넘는 느린 경로를 골랐다');
      assert.equal(x.fare, 1600);
    }
  });

  test('ODsay 가 전부 실패해도 그래프 결과를 낸다', async () => {
    mockFetch(() => jsonRes({ error: { code: 500 } }));
    const r = mk();
    const out = await r.findMeetingPoint(origins(), { topN: 5 });
    assert.ok(out && out.best && out.best.station, '결과가 없다');
    assert.equal(out.selection.fareSource, 'estimate', '전면 실패 시에도 fareSource 를 명시해야 한다');
    assert.equal(r.liveOk, false);
    // 그래프 단독 결과와 같아야 한다
    const plain = G.findMeetingPoint(origins(), { topN: 5 });
    assert.equal(out.best.station.id, plain.best.station.id);
  });

  test('일부만 실패하면 그 쌍만 그래프 값으로 남는다', async () => {
    // 특정 출발역에서 나가는 호출만 죽인다 → 그 사람만 그래프 값이어야 한다
    const dead = G.stations[sid('인천')];
    mockFetch((url) => {
      const u = new URL(url);
      const isDead = Number(u.searchParams.get('SX')) === dead.lng && Number(u.searchParams.get('SY')) === dead.lat;
      return isDead ? jsonRes({}, 403) : jsonRes(okBody(15, 1400));
    });
    const out = await mk().findMeetingPoint(origins(), { topN: 5 });
    assert.ok(out.best.station, '결과가 나와야 한다');

    for (const r of out.best.routes) {
      if (r.origin === '인천' && r.sec > 0) {
        assert.equal(r.timeSource, 'graph', '죽은 쌍이 ODsay 값으로 채워졌다');
      } else if (r.sec > 0) {
        assert.equal(r.timeSource, 'odsay');
        assert.equal(r.sec, 15 * 60);
      }
    }
    assert.equal(out.selection.fareSource, 'mixed', '일부만 실측이면 mixed 여야 한다');
  });

  test('출발역과 같은 후보는 0분·0원이고 호출하지 않는다', async () => {
    mockFetch(() => jsonRes(okBody(20, 1550)));
    const r = mk();
    const id = sid('건대입구');
    const out = await r.findMeetingPoint([id, id], { topN: 3 });
    assert.equal(out.best.station.id, id);
    assert.equal(out.best.maxSec, 0);
    assert.equal(out.best.fareTotal, 0);
  });
});

/* ============================================================ 어댑터 선택 */
describe('어댑터 선택', () => {
  const saved = process.env.ODSAY_KEY;
  beforeEach(() => { delete process.env.ODSAY_KEY; });
  afterEach(() => { if (saved === undefined) delete process.env.ODSAY_KEY; else process.env.ODSAY_KEY = saved; });

  test('키가 없으면 그래프 어댑터, 호출도 없다', async () => {
    mockFetch(() => { throw new Error('불러서는 안 된다'); });
    const r = await createRouter({ graph: G, store: memStore() });
    assert.ok(r instanceof GraphRouter);
    assert.ok(!(r instanceof OdsayRouter));
    assert.equal(r.name, 'subway-graph');
    await r.findMeetingPoint(['강남', '노원'].map(sid), { topN: 3 });
    assert.equal(calls.length, 0, '키가 없는데 ODsay 를 불렀다');
  });

  test('키가 있으면 ODsay 어댑터가 뜨고, 성공 후 routing 이름이 바뀐다', async () => {
    process.env.ODSAY_KEY = FAKE_KEY;
    mockFetch(() => jsonRes(okBody(21, 1550)));
    const r = await createRouter({ graph: G, store: memStore() });
    assert.ok(r instanceof OdsayRouter);
    assert.equal(r.name, 'odsay+subway', 'init 확인 호출 뒤 live 여야 함');
    assert.equal(r.health.live, true);
  });

  test('캐시가 있어도 실호출이 연달아 깨지면 정상인 척하지 않는다', async () => {
    // IP 화이트리스트를 쓰면 재배포 때 서버 IP 가 바뀌어 실제로 이렇게 끊긴다.
    // 예전 캐시가 남아 있다는 이유로 odsay+subway 라고 표시하면 끊긴 걸 못 알아챈다.
    const store = memStore();
    await store.putRouteCache(1, 2, 20, 1550);          // 예전에 성공한 흔적
    process.env.ODSAY_KEY = FAKE_KEY;
    mockFetch(() => jsonRes({ error: [{ code: '500', message: '[ApiKeyAuthFailed] ApiKey authentication failed.' }] }));

    const r = new OdsayRouter({ graph: G, store, apiKey: FAKE_KEY, intervalMs: 1 });
    await r.init();
    assert.equal(r.name, 'odsay+subway', '캐시가 있으면 일단 정상으로 본다');

    for (let i = 0; i < ODSAY.failStreakDegraded; i++) await r.fetchPair(sid('서울역'), sid('강남'));
    assert.equal(r.degraded, true);
    assert.equal(r.name, 'subway-graph (odsay-failing)');
    assert.match(r.health.lastError, /ApiKeyAuthFailed/);

    // 다시 성공하면 원상 복구
    mockFetch(() => jsonRes(okBody(20, 1550)));
    await r.fetchPair(sid('서울역'), sid('사당'));
    assert.equal(r.stats.failStreak, 0);
    assert.equal(r.name, 'odsay+subway');
  });

  test('키가 있어도 ODsay 가 죽어 있으면 pending 으로 남는다', async () => {
    process.env.ODSAY_KEY = FAKE_KEY;
    mockFetch(() => jsonRes({}, 500));
    const r = await createRouter({ graph: G, store: memStore() });
    assert.equal(r.name, 'subway-graph (odsay-pending)');
    assert.equal(r.health.live, false);
  });
});
