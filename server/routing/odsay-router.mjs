/**
 * ODsay 어댑터 — 대중교통(버스+지하철) 통합 길찾기.
 *
 * ODSAY_KEY 가 있을 때만 만들어진다. 키는 process.env 로만 받고
 * 코드·로그·에러 메시지 어디에도 남기지 않는다.
 *
 * ── 왜 후보를 다 물어보지 않는가
 *   무료 쿼터가 하루 1,000회다. 후보 역이 130개라 참여자 5명이면 650회,
 *   한 번의 결과 계산으로 하루치를 다 써버린다. 그래서 두 단계로 나눈다.
 *
 *     1) 공짜인 지하철 그래프로 후보를 ODSAY.shortlist 개까지 추린다.
 *     2) 추린 후보 × 참여자만 ODsay 에 물어보고, 실제 시간·요금으로 다시 순위를 매긴다.
 *
 *   버스가 빨라서 그래프 상위권 밖으로 밀린 역은 놓칠 수 있다.
 *   쿼터를 지키면서 실제 소요시간을 반영하는 절충이다.
 *
 * ── 실패했을 때
 *   호출이 깨진 역쌍만 조용히 그래프 값으로 되돌린다. 전체가 죽지 않는다.
 */
import { GraphRouter } from './graph-router.mjs';
import { ODSAY } from '../config.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 동시 실행 수를 제한하며 순회한다 (외부 의존성 없이) */
async function mapLimit(items, limit, fn) {
  const n = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }));
}

export class OdsayRouter extends GraphRouter {
  constructor({ graph, store, apiKey }) {
    super({ graph });
    this.store = store;

    /* ODsay 가 발급하는 키에는 URL 인코딩이 필요한 문자가 들어간다.
     * 이미 인코딩된 키를 그대로 넣으면 URLSearchParams 가 한 번 더 인코딩해
     * 인증이 깨진다. 인코딩된 형태로 보이면 한 번 풀어둔다. */
    this.apiKey = decodeIfEncoded(apiKey);

    this.stats = { calls: 0, ok: 0, failed: 0, cacheHits: 0, lastError: null };
    this.liveOk = false;    // ODsay 에서 온 값이 실제로 쓰이고 있는가
  }

  get name() { return this.liveOk ? 'odsay+subway' : 'subway-graph (odsay-pending)'; }

  get description() {
    return this.liveOk
      ? 'ODsay 대중교통 길찾기(버스+지하철) + 지하철 그래프 보완'
      : 'ODSAY_KEY 는 있으나 아직 ODsay 응답을 받지 못해 지하철 그래프로 답한다';
  }

  /** 헬스체크에 실을 요약 — 키는 절대 포함하지 않는다 */
  get health() {
    return {
      live: this.liveOk,
      calls: this.stats.calls,
      ok: this.stats.ok,
      failed: this.stats.failed,
      cacheHits: this.stats.cacheHits,
      lastError: this.stats.lastError,
    };
  }

  async init() {
    /* 캐시에 이미 ODsay 결과가 있으면 예전에 성공했다는 뜻이다.
     * Render 무료 티어는 자주 재기동되므로, 부팅마다 확인 호출을 하면
     * 그것만으로 쿼터가 샌다. 캐시가 비었을 때만 한 번 찔러본다. */
    try {
      const cached = await this.store.getRouteCacheCount();
      if (cached > 0) {
        this.liveOk = true;
        console.log(`  ODsay 어댑터 준비 (캐시 ${cached}건)`);
        return;
      }
      const probe = await this.probe();
      console.log(probe ? '  ODsay 연결 확인됨' : '  ODsay 확인 실패 — 지하철 그래프로 답합니다');
    } catch (e) {
      console.error('  ODsay 초기화 실패:', e.message);
    }
  }

  /** 키가 살아 있는지 한 쌍만 확인 (결과는 캐시에 남아 재사용된다) */
  async probe() {
    const a = this.graph.findStations('서울역')[0];
    const b = this.graph.findStations('강남')[0];
    if (!a || !b) return false;
    const r = await this.lookupPair(a.id, b.id);
    return !!r;
  }

  /**
   * 역쌍 하나. 캐시 우선, 없으면 API. 실패하면 null.
   *
   * 돌려주는 모양은 항상 {minutes, fare} 다.
   * route_cache 는 시간·요금만 담으므로 pathType 은 캐시에서 살아 돌아오지 않는다.
   * 신선한 응답일 때만 있는 필드를 섞어 내보내면, 캐시가 차오른 뒤에야
   * 조용히 동작이 달라진다. 그래서 여기서 모양을 맞춰 내보낸다.
   */
  async lookupPair(fromId, toId) {
    const cached = await this.store.getRouteCache(fromId, toId, ODSAY.cacheTtlDays);
    if (cached) {
      this.stats.cacheHits++;
      this.liveOk = true;
      return { minutes: cached.minutes, fare: cached.fare };
    }
    const fresh = await this.fetchPair(fromId, toId);
    if (!fresh) return null;
    try {
      await this.store.putRouteCache(fromId, toId, fresh.minutes, fresh.fare);
    } catch (e) {
      console.error('[odsay] 캐시 저장 실패:', e.message);
    }
    return { minutes: fresh.minutes, fare: fresh.fare };
  }

  /**
   * ODsay 호출. 성공하면 {minutes, fare, pathType}, 실패하면 null.
   * 실패는 예외로 던지지 않는다 — 호출부가 그래프로 되돌아갈 수 있어야 한다.
   */
  async fetchPair(fromId, toId) {
    const a = this.graph.stations[fromId];
    const b = this.graph.stations[toId];
    if (!hasCoords(a) || !hasCoords(b)) return null;      // 좌표 없으면 그래프로

    /* 좌표는 경도(X)·위도(Y) 순서다. 바꿔 넣으면 엉뚱한 곳을 찾는다. */
    const url = new URL(ODSAY.url);
    url.searchParams.set('apiKey', this.apiKey);
    url.searchParams.set('SX', String(a.lng));
    url.searchParams.set('SY', String(a.lat));
    url.searchParams.set('EX', String(b.lng));
    url.searchParams.set('EY', String(b.lat));
    url.searchParams.set('lang', '0');
    url.searchParams.set('output', 'json');

    for (let attempt = 0; ; attempt++) {
      this.stats.calls++;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(ODSAY.timeoutMs),
          headers: { accept: 'application/json' },
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt < ODSAY.maxRetry) {
            await sleep(ODSAY.backoffMs * Math.pow(2, attempt));
            continue;
          }
          return this.fail(`HTTP ${res.status}`);
        }
        if (!res.ok) return this.fail(`HTTP ${res.status}`);

        const body = await res.json();
        const parsed = parseOdsay(body);
        if (!parsed.ok) return this.fail(parsed.reason);

        this.stats.ok++;
        this.liveOk = true;
        return parsed.value;
      } catch (e) {
        // AbortError(타임아웃) 포함
        if (attempt < ODSAY.maxRetry) {
          await sleep(ODSAY.backoffMs * Math.pow(2, attempt));
          continue;
        }
        return this.fail(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.message);
      }
    }
  }

  /** 실패를 기록하고 null 을 돌려준다. 메시지에 키가 섞이지 않게 주의한다. */
  fail(reason) {
    this.stats.failed++;
    this.stats.lastError = scrub(reason, this.apiKey);
    console.error('[odsay] 호출 실패:', this.stats.lastError);
    return null;
  }

  /**
   * 중간지점 선택.
   *   1) 그래프로 후보를 추리고
   *   2) 추린 후보만 ODsay 시간·요금으로 바꿔 다시 순위를 매긴다.
   * 못 가져온 역쌍은 그래프 값을 그대로 쓴다.
   */
  async findMeetingPoint(originIds, opts = {}) {
    const topN = opts.topN ?? 5;
    const base = this.graph.findMeetingPoint(originIds, {
      ...opts,
      topN: Math.max(ODSAY.shortlist, topN),
    });
    if (!base) return null;

    const spots = [base.best, ...base.alternatives];
    const uniqOrigins = [...new Set(originIds)];

    /* 물어볼 역쌍 (출발 == 후보인 경우는 0분이라 물어볼 필요가 없다) */
    const pairs = [];
    for (const from of uniqOrigins) {
      for (const spot of spots) {
        if (from !== spot.station.id) pairs.push({ from, to: spot.station.id });
      }
    }

    const table = new Map();
    let budget = ODSAY.maxCallsPerRequest;
    await mapLimit(pairs, ODSAY.concurrency, async (p) => {
      const key = `${p.from}|${p.to}`;
      const cached = await this.store.getRouteCache(p.from, p.to, ODSAY.cacheTtlDays);
      if (cached) {
        this.stats.cacheHits++; this.liveOk = true;
        table.set(key, { minutes: cached.minutes, fare: cached.fare });
        return;
      }
      if (budget <= 0) return;                    // 예산 초과분은 그래프 값으로 둔다
      budget--;
      const fresh = await this.fetchPair(p.from, p.to);
      if (!fresh) return;
      table.set(key, fresh);
      try { await this.store.putRouteCache(p.from, p.to, fresh.minutes, fresh.fare); } catch { /* 캐시는 실패해도 그만 */ }
    });

    /* 하나도 못 받았으면 그래프 결과 그대로.
     * fareSource 는 빼먹지 말고 붙인다 — 응답 모양이 경로마다 달라지면
     * 화면이 "근사치" 표기를 놓치고 실측인 척하게 된다. */
    if (!table.size) {
      return { ...base, selection: { ...base.selection, fareSource: 'estimate', odsayPairs: 0 } };
    }

    /* ODsay 값으로 각 후보를 다시 채점한다 */
    const toleranceSec = Math.round((opts.toleranceMin ?? base.selection.toleranceMin) * 60);
    const rescored = spots.map((spot) => {
      const routes = spot.routes.map((r) => {
        if (r.originId === spot.station.id) {
          return { ...r, sec: 0, fare: 0, timeSource: 'same-station' };
        }
        const hit = table.get(`${r.originId}|${spot.station.id}`);
        if (!hit) return { ...r, timeSource: 'graph' };
        return {
          ...r,
          sec: Math.round(hit.minutes * 60),
          fare: Number.isFinite(hit.fare) && hit.fare > 0 ? hit.fare : r.fare,
          timeSource: 'odsay',
        };
      });
      const secs = routes.map((r) => r.sec);
      return {
        ...spot,
        routes,
        maxSec: Math.max(...secs),
        sumSec: secs.reduce((a, b) => a + b, 0),
        fareTotal: routes.reduce((a, r) => a + (r.fare || 0), 0),
      };
    });
    for (const s of rescored) {
      s.avgSec = Math.round(s.sumSec / originIds.length);
      s.fareAvg = Math.round(s.fareTotal / originIds.length);
    }

    /* 그래프와 같은 규칙: 동률 밴드 → 평균 → 요금 */
    const minMax = Math.min(...rescored.map((s) => s.maxSec));
    for (const s of rescored) s.inBand = s.maxSec <= minMax + toleranceSec;
    const band = rescored.filter((s) => s.inBand).sort((a, b) =>
      a.sumSec - b.sumSec || a.fareTotal - b.fareTotal || a.maxSec - b.maxSec);
    const rest = rescored.filter((s) => !s.inBand).sort((a, b) =>
      a.maxSec - b.maxSec || a.sumSec - b.sumSec);
    const ranked = band.concat(rest);

    const odsayRoutes = rescored.reduce(
      (n, s) => n + s.routes.filter((r) => r.timeSource === 'odsay').length, 0);

    /* 화면에 뭐라고 적을지는 "고른 역" 기준으로 정한다.
     * 캐시에 남은 다른 쌍 때문에 table 이 비어있지 않다고 해서
     * 정작 보여줄 경로가 그래프 값인데 "실시간 기준" 이라고 적으면 거짓말이 된다. */
    const chosen = ranked[0].routes;
    const live = chosen.filter((r) => r.timeSource === 'odsay').length;
    const needed = chosen.filter((r) => r.timeSource !== 'same-station').length;
    const fareSource = needed === 0 || live === needed ? (live ? 'odsay' : 'estimate')
      : live > 0 ? 'mixed' : 'estimate';

    return {
      best: ranked[0],
      alternatives: ranked.slice(1, topN),
      selection: {
        ...base.selection,
        toleranceMin: toleranceSec / 60,
        minMaxSec: minMax,
        bandSize: band.length,
        shortlist: spots.length,
        odsayPairs: table.size,
        odsayRoutes,
        fareSource,
      },
      worstPairwiseSec: base.worstPairwiseSec,
    };
  }
}

/* ------------------------------------------------------------------ 파싱 */

/**
 * ODsay 응답에서 최소 소요시간 경로를 뽑는다.
 * 성공 {ok:true, value:{minutes,fare,pathType}} / 실패 {ok:false, reason}
 */
export function parseOdsay(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'empty body' };

  // 오류는 {error:{code,msg}} 또는 {result:{error:...}} 로 온다
  const err = body.error || body.result?.error;
  if (err) return { ok: false, reason: `odsay ${err.code ?? '?'}` };

  const paths = body.result?.path;
  if (!Array.isArray(paths) || !paths.length) return { ok: false, reason: 'no path' };

  let best = null;
  for (const p of paths) {
    const t = p?.info?.totalTime;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) continue;
    if (!best || t < best.info.totalTime) best = p;
  }
  if (!best) return { ok: false, reason: 'no usable path' };

  const fare = best.info.payment;
  return {
    ok: true,
    value: {
      minutes: best.info.totalTime,
      fare: typeof fare === 'number' && Number.isFinite(fare) && fare >= 0 ? fare : null,
      pathType: best.pathType ?? best.info.pathType ?? null,
    },
  };
}

function hasCoords(s) {
  return !!s && Number.isFinite(s.lat) && Number.isFinite(s.lng);
}

/** 이미 URL 인코딩된 키면 한 번 풀어둔다 (URLSearchParams 의 이중 인코딩 방지) */
export function decodeIfEncoded(key) {
  const s = String(key ?? '');
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 로그·응답에 키가 새지 않게 지운다 */
export function scrub(text, key) {
  let out = String(text ?? '');
  for (const form of [key, encodeURIComponent(key ?? '')]) {
    if (form && form.length > 4) out = out.split(form).join('***');
  }
  return out.replace(/apiKey=[^&\s]+/gi, 'apiKey=***').slice(0, 200);
}
