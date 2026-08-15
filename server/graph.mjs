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

import { TOLERANCE_MIN, HUB_MIN_LINES, EXTRA_HUB_NAMES, DIVERSIFY_CANDIDATES } from './config.mjs';
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
      if (ok) out.push({ stationId: c, maxSec: max, sumSec: sum, fareTotal: 0, paths: null });
    }
    return out;
  }

  /** 후보 하나에 대해 참여자별 경로와 요금을 채운다 (동률 밴드 안에서만 부른다) */
  fillRoutes(entry, results, originIds) {
    entry.paths = originIds.map((oid, i) => this.buildPath(results[i], oid, entry.stationId));
    entry.fareTotal = entry.paths.reduce((sum, p) => {
      if (!p || !p.legs.length) return sum;
      const km = p.legs.reduce((s, l) => s + l.km, 0);
      const lines = [...new Set(p.legs.map((l) => l.line))];
      return sum + fareFor(km, lines, this.lines);
    }, 0);
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
    const toleranceSec = Math.round((opts.toleranceMin ?? TOLERANCE_MIN) * 60);
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

    const band = [], rest = [];
    for (const s of scored) (s.maxSec <= minMax + toleranceSec ? band : rest).push(s);

    /* 요금은 경로를 복원해야 알 수 있으므로 밴드 안에서만 계산한다 */
    for (const c of band) this.fillRoutes(c, results, originIds);

    band.sort((a, b) => a.sumSec - b.sumSec || a.fareTotal - b.fareTotal || a.maxSec - b.maxSec);
    rest.sort((a, b) => a.maxSec - b.maxSec || a.sumSec - b.sumSec);

    /* 밴드 안(=사실상 동률)에서만 노선을 섞는다. 1위는 그대로 둔다.
       opts.diversify=false 로 끄면 순수 정렬 규칙(합계→요금→최댓값)만 남는다 —
       그 규칙 자체를 검사하는 테스트가 다양성 재배열과 뒤엉키지 않게 하기 위한 문이다. */
    const div = (opts.diversify ?? DIVERSIFY_CANDIDATES)
      ? diversifyRanked(band, topN, (e) => this.stations[e.stationId].lines)
      : { list: band, grouped: 0, reordered: false };
    const ranked = div.list.concat(rest);

    const decorate = (entry) => {
      if (!entry.paths) this.fillRoutes(entry, results, originIds);
      return {
        station: this.stations[entry.stationId],
        maxSec: entry.maxSec,
        sumSec: entry.sumSec,
        avgSec: Math.round(entry.sumSec / originIds.length),
        fareTotal: entry.fareTotal,
        fareAvg: Math.round(entry.fareTotal / originIds.length),
        inBand: entry.maxSec <= minMax + toleranceSec,
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

    return {
      best: decorate(ranked[0]),
      alternatives: ranked.slice(1, topN).map(decorate),
      selection: {
        toleranceMin: toleranceSec / 60,
        minMaxSec: minMax,
        bandSize: band.length,
        candidatePool: usedFallback ? 'all-stations' : 'hubs+origins',
        candidateCount: scored.length,
        /* 후보가 어디서 왔는지. 출발역이 후보에 들어가 있다는 걸 응답에서 확인할 수 있어야 한다. */
        candidateSources: { hubs: this.hubIds.length, origins: uniqOrigins.length, originsNotHub },
        diversity: { grouped: div.grouped, reordered: div.reordered },
      },
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
}

/**
 * 동률 밴드 안에서 후보를 서로 다른 노선으로 섞는다.
 *
 * 왜: 밴드 안은 "사실상 동률" 인데 합계 순으로만 줄 세우면 이웃한 같은 노선 역들이
 * 나란히 1·2·3위를 차지한다. 실제로 후보 3개가 전부 4호선이라 고를 게 없다는
 * 피드백이 왔다. 시간 차가 없는 자리에서 순위를 조금 양보하고 노선을 섞으면
 * "다른 선택지" 가 생긴다.
 *
 * 규칙
 *   - 1위는 절대 건드리지 않는다. 추천은 그대로 추천이어야 한다.
 *   - 2위부터는 아직 안 나온 노선을 하나라도 데려오는 후보를 먼저 채운다.
 *   - 노선 구성이 완전히 같은 역(예: 같은 노선의 이웃역)은 대표 하나만 남긴다.
 *   - 자리가 남으면 원래 순위대로 메운다 — 다양성 때문에 후보 수가 줄지는 않는다.
 *
 * 밴드 밖 후보는 넘기지 않는다(호출부에서 concat). 그쪽은 실제로 더 나쁜 후보라
 * 순서를 흔들면 안 된다.
 *
 * @param {Array} band     밴드 안 후보 (이미 순위대로 정렬됨)
 * @param {number} topN    화면에 보여줄 후보 수
 * @param {(e:any)=>string[]} linesOf  후보에서 노선 목록을 꺼내는 함수
 * @returns {{list:Array, grouped:number, reordered:boolean}}
 */
export function diversifyRanked(band, topN, linesOf) {
  const none = { list: band, grouped: 0, reordered: false };
  if (!Array.isArray(band) || band.length <= 2 || topN <= 1) return none;

  const sigOf = (e) => [...new Set(linesOf(e) || [])].sort().join('+');
  const picked = [band[0]];
  const taken = new Set([0]);
  const used = new Set(linesOf(band[0]) || []);
  const seen = new Set([sigOf(band[0])]);
  let grouped = 0;

  for (let i = 1; i < band.length && picked.length < topN; i++) {
    const e = band[i];
    const lines = linesOf(e) || [];
    if (seen.has(sigOf(e)) || !lines.some((l) => !used.has(l))) { grouped++; continue; }
    picked.push(e); taken.add(i); seen.add(sigOf(e));
    for (const l of lines) used.add(l);
  }

  const list = picked.concat(band.filter((_, i) => !taken.has(i)));
  return { list, grouped, reordered: list.some((e, i) => e !== band[i]) };
}

export function normalizeName(raw) {
  return String(raw || '').trim()
    .replace(/\(.*?\)/g, '')
    .replace(/[\s·.\-–]/g, '')
    .replace(/역$/, '');
}

export function fmtMin(sec) { return Math.round(sec / 60); }
