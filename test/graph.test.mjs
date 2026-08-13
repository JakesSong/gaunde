/**
 * 그래프·경로·minimax 검증
 *   node --test test/
 *
 * 세 종류를 나눠서 본다.
 *   A. 알고리즘 정확성 — 벨만-포드/완전탐색과 대조 (구현이 맞는지)
 *   B. 데이터 무결성   — 연결성·환승역·중복 (데이터가 맞는지)
 *   C. 현실 대조       — 실제 소요시간과 비교 (모델이 쓸 만한지)
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetroGraph } from '../server/graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let G;
before(() => {
  G = new MetroGraph(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')));
});

const sid = (name) => {
  const s = G.findStations(name);
  assert.ok(s.length, `역을 찾을 수 없음: ${name}`);
  return s[0].id;
};
const minutes = (from, to) => {
  const r = G.dijkstra(sid(from));
  return r.stationTime[sid(to)] / 60;
};

/* ============================================================ A. 알고리즘 정확성 */
describe('A. 알고리즘 정확성', () => {
  /** 다익스트라 결과를 벨만-포드(느리지만 단순)와 대조 */
  test('다익스트라 == 벨만-포드 (무작위 출발역 3곳)', () => {
    const origins = [sid('서울역'), sid('오이도'), sid('춘천')];
    for (const o of origins) {
      const fast = G.dijkstra(o);

      const INF = 0x7fffffff;
      const dist = new Int32Array(G.nodeCount).fill(INF);
      for (const u of G.stationNodes.get(o)) dist[u] = G.waitSec(G.nodeLine[u]);
      for (let iter = 0; iter < G.nodeCount; iter++) {
        let changed = false;
        for (let u = 0; u < G.nodeCount; u++) {
          if (dist[u] === INF) continue;
          for (const e of G.adj[u]) {
            if (dist[u] + e.cost < dist[e.to]) { dist[e.to] = dist[u] + e.cost; changed = true; }
          }
        }
        if (!changed) break;
      }
      for (let u = 0; u < G.nodeCount; u++) {
        assert.equal(fast.dist[u], dist[u], `노드 ${u} 거리 불일치 (출발 ${G.stations[o].name})`);
      }
    }
  });

  test('자기 자신까지는 0분', () => {
    for (const n of ['강남', '서울역', '인천', '오이도']) assert.equal(minutes(n, n), 0);
  });

  test('복원한 경로의 구간 합이 총 소요시간과 일치', () => {
    const pairs = [['강남', '홍대입구'], ['노원', '사당'], ['인천', '수원'], ['춘천', '광교']];
    for (const [a, b] of pairs) {
      const r = G.dijkstra(sid(a));
      const p = G.buildPath(r, sid(a), sid(b));
      assert.ok(p, `${a}→${b} 경로 없음`);

      // 총합 = 각 구간 주행시간 + 중간정차 dwell + 환승비용 + 최초승차 대기
      // 환승비용에는 이미 -dwell 이 반영되어 있으므로 여기서 또 빼지 않는다.
      const rideSec = p.legs.reduce((s, l) => s + l.runSec, 0);
      const stops = p.legs.reduce((s, l) => s + l.stops, 0);
      const dwellSec = (stops - 1) * G.dwell;
      const transferSec = p.legs.slice(1).reduce((s, l) => s + Math.max(0, G.transferWalk + G.waitSec(l.line) - G.dwell), 0);
      const boardSec = G.waitSec(p.legs[0].line);
      assert.equal(p.totalSec, rideSec + dwellSec + transferSec + boardSec,
        `${a}→${b} 구간합 불일치 (총 ${p.totalSec}s)`);
    }
  });

  test('톨러런스 0 이면 기존 minimax(완전탐색)와 같다', () => {
    const all = G.stations.map((s) => s.id);
    for (const names of [['강남', '노원', '인천'], ['수원', '홍대입구'], ['춘천', '광교', '사당']]) {
      const origins = names.map(sid);
      const got = G.findMeetingPoint(origins, { toleranceMin: 0, candidates: all });

      const results = origins.map((o) => G.dijkstra(o));
      let best = null;
      for (const s of G.stations) {
        const ts = results.map((r) => r.stationTime[s.id]);
        if (ts.some((t) => t >= 0x7fffffff)) continue;
        const max = Math.max(...ts), sum = ts.reduce((x, y) => x + y, 0);
        if (!best || max < best.max || (max === best.max && sum < best.sum)) best = { id: s.id, max, sum };
      }
      assert.equal(got.best.maxSec, best.max, names.join(','));
      assert.equal(got.best.sumSec, best.sum, names.join(','));
    }
  });

  test('동률 밴드: 밴드 정의와 평균 tie-break 가 정확하다', () => {
    const TOL = 4;
    for (const names of [['홍대입구', '잠실', '노원', '사당', '강남'], ['수원', '의정부', '인천'], ['부평', '노원']]) {
      const origins = names.map(sid);
      const got = G.findMeetingPoint(origins, { toleranceMin: TOL, topN: 400 });

      // 밴드 = max 가 [min_max, min_max + 톨러런스] 안인 후보
      const results = origins.map((o) => G.dijkstra(o));
      const pool = [...new Set([...G.hubIds, ...origins])];
      const scored = pool.map((id) => {
        const ts = results.map((r) => r.stationTime[id]);
        if (ts.some((t) => t >= 0x7fffffff)) return null;
        return { id, max: Math.max(...ts), sum: ts.reduce((x, y) => x + y, 0) };
      }).filter(Boolean);

      const minMax = Math.min(...scored.map((s) => s.max));
      const band = scored.filter((s) => s.max <= minMax + TOL * 60);
      const bestSum = Math.min(...band.map((s) => s.sum));

      assert.equal(got.selection.minMaxSec, minMax, `${names}: min_max`);
      assert.equal(got.selection.bandSize, band.length, `${names}: 밴드 크기`);
      assert.equal(got.best.sumSec, bestSum, `${names}: 밴드 안 최소 합계가 선택되어야 함`);
      assert.ok(got.best.maxSec <= minMax + TOL * 60, `${names}: 선택된 역이 밴드 밖`);
      assert.ok(got.best.inBand);
    }
  });

  test('밴드·합계가 같으면 요금이 싼 쪽을 고른다', () => {
    // 인위적으로 동점을 만들 수 없으므로 정렬 규칙 자체를 확인한다.
    const origins = ['강남', '노원', '인천'].map(sid);
    const r = G.findMeetingPoint(origins, { toleranceMin: 30, topN: 400 });
    const band = [r.best, ...r.alternatives].filter((x) => x.inBand);
    for (let i = 1; i < band.length; i++) {
      const a = band[i - 1], b = band[i];
      const ordered = a.sumSec < b.sumSec
        || (a.sumSec === b.sumSec && a.fareTotal <= b.fareTotal);
      assert.ok(ordered, `밴드 정렬 위반: ${a.station.name}(${a.sumSec}s,${a.fareTotal}원) → ${b.station.name}(${b.sumSec}s,${b.fareTotal}원)`);
    }
  });

  test('만나는 역은 환승역이거나 참여자 출발역이다', () => {
    const hubs = new Set(G.hubIds);
    for (const names of [['홍대입구', '잠실', '노원'], ['수원', '의정부'], ['춘천', '오이도']]) {
      const origins = names.map(sid);
      const r = G.findMeetingPoint(origins);
      assert.ok(hubs.has(r.best.station.id) || origins.includes(r.best.station.id),
        `${names}: ${r.best.station.name} 은 환승역도 출발역도 아님`);
    }
  });

  /* 회귀: 같은 역에서 출발하는 참여자들 */
  test('참여자가 모두 같은 역이면 그 역이 답이고 0분', () => {
    // 환승역 / 단일노선역 / 종점 / 경전철 — 후보 제한에 걸려도 답이 나와야 한다
    for (const name of ['건대입구', '신답', '오이도', '전대·에버랜드', '춘천']) {
      const id = sid(name);
      for (const n of [2, 3, 5]) {
        const r = G.findMeetingPoint(Array(n).fill(id));
        assert.ok(r, `${name} × ${n}명: 결과 없음`);
        assert.equal(r.best.station.id, id, `${name} × ${n}명`);
        assert.equal(r.best.maxSec, 0);
        assert.equal(r.best.fareTotal, 0, '안 움직이면 요금 0');
        assert.ok(r.best.routes.every((x) => x.path && x.path.legs.length === 0));
      }
    }
  });

  test('일부만 같은 역이어도 정상 계산된다', () => {
    const a = sid('강남'), b = sid('노원');
    const r = G.findMeetingPoint([a, a, b]);
    assert.ok(r);
    assert.equal(r.best.routes.length, 3);
    assert.equal(r.best.routes[0].sec, r.best.routes[1].sec, '같은 역 두 명은 소요시간이 같아야');
  });

  test('동점일 때 소요시간 합계로 tie-break 한다', () => {
    const origins = ['강남', '잠실', '사당'].map(sid);
    const r = G.findMeetingPoint(origins, { topN: 30 });
    const tied = [r.best, ...r.alternatives].filter((x) => x.maxSec === r.best.maxSec);
    for (let i = 1; i < tied.length; i++) {
      assert.ok(tied[i - 1].sumSec <= tied[i].sumSec, '동점 구간이 합계 오름차순이 아님');
    }
  });

  test('minimax 결과는 어떤 참여자의 출발역보다 나쁘지 않다', () => {
    // 후보에 각자의 출발역도 포함되므로, 최적해의 최대소요는
    // "누군가의 집 앞에서 보기"의 최대소요보다 항상 작거나 같아야 한다.
    const sets = [['강남', '노원', '인천'], ['수원', '의정부', '김포공항'], ['춘천', '광교', '홍대입구']];
    for (const names of sets) {
      const origins = names.map(sid);
      const r = G.findMeetingPoint(origins);
      assert.ok(r.best.maxSec <= r.worstPairwiseSec,
        `${names.join(',')}: minimax(${r.best.maxSec}) > 최악 집앞(${r.worstPairwiseSec})`);
    }
  });
});

/* ============================================================ B. 데이터 무결성 */
describe('B. 데이터 무결성', () => {
  test('전 노선이 하나로 연결되어 있다', () => {
    const r = G.dijkstra(sid('서울역'));
    const unreachable = G.stations.filter((s) => r.stationTime[s.id] >= 0x7fffffff);
    assert.equal(unreachable.length, 0, `고립역: ${unreachable.map((s) => s.name).join(', ')}`);
  });

  test('모든 역이 최소 1개 노선에 속하고, 모든 구간의 소요시간이 양수다', () => {
    for (const s of G.stations) assert.ok(s.lines.length >= 1, `${s.name} 노선 없음`);
    for (let u = 0; u < G.nodeCount; u++) {
      for (const e of G.adj[u]) assert.ok(e.cost >= 0, '음수 간선 비용');
    }
  });

  test('주요 환승역이 기대한 노선을 모두 갖는다', () => {
    const expect = {
      '서울역': ['1', '4', '경의중앙', '공항철도'],
      '김포공항': ['5', '9', '공항철도', '김포골드', '서해'],
      '왕십리': ['2', '5', '경의중앙', '수인분당'],
      '청량리': ['1', '경의중앙', '수인분당', '경춘'],
      '디지털미디어시티': ['6', '경의중앙', '공항철도'],
      '홍대입구': ['2', '경의중앙', '공항철도'],
      '신설동': ['1', '2', '우이신설'],
      '대곡': ['3', '경의중앙', '서해', 'GTX-A'],
      '샛강': ['9', '신림'],
      '고속터미널': ['3', '7', '9'],
    };
    for (const [name, lines] of Object.entries(expect)) {
      const s = G.findStations(name)[0];
      assert.ok(s, `${name} 없음`);
      for (const ln of lines) assert.ok(s.lines.includes(ln), `${name}에 ${ln} 누락 (실제: ${s.lines})`);
    }
  });

  test('동명이역이 잘못 병합되지 않았다', () => {
    // 5호선 양평(서울)과 경의중앙선 양평(양평군)은 서로 다른 역이다.
    const yp = G.findStations('양평');
    assert.equal(yp.length, 2, '양평역이 2개로 분리되어야 함');
    assert.ok(yp.some((s) => s.lines.includes('5')) && yp.some((s) => s.lines.includes('경의중앙')));
    // 2호선 신촌과 경의중앙선 신촌도 별개다.
    assert.equal(G.findStations('신촌').length, 2);
  });

  test('같은 이름의 역이 같은 노선에 중복 등장하지 않는다', () => {
    const seen = new Map();
    for (const s of G.stations) {
      for (const ln of s.lines) {
        const k = `${ln}|${s.name}`;
        assert.ok(!seen.has(k), `${ln} 노선에 '${s.name}' 중복`);
        seen.set(k, s.id);
      }
    }
  });

  test('실측 구간 비율과 규모가 기대 범위 안이다', () => {
    const c = G.meta.counts;
    assert.ok(c.stations > 600 && c.stations < 750, `역 수 ${c.stations}`);
    assert.ok(c.edges > 700 && c.edges < 900, `구간 수 ${c.edges}`);
    assert.ok(c.measuredEdges >= 260, `실측 구간 ${c.measuredEdges}`);
  });
});

/* ============================================================ C. 현실 대조 */
describe('C. 현실 대조 (보정에 쓰지 않은 홀드아웃)', () => {
  /* 아래 값은 실제 통행시간(각역정차 기준, 최초 승강장 대기 + 정차시간 포함)의 통상 범위.
     모델의 목적은 "누가 더 멀리서 오는가"를 가르는 것이므로 ±25% 를 허용한다.
     2호선 사례는 구간 주행시간이 전부 서울교통공사 실측값이라 사실상 산술 검산에 가깝다. */
  const CASES = [
    { from: '강남', to: '잠실', real: 14 },
    { from: '신도림', to: '강남', real: 27 },
    { from: '사당', to: '서울역', real: 19 },
    { from: '노원', to: '사당', real: 47 },
    { from: '홍대입구', to: '강남', real: 37 },
    { from: '수원', to: '서울역', real: 62 },
    { from: '인천', to: '서울역', real: 68 },
    { from: '오이도', to: '사당', real: 60 },
  ];

  for (const c of CASES) {
    test(`${c.from}→${c.to} ≈ ${c.real}분`, () => {
      const got = minutes(c.from, c.to);
      const err = Math.abs(got - c.real) / c.real;
      assert.ok(err <= 0.25,
        `${c.from}→${c.to}: 모델 ${got.toFixed(1)}분 vs 실제 ~${c.real}분 (오차 ${(err * 100).toFixed(0)}%)`);
    });
  }

  test('왕복 소요시간 차이는 대기시간 차이 범위 안이다', () => {
    // A→B 와 B→A 는 최초 승차 대기가 달라 완전히 같지는 않지만 크게 벌어져서도 안 된다.
    for (const [a, b] of [['강남', '노원'], ['인천', '수원'], ['춘천', '광교']]) {
      const d = Math.abs(minutes(a, b) - minutes(b, a));
      assert.ok(d <= 10, `${a}↔${b} 왕복 차이 ${d.toFixed(1)}분`);
    }
  });
});
