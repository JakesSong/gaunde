/**
 * 수도권 전철 경로 엔진
 *
 * 그래프 모델
 *   정점 = (역, 노선) 승강장.  같은 역이라도 노선이 다르면 다른 정점이다.
 *   간선 = 승차구간 | 환승
 *
 * 비용(초)
 *   승차   : 구간 주행시간 + DWELL           (도착역 정차시간)
 *   환승   : 도보 150초 + 배차간격/2 - DWELL (내리면 문 닫힘을 기다리지 않음)
 *   최초승차: 배차간격/2                      (승강장 대기)
 *   도착   : 마지막 DWELL 은 체감하지 않으므로 총합에서 1회 차감
 *
 * 위 정의 아래 모든 간선 비용이 음이 아니므로 다익스트라가 성립한다.
 */

import {
  TOLERANCE_MIN, TOLERANCE_MAX_MIN, toleranceMinFor, HUB_MIN_LINES, EXTRA_HUB_NAMES,
  DIVERSIFY_CANDIDATES, MODES, DEFAULT_MODE, MODE_SLACK_MIN,
} from './config.mjs';
import { fareFor, surchargeLines } from './fare.mjs';

/* --------------------------------------------------------------- 이진 힙 */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(key, val) {
    const a = this.a; a.push([key, val]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/* --------------------------------------------------------------- 그래프 */
export class MetroGraph {
  /** @param {object} data data/graph.json 의 내용 */
  constructor(data) {
    this.meta = data.meta;
    this.lines = data.lines;
    this.stations = data.stations;

    this.dwell = data.meta.model.dwellSec;
    this.transferWalk = data.meta.model.transferWalkSec;

    /* 동률 밴드 폭은 노선도의 실측률에서 나온다. 구간 주행시간의 3분의 2가 추정치인데
     * ±4분을 고정해 두는 건 실측 100% 를 가정한 값이었다. (config.mjs 주석 참고) */
    this.measuredRatio = data.meta?.counts?.measuredRatio;
    this.toleranceMin = toleranceMinFor(this.measuredRatio);

    /* 역 이름 색인 (동명이역은 여러 id 를 가진다) */
    this.byName = new Map();
    for (const s of this.stations) {
      const k = normalizeName(s.name);
      if (!this.byName.has(k)) this.byName.set(k, []);
      this.byName.get(k).push(s.id);
    }

    /* 정점: (stationId, line) */
    this.nodeId = new Map();      // `${stationId}|${line}` -> node index
    this.nodeStation = [];        // node index -> stationId
    this.nodeLine = [];           // node index -> line key
    this.stationNodes = new Map(); // stationId -> node index[]
    for (const s of this.stations) {
      const list = [];
      for (const ln of s.lines) {
        const idx = this.nodeStation.length;
        this.nodeId.set(`${s.id}|${ln}`, idx);
        this.nodeStation.push(s.id);
        this.nodeLine.push(ln);
        list.push(idx);
      }
      this.stationNodes.set(s.id, list);
    }
    this.nodeCount = this.nodeStation.length;

    /* 인접 리스트 (CSR 유사 구조) */
    const adj = Array.from({ length: this.nodeCount }, () => []);

    for (const e of data.edges) {
      const u = this.nodeId.get(`${e.a}|${e.line}`);
      const v = this.nodeId.get(`${e.b}|${e.line}`);
      if (u === undefined || v === undefined) continue;
      const cost = e.sec + this.dwell;
      adj[u].push({ to: v, cost, kind: 'ride', line: e.line, runSec: e.sec, km: e.km, src: e.src });
      adj[v].push({ to: u, cost, kind: 'ride', line: e.line, runSec: e.sec, km: e.km, src: e.src });
    }

    for (const [, nodes] of this.stationNodes) {
      if (nodes.length < 2) continue;
      for (const u of nodes) for (const v of nodes) {
        if (u === v) continue;
        const cost = Math.max(0, this.transferWalk + this.waitSec(this.nodeLine[v]) - this.dwell);
        adj[u].push({ to: v, cost, kind: 'transfer', line: this.nodeLine[v] });
      }
    }
    this.adj = adj;

    /* 만날 역 후보 — 환승역 + 예외 목록.
     * 출발역 선택은 제한하지 않는다. 여기 걸리는 건 "만나는 역" 뿐이다. */
    const extra = new Set(EXTRA_HUB_NAMES.map(normalizeName));
    this.hubIds = this.stations
      .filter((s) => s.lines.length >= HUB_MIN_LINES || extra.has(normalizeName(s.name)))
      .map((s) => s.id);
  }

  /** 해당 노선 승강장에서의 평균 대기시간(초) = 배차간격/2 */
  waitSec(lineKey) {
    return Math.round((this.lines[lineKey]?.headwayMin ?? 6) * 60 / 2);
  }

  /**
   * 자체 그래프로 낸 소요시간의 불확실성(초).
   *
   * 화면에 "N분" 만 적으면 확정된 시각표처럼 읽힌다. 실제로는 요금만 근사치라고
   * 써 있고 시간은 확정처럼 보인다는 지적이 있었다.
   *
   * 가장 큰 흔들림은 배차간격이다 — 평일 낮 대표값 하나로 고정해 두었으므로
   * 실제 대기는 0 ~ 배차간격 사이에서 움직인다. 그래서 타는 구간(leg)마다
   * 배차/2 를 불확실성으로 잡아 더한다. 여기에 잡히지 않는 오차(급행 미반영,
   * 추정 구간의 직선거리 근사, 계통 분기 대기)는 이 값 밖이므로,
   * 화면 문구는 항상 "대략" 으로 적는다.
   *
   * 최소 3분 — 1분 단위로 딱 떨어지는 숫자를 내면 정밀해 보이는 역효과가 난다.
   * 최대 15분 — 배차가 긴 광역노선에서 값이 커져 오히려 무의미해지는 걸 막는다.
   */
  estimateMarginSec(path) {
    if (!path || !path.legs || !path.legs.length) return 0;
    const wait = path.legs.reduce((s, l) => s + this.waitSec(l.line), 0);
    return Math.min(15 * 60, Math.max(3 * 60, wait));
  }

  /** 이름으로 역 찾기. 동명이역이면 여러 개를 돌려준다. */
  findStations(name) {
    return (this.byName.get(normalizeName(name)) || []).map((id) => this.stations[id]);
  }

  resolveStationId(nameOrId) {
    if (typeof nameOrId === 'number') return this.stations[nameOrId] ? nameOrId : null;
    const hit = this.findStations(nameOrId);
    return hit.length ? hit[0].id : null;
  }

  /**
   * 출발역에서 모든 역까지의 소요시간(초).
   * @returns {{time:Int32Array, prev:Int32Array, prevEdge:Array}} time 은 역 id 색인
   */
  dijkstra(originStationId) {
    const INF = 0x7fffffff;
    const dist = new Int32Array(this.nodeCount).fill(INF);
    const prev = new Int32Array(this.nodeCount).fill(-1);
    const prevEdge = new Array(this.nodeCount).fill(null);
    const heap = new MinHeap();

    for (const u of this.stationNodes.get(originStationId) || []) {
      dist[u] = this.waitSec(this.nodeLine[u]);   // 최초 승강장 대기
      heap.push(dist[u], u);
    }

    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u]) continue;
      for (const e of this.adj[u]) {
        const nd = d + e.cost;
        if (nd < dist[e.to]) {
          dist[e.to] = nd; prev[e.to] = u; prevEdge[e.to] = e;
          heap.push(nd, e.to);
        }
      }
    }

    /* 역 단위로 접기: 그 역의 승강장 중 최소값, 마지막 dwell 1회 차감 */
    const stationTime = new Int32Array(this.stations.length).fill(INF);
    const stationNode = new Int32Array(this.stations.length).fill(-1);
    for (let u = 0; u < this.nodeCount; u++) {
      if (dist[u] === INF) continue;
      const s = this.nodeStation[u];
      const t = s === originStationId ? 0 : Math.max(0, dist[u] - this.dwell);
      if (t < stationTime[s]) { stationTime[s] = t; stationNode[s] = u; }
    }
    return { dist, prev, prevEdge, stationTime, stationNode };
  }

  /** 경로 복원 — 노선별 구간으로 묶어서 돌려준다 */
  buildPath(result, originStationId, destStationId) {
    if (originStationId === destStationId) return { totalSec: 0, legs: [], transfers: 0 };
    const end = result.stationNode[destStationId];
    if (end < 0 || result.stationTime[destStationId] >= 0x7fffffff) return null;

    const chain = [];
    for (let u = end; u !== -1; u = result.prev[u]) chain.push({ node: u, edge: result.prevEdge[u] });
    chain.reverse();

    const legs = [];
    let transfers = 0;
    for (let i = 1; i < chain.length; i++) {
      const { node, edge } = chain[i];
      const stationId = this.nodeStation[node];
      if (edge.kind === 'transfer') { transfers++; continue; }
      const last = legs[legs.length - 1];
      if (last && last.line === edge.line) {
        last.to = this.stations[stationId].name;
        last.toId = stationId;
        last.stops++;
        last.runSec += edge.runSec;
        last.km += edge.km;
        if (edge.src === 'e') last.hasEstimate = true;
      } else {
        const fromId = this.nodeStation[chain[i - 1].node];
        legs.push({
          line: edge.line,
          lineName: this.lines[edge.line].name,
          color: this.lines[edge.line].color,
          from: this.stations[fromId].name, fromId,
          to: this.stations[stationId].name, toId: stationId,
          stops: 1, runSec: edge.runSec, km: edge.km,
          hasEstimate: edge.src === 'e',
        });
      }
    }
    return { totalSec: result.stationTime[destStationId], legs, transfers };
  }

  /** 후보 역별로 (최대, 합계) 소요시간을 매긴다. 한 명이라도 못 가면 후보에서 뺀다. */
  scoreCandidates(candidateIds, results) {
    const INF = 0x7fffffff;
    const out = [];
    for (const c of candidateIds) {
      let max = 0, sum = 0, ok = true;
      for (const r of results) {
        const t = r.stationTime[c];
        if (t >= INF) { ok = false; break; }
        if (t > max) max = t;
        sum += t;
      }
      /* 요금·환승은 경로를 복원해야 나온다. fillRoutes 가 채우기 전까지의 자리만 잡아둔다 —
         아직 안 채운 값이 정렬에 섞여 들어가도 0 으로 조용히 이기지 않게 0 이 아닌 건 없다. */
      if (ok) {
        out.push({
          stationId: c, maxSec: max, sumSec: sum, paths: null,
          fareTotal: 0, fareMax: 0, fares: null, transfersTotal: 0, transfersMax: 0,
        });
      }
    }
    return out;
  }

  /**
   * 후보 하나에 대해 참여자별 경로·요금·환승수를 채운다.
   *
   * 요금과 환승은 경로를 복원해야 알 수 있다. 시간 모드만 쓰던 때는 동률 밴드 안에서만
   * 불렀지만, 비용·환승 모드는 후보 풀 전체의 값을 알아야 "진짜 최적" 을 낼 수 있다.
   * 후보 130곳 × 참여자 5명 전부 채워도 4ms 라 아끼는 의미가 없다 (실측).
   *
   * 요금은 사람마다 따로 낸다 — 탄 노선의 별도운임(신분당선 1,000원 등)이 개인별로
   * 붙기 때문이다. 합계는 그 개인별 값의 합이라, 화면의 1인 요금과 근거가 어긋나지 않는다.
   */
  fillRoutes(entry, results, originIds) {
    entry.paths = originIds.map((oid, i) => this.buildPath(results[i], oid, entry.stationId));
    entry.fares = entry.paths.map((p) => {
      if (!p || !p.legs.length) return 0;                       // 안 움직이면 0원
      const km = p.legs.reduce((s, l) => s + l.km, 0);
      const lines = [...new Set(p.legs.map((l) => l.line))];
      return fareFor(km, lines, this.lines);
    });
    entry.fareTotal = entry.fares.reduce((a, b) => a + b, 0);
    entry.fareMax = entry.fares.length ? Math.max(...entry.fares) : 0;
    const hops = entry.paths.map((p) => (p ? p.transfers : 0));
    entry.transfersTotal = hops.reduce((a, b) => a + b, 0);
    entry.transfersMax = hops.length ? Math.max(...hops) : 0;
    return entry;
  }

  /**
   * 중간지점 선택.
   *
   * 순수 minimax 는 1분 차이로 순위가 뒤집혀 가까운 사람이 괜히 더 멀리 나가거나
   * 한 명만 손해 보는 결과가 나온다. 그래서 두 단계로 고른다.
   *
   *   1) 후보별 max(참여자 소요시간) 을 구하고, 그중 최솟값 min_max 를 찾는다.
   *   2) [min_max, min_max + 톨러런스] 안에 드는 역을 "사실상 동률" 로 묶고,
   *      그 안에서 합계(=평균) 소요시간이 가장 낮은 역을 고른다.
   *      합계도 같으면 요금이 싼 쪽, 그래도 같으면 최댓값이 작은 쪽.
   *
   * 톨러런스 0 이면 기존 minimax 와 정확히 같아진다.
   *
   * @param {number[]} originIds 참여자 출발역 id (중복 허용)
   * @param {object} [opts]
   * @param {number[]} [opts.candidates]  후보 역 id (기본: 환승역 등 hubIds)
   * @param {number}   [opts.toleranceMin] 동률 밴드 폭(분)
   * @param {number}   [opts.topN]        상위 몇 개를 돌려줄지
   */
  findMeetingPoint(originIds, opts = {}) {
    const topN = opts.topN ?? 5;
    const modes = normalizeModes(opts.modes ?? opts.mode);
    const primaryMode = modes[0];
    /* 밴드 폭은 실측률에서 나온다. opts.toleranceMin 을 주면 그게 이긴다 (테스트·조정용). */
    const toleranceSec = Math.round((opts.toleranceMin ?? this.toleranceMin ?? TOLERANCE_MIN) * 60);
    const slackSec = Math.round((opts.modeSlackMin ?? MODE_SLACK_MIN) * 60);
    const INF = 0x7fffffff;
    const results = originIds.map((id) => this.dijkstra(id));

    /* 기본 후보 = 환승역 + 참여자 본인 출발역.
     *
     * 출발역을 넣는 이유: 환승역만 두면 "다 같이 한 정거장씩 나와서 아무 역에서 만나기" 가
     * 정답이 되는 경우가 생긴다. 이미 같은 동네에 있는 사람들에게는 그 동네가 답이어야 한다.
     * 덕분에 "누군가의 집 앞에서 만나기보다 나쁘지 않다" 는 성질도 유지된다.
     *
     * 아무도 못 가는 상황이면 전체 역으로 넓혀 답은 반드시 낸다. */
    let usedFallback = false;
    const hubSet = new Set(this.hubIds);
    /* 출발역이 실제로 후보에 들어갔는지 세어 응답에 싣는다.
       "출발역이 정답인 경우를 못 잡는다" 는 의심이 반복돼서, 말로 답하지 않고
       숫자로 답할 수 있게 해 둔다.
         origins      = 후보로 들어간 서로 다른 출발역 수 (전부 후보다)
         originsNotHub = 그중 환승역이 아니어서 출발역이 아니었다면 못 들어왔을 역 수 */
    const uniqOrigins = [...new Set(originIds)];
    const originsNotHub = uniqOrigins.filter((id) => !hubSet.has(id)).length;
    const defaultCandidates = [...new Set([...this.hubIds, ...originIds])];
    let scored = this.scoreCandidates(opts.candidates ?? defaultCandidates, results);
    if (!scored.length) {
      usedFallback = true;
      scored = this.scoreCandidates(this.stations.map((s) => s.id), results);
    }
    if (!scored.length) return null;

    let minMax = Infinity;
    for (const s of scored) if (s.maxSec < minMax) minMax = s.maxSec;

    /* 경로 복원이 필요한 범위.
     *
     * 시간 모드만 쓸 때는 요금이 밴드 안 tie-break 에만 쓰였으므로 밴드만 채웠다.
     * 비용·환승 모드는 후보 풀 전체의 요금·환승수를 알아야 "그 기준의 진짜 최적" 이
     * 나온다 — 시간으로 추린 좁은 목록만 다시 정렬하면 답이 아니라 근사가 된다.
     * 130곳 전부 채워도 4ms 라 아낄 이유가 없다. */
    const needsFullRoutes = modes.some((m) => m !== 'time');
    const timeBand = scored.filter((s) => s.maxSec <= minMax + toleranceSec);
    for (const c of (needsFullRoutes ? scored : timeBand)) this.fillRoutes(c, results, originIds);

    const linesOf = (e) => this.stations[e.stationId].lines;
    const dirOf = this.directionKeyFor(originIds, (e) => this.stations[e.stationId]);
    const diversify = opts.diversify ?? DIVERSIFY_CANDIDATES;

    const decorate = (entry, cutoffSec) => {
      if (!entry.paths) this.fillRoutes(entry, results, originIds);
      return {
        station: this.stations[entry.stationId],
        maxSec: entry.maxSec,
        sumSec: entry.sumSec,
        avgSec: Math.round(entry.sumSec / originIds.length),
        fareTotal: entry.fareTotal,
        fareAvg: Math.round(entry.fareTotal / originIds.length),
        transfersTotal: entry.transfersTotal,
        transfersMax: entry.transfersMax,
        inBand: entry.maxSec <= cutoffSec,
        routes: originIds.map((oid, i) => {
          const path = entry.paths[i];
          const km = path ? path.legs.reduce((s, l) => s + l.km, 0) : 0;
          const lines = path ? [...new Set(path.legs.map((l) => l.line))] : [];
          return {
            originId: oid,
            origin: this.stations[oid].name,
            sec: results[i].stationTime[entry.stationId],
            fare: fareFor(km, lines, this.lines),
            surcharges: surchargeLines(lines, this.lines),
            /* 그래프 시간이 화면에 그대로 나갈 때 붙일 오차 폭. ODsay 값으로 덮이면 쓰이지 않는다. */
            marginSec: this.estimateMarginSec(path),
            path,
          };
        }),
      };
    };

    const baseSelection = {
      minMaxSec: minMax,
      candidatePool: usedFallback ? 'all-stations' : 'hubs+origins',
      candidateCount: scored.length,
      /* 후보가 어디서 왔는지. 출발역이 후보에 들어가 있다는 걸 응답에서 확인할 수 있어야 한다. */
      candidateSources: { hubs: this.hubIds.length, origins: uniqOrigins.length, originsNotHub },
      /* 밴드 폭이 어디서 나온 값인지 — "왜 ±5분인가" 를 화면에서 답할 수 있어야 한다 */
      toleranceBasis: {
        measuredRatio: this.measuredRatio ?? null,
        baseMin: TOLERANCE_MIN,
        maxMin: TOLERANCE_MAX_MIN,
        derived: opts.toleranceMin === undefined,
      },
    };

    const byMode = {};
    for (const mode of modes) {
      const r = rankByMode(scored, mode, {
        toleranceSec, slackSec, topN, diversify, linesOf, dirOf,
      });
      byMode[mode] = {
        best: decorate(r.list[0], r.cutoffSec),
        alternatives: r.list.slice(1, topN).map((e) => decorate(e, r.cutoffSec)),
        selection: {
          ...baseSelection,
          mode,
          toleranceMin: toleranceSec / 60,
          /* time 모드에서는 밴드 = 동률 밴드. 비용·환승 모드에서는 "시간을 이만큼까지
             양보한 후보 풀" 이다. 이름은 그대로 두어 기존 화면·테스트가 안 깨지게 한다. */
          bandSize: r.poolSize,
          modeCutoffSec: r.cutoffSec,
          modeSlackMin: mode === 'time' ? 0 : slackSec / 60,
          diversity: { grouped: r.grouped, reordered: r.reordered },
        },
      };
    }

    const primary = byMode[primaryMode];
    return {
      best: primary.best,
      alternatives: primary.alternatives,
      selection: primary.selection,
      /** 모드별 결과 전체. 화면 토글이 재계산 없이 갈아끼운다. */
      modes: byMode,
      /** 각자 집 앞에서 보자고 할 때의 최악 소요시간 — 비교용 */
      worstPairwiseSec: (() => {
        let w = 0;
        for (let i = 0; i < originIds.length; i++) {
          for (const oid of originIds) {
            const t = results[i].stationTime[oid];
            if (t < INF && t > w) w = t;
          }
        }
        return w;
      })(),
    };
  }

  /**
   * 후보 역이 참여자들의 "무게중심" 에서 어느 쪽인지 — 후보 방향 분산용.
   *
   * 다른 후보 3곳이 전부 같은 방향에 몰리면 고를 게 없다. 노선만 섞어서는
   * 이게 안 잡힌다 (같은 동네에서 노선만 다른 역이 흔하다).
   * 좌표가 없는 역은 null 을 돌려주고, 그런 역은 방향 규칙에서 빠진다.
   */
  directionKeyFor(originIds, stationOf) {
    const pts = originIds.map((id) => this.stations[id]).filter((s) => s && Number.isFinite(s.lat));
    if (!pts.length) return null;
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng0 = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    const SECTORS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
    return (entry) => {
      const s = stationOf(entry);
      if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return null;
      /* 경도 1도는 위도 1도보다 짧다 — 위도 37.5°에서 cos 보정을 넣어야 방위가 안 틀어진다 */
      const dx = (s.lng - lng0) * Math.cos(lat0 * Math.PI / 180);
      const dy = s.lat - lat0;
      /* 중심에서 3km 안쪽은 방향을 말할 수 없다. 한 덩어리로 묶는다. */
      if (Math.hypot(dx, dy) * 111 < 3) return 'C';
      const a = Math.atan2(dy, dx);                       // -π ~ π, 동쪽이 0
      return SECTORS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
    };
  }
}

/* --------------------------------------------------------------- 모드별 정렬 */

/**
 * 모드별 1차 정렬 규칙. 모두 "작을수록 좋다".
 *
 *   time      합계(=평균) → 요금 → 최댓값        (기존 규칙 그대로)
 *   fare      요금 합계 → 시간 합계 → 최댓값
 *   transfers 환승 합계 → 한 사람 최대 환승 → 시간 합계 → 요금
 *
 * 비용·환승은 값이 성기다 (요금은 100원, 환승은 1회 단위). 동률이 흔하고,
 * 그 동률을 시간으로 깨기 때문에 결과가 엉뚱한 곳으로 튀지 않는다.
 */
const MODE_COMPARATORS = {
  time: (a, b) => a.sumSec - b.sumSec || a.fareTotal - b.fareTotal || a.maxSec - b.maxSec,
  fare: (a, b) => a.fareTotal - b.fareTotal || a.sumSec - b.sumSec || a.maxSec - b.maxSec,
  transfers: (a, b) => a.transfersTotal - b.transfersTotal || a.transfersMax - b.transfersMax
    || a.sumSec - b.sumSec || a.fareTotal - b.fareTotal,
};

/** 요청된 모드 목록을 정리한다. 알 수 없는 값은 조용히 버리고, 비면 기본(time) 하나. */
export function normalizeModes(input) {
  const raw = input === undefined || input === null ? [] : [].concat(input);
  const out = [];
  for (const m of raw) if (MODES.includes(m) && !out.includes(m)) out.push(m);
  return out.length ? out : [DEFAULT_MODE];
}

/**
 * 후보를 한 모드 기준으로 줄 세운다.
 *
 * 두 단계는 모드와 무관하게 같다.
 *   1) "가장 먼 사람의 시간" 최선값(min_max)에서 얼마까지 양보할지 정해 후보 풀을 자른다.
 *      time 모드는 동률 밴드(±톨러런스), 비용·환승 모드는 시간 여유(MODE_SLACK_MIN).
 *   2) 그 안에서 모드의 목적함수로 정렬한다.
 *
 * 자르지 않으면 비용 모드는 늘 "누군가의 집 앞"(그 사람 요금 0원)이 이기고,
 * 환승 모드는 외곽 직통역이 이긴다. 제약을 두는 편이 답이 되는 유일한 길이다.
 *
 * 풀 밖 후보는 뒤에 시간순으로 붙는다 — 목록에서 사라지지는 않는다.
 */
export function rankByMode(entries, mode, opts = {}) {
  const { toleranceSec = 0, slackSec = 0, topN = 5, diversify = false, linesOf, dirOf } = opts;
  const cmp = MODE_COMPARATORS[mode] || MODE_COMPARATORS.time;
  let minMax = Infinity;
  for (const e of entries) if (e.maxSec < minMax) minMax = e.maxSec;
  const cutoffSec = minMax + (mode === 'time' ? toleranceSec : slackSec);

  const pool = [], rest = [];
  for (const e of entries) (e.maxSec <= cutoffSec ? pool : rest).push(e);
  pool.sort(cmp);
  rest.sort((a, b) => a.maxSec - b.maxSec || a.sumSec - b.sumSec);

  const div = diversify && linesOf
    ? diversifyRanked(pool, topN, linesOf, dirOf)
    : { list: pool, grouped: 0, reordered: false };

  return {
    list: div.list.concat(rest),
    minMaxSec: minMax,
    cutoffSec,
    poolSize: pool.length,
    grouped: div.grouped,
    reordered: div.reordered,
  };
}

/**
 * 동률 밴드 안에서 후보를 서로 다른 노선으로 섞는다.
 *
 * 왜: 밴드 안은 "사실상 동률" 인데 합계 순으로만 줄 세우면 이웃한 같은 노선 역들이
 * 나란히 1·2·3위를 차지한다. 실제로 후보 3개가 전부 4호선이라 고를 게 없다는
 * 피드백이 왔다. 시간 차가 없는 자리에서 순위를 조금 양보하고 노선을 섞으면
 * "다른 선택지" 가 생긴다.
 *
 * 노선만 섞어서는 방향 쏠림이 안 잡힌다 — 같은 동네에서 노선만 다른 역이 흔해서,
 * 후보 3곳이 전부 강남 쪽인 판이 그대로 남는다. 그래서 dirOf 를 주면 방위(참여자
 * 무게중심 기준 8방위)도 같이 본다.
 *
 * 규칙
 *   - 1위는 절대 건드리지 않는다. 추천은 그대로 추천이어야 한다.
 *   - 노선 구성이 완전히 같은 역(예: 같은 노선의 이웃역)은 대표 하나만 남긴다.
 *   - 2위부터 두 번 훑는다.
 *       1차: 새 노선 '그리고' 새 방향을 함께 데려오는 후보  (가장 잘 섞이는 것부터)
 *       2차: 새 노선 '또는' 새 방향 중 하나라도 데려오는 후보
 *   - 자리가 남으면 원래 순위대로 메운다 — 다양성 때문에 후보 수가 줄지는 않는다.
 *
 * dirOf 를 주지 않으면 1차는 아무것도 못 고르고 2차가 "새 노선" 규칙이 되어,
 * 방향을 넣기 전과 정확히 같게 동작한다.
 *
 * 밴드 밖 후보는 넘기지 않는다(호출부에서 concat). 그쪽은 실제로 더 나쁜 후보라
 * 순서를 흔들면 안 된다.
 *
 * @param {Array} band     밴드 안 후보 (이미 순위대로 정렬됨)
 * @param {number} topN    화면에 보여줄 후보 수
 * @param {(e:any)=>string[]} linesOf  후보에서 노선 목록을 꺼내는 함수
 * @param {(e:any)=>(string|null)} [dirOf] 후보의 방위 키 (없으면 방향 규칙을 끈다)
 * @returns {{list:Array, grouped:number, reordered:boolean}}
 */
export function diversifyRanked(band, topN, linesOf, dirOf) {
  const none = { list: band, grouped: 0, reordered: false };
  if (!Array.isArray(band) || band.length <= 2 || topN <= 1) return none;

  const sigOf = (e) => [...new Set(linesOf(e) || [])].sort().join('+');
  const dirKey = (e) => (dirOf ? dirOf(e) : null);
  const picked = [band[0]];
  const taken = new Set([0]);
  const used = new Set(linesOf(band[0]) || []);
  const seen = new Set([sigOf(band[0])]);
  const dirs = new Set([dirKey(band[0])].filter((d) => d !== null));

  const sweep = (strict) => {
    for (let i = 1; i < band.length && picked.length < topN; i++) {
      if (taken.has(i)) continue;
      const e = band[i];
      const lines = linesOf(e) || [];
      if (seen.has(sigOf(e))) continue;                  // 노선 구성이 똑같은 역은 대표 하나만
      const d = dirKey(e);
      const newLine = lines.some((l) => !used.has(l));
      const newDir = d !== null && !dirs.has(d);
      if (strict ? !(newLine && newDir) : !(newLine || newDir)) continue;
      picked.push(e); taken.add(i); seen.add(sigOf(e));
      for (const l of lines) used.add(l);
      if (d !== null) dirs.add(d);
    }
  };
  sweep(true);
  sweep(false);

  const list = picked.concat(band.filter((_, i) => !taken.has(i)));
  /* 머리(=화면에 보일 자리)를 채우려고 지나친 후보 수. 뒤에 남은 후보는 세지 않는다 —
     그건 다양성이 아니라 그냥 topN 때문에 안 보이는 것이다. */
  const lastPicked = Math.max(...taken);
  return {
    list,
    grouped: lastPicked + 1 - picked.length,
    reordered: list.some((e, i) => e !== band[i]),
  };
}

export function normalizeName(raw) {
  return String(raw || '').trim()
    .replace(/\(.*?\)/g, '')
    .replace(/[\s·.\-–]/g, '')
    .replace(/역$/, '');
}

export function fmtMin(sec) { return Math.round(sec / 60); }
