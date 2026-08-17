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
import { rankByMode, normalizeModes } from '../graph.mjs';
import { ODSAY, DIVERSIFY_CANDIDATES, MODE_SLACK_MIN } from '../config.mjs';

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
  constructor({ graph, store, apiKey, intervalMs }) {
    super({ graph });
    this.store = store;

    /* ODsay 가 발급하는 키에는 URL 인코딩이 필요한 문자가 들어간다.
     * 이미 인코딩된 키를 그대로 넣으면 URLSearchParams 가 한 번 더 인코딩해
     * 인증이 깨진다. 인코딩된 형태로 보이면 한 번 풀어둔다.
     * 대시보드에서 복사해 환경변수에 붙일 때 앞뒤 공백·줄바꿈이 딸려오는 일이 잦아 먼저 턴다. */
    const raw = String(apiKey ?? '').trim();
    this.apiKey = decodeIfEncoded(raw);
    /* 진단용 — 키 값 자체는 절대 노출하지 않고 길이와 형태만 남긴다.
     * 잘려 들어갔거나 공백이 섞인 경우를 대시보드와 대조해 찾을 수 있다. */
    this.keyInfo = {
      length: this.apiKey.length,
      urlEncodedInput: raw !== this.apiKey,
      trimmed: raw.length !== String(apiKey ?? '').length,
    };

    /* ODsay 노선 이름 → 우리 노선 키. 이름은 그래프를 다시 빌드해도 잘 안 바뀌므로
       id 보다 안전한 열쇠다. 키 자체(공항철도 등)도 같이 넣어 둔다. */
    this.lineNameIndex = new Map();
    for (const [key, meta] of Object.entries(graph.lines || {})) {
      this.lineNameIndex.set(normLine(meta?.name), key);
      this.lineNameIndex.set(normLine(key), key);
    }

    this.stats = { calls: 0, ok: 0, failed: 0, cacheHits: 0, throttled: 0, failStreak: 0, lastError: null, lastBody: null };
    this.liveOk = false;    // ODsay 에서 온 값이 실제로 쓰이고 있는가
    this.nextSlot = 0;      // 다음 호출을 보낼 수 있는 가장 이른 시각 (전체 공유)
    /* 기본 간격. 테스트에서만 낮춰 쓰라고 열어둔다 — 운영에서는 config 값을 그대로 쓴다. */
    this.baseInterval = intervalMs ?? ODSAY.minIntervalMs;
    this.interval = this.baseInterval;     // 429 를 맞으면 늘어나고, 잘 되면 되돌아온다
    this.okStreak = 0;
  }

  /** 실호출이 연달아 깨지고 있으면 정상인 척하지 않는다.
   *  캐시에 예전 결과가 남아 있어도, 지금 인증이 끊겼으면 그렇게 보여야 한다.
   *  (IP 화이트리스트를 쓰면 재배포 때 서버 IP 가 바뀌어 실제로 이렇게 끊긴다) */
  get degraded() { return this.stats.failStreak >= ODSAY.failStreakDegraded; }

  get name() {
    if (this.degraded) return 'subway-graph (odsay-failing)';
    return this.liveOk ? 'odsay+subway' : 'subway-graph (odsay-pending)';
  }

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
      throttled: this.stats.throttled,
      failStreak: this.stats.failStreak,
      degraded: this.degraded,
      intervalMs: this.interval,
      lastError: this.stats.lastError,
      // 파싱이 실패했을 때 ODsay 가 실제로 뭘 줬는지. 원인을 못 좁히면 손을 못 댄다.
      lastBody: this.stats.lastBody,
      key: this.keyInfo,
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

  /**
   * 호출 간 간격을 지킨다.
   * 동시성만 낮추면 빠른 응답끼리 붙어 순간 속도가 다시 튀므로,
   * 인스턴스 전체가 공유하는 시간 슬롯을 잡아 간격을 강제한다.
   */
  async waitTurn() {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + this.interval;
    if (at > now) await sleep(at - now);
  }

  /* 429 를 맞으면 간격 자체를 늘린다.
   * 예약된 슬롯을 뒤로 미는 것만으로는 부족하다 — 큐가 이미 길면 그 슬롯들이
   * backoff 보다 멀리 잡혀 있어서 아무 효과가 없고, 초당 호출 수도 그대로다.
   * 속도를 실제로 낮추려면 앞으로 잡을 슬롯의 간격을 넓혀야 한다. */
  slowDown() {
    this.okStreak = 0;
    this.interval = Math.min(this.interval * 2, ODSAY.maxIntervalMs);
  }

  /** 한동안 잘 되면 조금씩 원래 속도로 되돌린다 */
  speedUp() {
    if (++this.okStreak < ODSAY.intervalRecoverAfter) return;
    this.okStreak = 0;
    this.interval = Math.max(this.baseInterval, Math.round(this.interval * 0.8));
  }

  /** ODsay 노선 이름을 우리 노선 키로. 못 찾으면 null (색 없이 이름만 나간다) */
  lineKeyFor(leg) {
    /* 1~9호선은 코드가 곧 우리 키다. 이름이 "수도권 1호선" 처럼 와도 이쪽에서 잡힌다. */
    const code = leg?.code;
    if (Number.isInteger(code) && code >= 1 && code <= 9 && this.graph.lines[String(code)]) {
      return String(code);
    }
    const n = normLine(leg?.name);
    if (!n) return null;
    const key = this.lineNameIndex.get(n) ?? LINE_ALIAS[n] ?? null;
    return key && this.graph.lines[key] ? key : null;
  }

  /**
   * 캐시·응답에서 꺼낸 레그에 화면이 쓸 값(노선 키·표시 이름·색)을 붙인다.
   * 그래프 경로의 leg 와 같은 모양으로 맞춘다 — 화면이 둘을 구분하지 않고 그릴 수 있게.
   */
  decorateLegs(legs) {
    const list = decodeLegs(legs);
    if (!list) return null;
    return list.map((l) => {
      const bus = l?.mode === 'bus';
      const key = bus ? null : this.lineKeyFor(l);
      const meta = key ? this.graph.lines[key] : null;
      return {
        mode: bus ? 'bus' : 'subway',
        line: key,
        lineName: meta?.name || l?.name || (bus ? '버스' : '지하철'),
        color: meta?.color || (bus ? (BUS_COLORS[l?.type] || BUS_DEFAULT) : null),
        from: l?.from ?? '',
        to: l?.to ?? '',
        stops: Number.isFinite(l?.stops) && l.stops > 0 ? l.stops : 1,
        min: Number.isFinite(l?.min) ? l.min : null,
      };
    });
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
   * 돌려주는 모양은 항상 {minutes, fare, transfers, legs} 다.
   * route_cache 가 담지 않는 값(pathType)은 캐시에서 살아 돌아오지 않는다.
   * 신선한 응답일 때만 있는 필드를 섞어 내보내면, 캐시가 차오른 뒤에야
   * 조용히 동작이 달라진다. 그래서 여기서 모양을 맞춰 내보낸다.
   *
   * legs 는 캐시에 늦게 추가한 열이라 예전 행에는 없다(null). 그런 행은 저장소가
   * 읽을 때 걸러내므로(server/db.mjs 의 ROUTE_CACHE_LEGS_REV) 여기서는 캐시 없음으로
   * 보이고, 곧바로 ODsay 로 다시 채워진다. 즉 캐시 히트에 legs 가 없다면 그건
   * 실제로 탑승 구간이 없는 경로다 — 그때만 화면이 지하철 그래프 경로로 되돌아간다.
   */
  async lookupPair(fromId, toId) {
    const cached = await this.store.getRouteCache(fromId, toId, ODSAY.cacheTtlDays);
    if (cached) {
      this.stats.cacheHits++;
      this.liveOk = true;
      return {
        minutes: cached.minutes, fare: cached.fare,
        transfers: cached.transfers ?? null, legs: decodeLegs(cached.legs),
      };
    }
    const fresh = await this.fetchPair(fromId, toId);
    if (!fresh) return null;
    try {
      await this.store.putRouteCache(
        fromId, toId, fresh.minutes, fresh.fare, fresh.transfers, encodeLegs(fresh.legs));
    } catch (e) {
      console.error('[odsay] 캐시 저장 실패:', e.message);
    }
    return {
      minutes: fresh.minutes, fare: fresh.fare,
      transfers: fresh.transfers ?? null, legs: fresh.legs ?? null,
    };
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
      await this.waitTurn();
      this.stats.calls++;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(ODSAY.timeoutMs),
          headers: { accept: 'application/json' },
        });

        if (res.status === 429 || res.status >= 500) {
          const backoff = ODSAY.backoffMs * Math.pow(2, attempt);
          if (res.status === 429) {
            this.stats.throttled++;
            this.slowDown();
          }
          if (attempt < ODSAY.maxRetry) {
            await sleep(backoff);
            continue;
          }
          return this.fail(`HTTP ${res.status}`);
        }
        if (!res.ok) return this.fail(`HTTP ${res.status}`);

        const body = await res.json();
        const parsed = parseOdsay(body);
        if (!parsed.ok) {
          this.stats.lastBody = scrub(safeJson(body), this.apiKey);
          return this.fail(parsed.reason);
        }

        this.stats.ok++;
        this.stats.failStreak = 0;
        this.liveOk = true;
        this.speedUp();
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
    this.stats.failStreak++;
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
    const modes = normalizeModes(opts.modes ?? opts.mode);
    const base = this.graph.findMeetingPoint(originIds, {
      ...opts,
      topN: Math.max(ODSAY.shortlist, topN),
    });
    if (!base) return null;

    const baseModes = base.modes || {
      [modes[0]]: { best: base.best, alternatives: base.alternatives, selection: base.selection },
    };

    /* 물어볼 역 목록.
     *
     * 기본 기준(시간)의 shortlist 가 먼저고, 다른 기준이 데려온 역만 뒤에 붙인다.
     * 순서가 중요하다 — 호출 예산(ODSAY.maxCallsPerRequest)이 바닥나면 뒤쪽부터
     * 그래프 값으로 남는데, 그 손해를 기본 기준이 아니라 부가 기준이 지게 해야 한다.
     * 부가 기준에서는 화면에 실제로 나가는 topN 곳까지만 물어본다. 그래프에는 shortlist(12곳)
     * 를 달라고 했으므로 자르지 않으면 기준마다 12곳씩 붙어 호출이 세 배가 된다.
     * 잘린 뒤쪽은 애초에 그 기준의 목록에도 안 나오는 후보다. */
    const spots = [];
    const seenSpot = new Set();
    for (const mode of modes) {
      const blk = baseModes[mode];
      if (!blk) continue;
      const from = mode === modes[0]
        ? [blk.best, ...blk.alternatives]
        : [blk.best, ...blk.alternatives].slice(0, topN);
      for (const s of from) {
        if (seenSpot.has(s.station.id)) continue;
        seenSpot.add(s.station.id);
        spots.push(s);
      }
    }
    const uniqOrigins = [...new Set(originIds)];

    /* 물어볼 역쌍 (출발 == 후보인 경우는 0분이라 물어볼 필요가 없다).
       역을 바깥 고리에 두어 예산이 앞쪽 후보부터 채워지게 한다. */
    const pairs = [];
    for (const spot of spots) {
      for (const from of uniqOrigins) {
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
        table.set(key, {
          minutes: cached.minutes, fare: cached.fare,
          transfers: cached.transfers ?? null, legs: decodeLegs(cached.legs),
        });
        return;
      }
      if (budget <= 0) return;                    // 예산 초과분은 그래프 값으로 둔다
      budget--;
      const fresh = await this.fetchPair(p.from, p.to);
      if (!fresh) return;
      table.set(key, fresh);
      try {
        await this.store.putRouteCache(
          p.from, p.to, fresh.minutes, fresh.fare, fresh.transfers, encodeLegs(fresh.legs));
      } catch { /* 캐시는 실패해도 그만 */ }
    });

    /* 하나도 못 받았으면 그래프 결과 그대로.
     * fareSource 는 빼먹지 말고 붙인다 — 응답 모양이 경로마다 달라지면
     * 화면이 "근사치" 표기를 놓치고 실측인 척하게 된다. */
    if (!table.size) {
      const patched = {};
      for (const [k, m] of Object.entries(base.modes || {})) {
        patched[k] = { ...m, selection: { ...m.selection, fareSource: 'estimate', odsayPairs: 0 } };
      }
      return {
        ...base,
        ...(Object.keys(patched).length ? { modes: patched } : {}),
        selection: { ...base.selection, fareSource: 'estimate', odsayPairs: 0 },
      };
    }

    /* ODsay 값으로 각 후보를 다시 채점한다 */
    const toleranceSec = Math.round((opts.toleranceMin ?? base.selection.toleranceMin) * 60);
    const rescored = spots.map((spot) => {
      const routes = spot.routes.map((r) => {
        if (r.originId === spot.station.id) {
          return { ...r, sec: 0, fare: 0, transfersOverride: 0, timeSource: 'same-station' };
        }
        const hit = table.get(`${r.originId}|${spot.station.id}`);
        if (!hit) return { ...r, timeSource: 'graph' };
        /* 시간을 잰 그 경로를 그대로 그린다. 예전에는 시간만 ODsay 값으로 덮고
           그림은 지하철 그래프의 최단 경로를 썼는데, 서로 다른 경로라
           요약의 "환승 2회" 옆에서 그림이 4회를 그리는 일이 생겼다. */
        const legs = this.decorateLegs(hit.legs);
        return {
          ...r,
          sec: Math.round(hit.minutes * 60),
          fare: Number.isFinite(hit.fare) && hit.fare > 0 ? hit.fare : r.fare,
          // 그래프가 짐작한 환승 횟수 대신 실제 경로의 값 (없으면 표시하지 않는다)
          transfersOverride: legs ? legs.length - 1
            : (Number.isFinite(hit.transfers) ? hit.transfers : null),
          odsayLegs: legs,
          timeSource: 'odsay',
        };
      });
      const secs = routes.map((r) => r.sec);
      /* 환승 수도 ODsay 값으로 다시 센다 — 환승 기준 정렬이 그래프의 짐작이 아니라
         화면에 실제로 나가는 숫자를 보고 줄을 세워야 근거가 맞는다. */
      const hops = routes.map((r) => (Number.isFinite(r.transfersOverride)
        ? r.transfersOverride : (r.path?.transfers ?? 0)));
      return {
        ...spot,
        routes,
        maxSec: Math.max(...secs),
        sumSec: secs.reduce((a, b) => a + b, 0),
        fareTotal: routes.reduce((a, r) => a + (r.fare || 0), 0),
        transfersTotal: hops.reduce((a, b) => a + b, 0),
        transfersMax: Math.max(0, ...hops),
      };
    });
    for (const s of rescored) {
      s.avgSec = Math.round(s.sumSec / originIds.length);
      s.fareAvg = Math.round(s.fareTotal / originIds.length);
    }
    const rescoredById = new Map(rescored.map((s) => [s.station.id, s]));

    /* "가장 먼 사람의 시간" 최선값은 후보 풀 전체의 성질이라 기준과 무관하게 하나다.
       ODsay 로 다시 잰 후보 전체(= 모든 기준의 shortlist 합집합)에서 한 번만 구한다.
       기준별 목록 안에서 다시 세면, 그 목록에 최선값을 낸 역이 없을 때 그 기준만
       더 큰 값을 최선값이라고 말하게 된다 (요금 32분 / 환승 30분으로 갈렸던 원인). */
    const poolMinMaxSec = rescored.length
      ? Math.min(...rescored.map((s) => s.maxSec))
      : base.selection?.minMaxSec;

    /* 그래프와 같은 규칙으로, 기준마다 따로 줄을 세운다.
     *
     * 기준별 후보 풀은 그래프가 후보 전체(130여 곳)에서 이미 골라 온 것이다. 여기서는
     * 그 좁은 목록을 ODsay 시간·요금으로 다시 채점해 순서만 바로잡는다 — 쿼터 때문에
     * 130곳을 다 물어볼 수 없어서다. selection.modeScope 에 그 사실을 남긴다. */
    const slackSec = Math.round((opts.modeSlackMin ?? MODE_SLACK_MIN) * 60);
    const diversify = opts.diversify ?? DIVERSIFY_CANDIDATES;
    const linesOf = (s) => s.station.lines;
    const dirOf = this.graph.directionKeyFor(originIds, (s) => s.station);

    const rankMode = (mode) => {
      const blk = baseModes[mode];
      const entries = (blk ? [blk.best, ...blk.alternatives] : [])
        .map((s) => rescoredById.get(s.station.id)).filter(Boolean);
      /* 자기 기준의 후보 안에서만 줄을 세운다.
         다른 기준이 데려온 역까지 한 풀에 섞으면, 기준을 하나 더 켰다는 이유만으로
         기본 기준(시간)의 답이 흔들린다. 기본 기준의 후보는 예전 shortlist 그대로다. */
      const r = rankByMode(entries, mode, {
        toleranceSec, slackSec, topN, diversify, linesOf, dirOf, minMaxSec: poolMinMaxSec,
      });
      /* inBand 는 기준마다 다르다. 공유 객체를 고쳐 쓰면 다른 기준의 표시가 같이 바뀐다. */
      const list = r.list.map((s) => ({ ...s, inBand: s.maxSec <= r.cutoffSec }));
      return {
        best: list[0],
        alternatives: list.slice(1, topN),
        selection: {
          ...(blk?.selection ?? base.selection),
          mode,
          toleranceMin: toleranceSec / 60,
          minMaxSec: r.minMaxSec,
          bandSize: r.poolSize,
          modeCutoffSec: r.cutoffSec,
          modeSlackMin: mode === 'time' ? 0 : slackSec / 60,
          modeScope: mode === modes[0] ? 'shortlist' : 'graph-shortlist',
          shortlist: spots.length,
          odsayPairs: table.size,
          diversity: { grouped: r.grouped, reordered: r.reordered },
        },
      };
    };

    const odsayRoutes = rescored.reduce(
      (n, s) => n + s.routes.filter((r) => r.timeSource === 'odsay').length, 0);

    /* 화면에 뭐라고 적을지는 "고른 역" 기준으로 정한다.
     * 캐시에 남은 다른 쌍 때문에 table 이 비어있지 않다고 해서
     * 정작 보여줄 경로가 그래프 값인데 "실시간 기준" 이라고 적으면 거짓말이 된다.
     * 기준마다 고른 역이 다르므로 이 판정도 기준마다 따로 한다. */
    const fareSourceOf = (spot) => {
      const live = spot.routes.filter((r) => r.timeSource === 'odsay').length;
      const needed = spot.routes.filter((r) => r.timeSource !== 'same-station').length;
      return needed === 0 || live === needed ? (live ? 'odsay' : 'estimate')
        : live > 0 ? 'mixed' : 'estimate';
    };

    const byMode = {};
    for (const mode of modes) {
      const m = rankMode(mode);
      m.selection.fareSource = fareSourceOf(m.best);
      m.selection.odsayRoutes = odsayRoutes;
      byMode[mode] = m;
    }
    const primary = byMode[modes[0]];

    return {
      best: primary.best,
      alternatives: primary.alternatives,
      selection: primary.selection,
      modes: byMode,
      worstPairwiseSec: base.worstPairwiseSec,
    };
  }
}

/* ------------------------------------------------------------------ 레그 색칠
 *
 * ODsay 는 노선 이름만 준다. 화면은 우리 노선 키(색·표시 이름)로 그리므로 이름을 맞춰 붙인다.
 * 못 맞춘 노선은 키 없이 이름만 내보낸다 — 색이 없을 뿐 경로는 그대로 보인다.
 */

/** 이름 대조용 정규화. ODsay 는 "수도권 2호선", "수인분당선(왕십리)" 처럼 붙여 준다. */
function normLine(s) {
  return String(s ?? '').replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(/^수도권/, '');
}

/* 이름이 우리 표와 다르게 불리는 노선들 */
const LINE_ALIAS = {
  분당선: '수인분당', 수인선: '수인분당',
  중앙선: '경의중앙', 경의선: '경의중앙',
  김포도시철도: '김포골드', 김포골드선: '김포골드',
  우이신설경전철: '우이신설',
  에버라인: '용인', 용인에버라인: '용인', 용인경량전철: '용인',
  공항철도1호선: '공항철도', 인천공항철도: '공항철도',
  'GTX-A선': 'GTX-A', GTXA: 'GTX-A',
};

/* 버스 종류별 색 (ODsay lane.type). 서울 기준 간선 파랑·지선 초록·순환 노랑·광역 빨강.
   모르는 종류는 간선색으로 둔다 — 버스라는 것만 구분되면 된다. */
const BUS_COLORS = {
  1: '#3D5BAB', 2: '#3D5BAB', 3: '#53B332', 4: '#E60012', 5: '#AA9872',
  6: '#E60012', 10: '#53B332', 11: '#3D5BAB', 12: '#53B332', 13: '#F99D1C',
  14: '#E60012', 15: '#E60012',
};
const BUS_DEFAULT = '#3D5BAB';

/** 캐시에 넣을 문자열로 (없으면 null) */
export function encodeLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) return null;
  try { return JSON.stringify(legs); } catch { return null; }
}

/** 캐시에서 꺼낸 값을 배열로. 예전에 저장된 행에는 아예 없다(= null). */
export function decodeLegs(raw) {
  if (Array.isArray(raw)) return raw.length ? raw : null;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

/* ------------------------------------------------------------------ 파싱 */

/**
 * ODsay 응답에서 최소 소요시간 경로를 뽑는다.
 * 성공 {ok:true, value:{minutes,fare,pathType}} / 실패 {ok:false, reason}
 */
export function parseOdsay(body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'empty body' };

  /* 오류 모양이 한 가지가 아니다. 실제로 관측된 것만 해도
   *   {"error":[{"code":"500","message":"[ApiKeyAuthFailed] ..."}]}   ← 배열!
   *   {"error":{"code":-8,"msg":"..."}}
   *   {"result":{"error":...}}
   * 배열을 객체로 읽으면 code 가 undefined 가 되어 "odsay ?" 만 남고 원인을 못 찾는다.
   * 코드와 문구를 모두 뽑아야 키 문제인지 좌표 문제인지 구분된다. */
  const errRaw = body.error ?? body.result?.error;
  const err = Array.isArray(errRaw) ? errRaw[0] : errRaw;
  if (err) {
    const code = (typeof err === 'object' ? err.code ?? err.status ?? err.errorCode : undefined) ?? '?';
    const msg = typeof err === 'string' ? err : err.msg ?? err.message ?? err.errorMessage ?? '';
    return { ok: false, reason: `odsay ${code}${msg ? ': ' + msg : ''}` };
  }

  const paths = body.result?.path;
  if (!Array.isArray(paths) || !paths.length) {
    // 응답 모양 자체가 예상과 다르면 최상위 키라도 남겨 단서를 만든다
    const keys = Object.keys(body).slice(0, 6).join(',');
    return { ok: false, reason: Array.isArray(paths) ? 'no path (empty)' : `no path (keys: ${keys || 'none'})` };
  }

  let best = null;
  for (const p of paths) {
    const t = p?.info?.totalTime;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) continue;
    if (!best || t < best.info.totalTime) best = p;
  }
  if (!best) return { ok: false, reason: 'no usable path' };

  const fare = best.info.payment;
  /* 환승 횟수 = 탑승 구간 수 - 1. 화면에 "환승 N회" 로 나가는 값이라
     그래프가 짐작한 값 대신 실제 경로의 값을 써야 한다.
     레그를 뽑았으면 그 개수로 센다 — 화면에 그리는 그림과 숫자가 같은 데서 나와야
     "요약은 2회인데 그림은 4회" 같은 어긋남이 생기지 않는다. */
  const legs = parseLegs(best);
  const boarded = (Number(best.info.busTransitCount) || 0) + (Number(best.info.subwayTransitCount) || 0);
  const transfers = legs.length ? legs.length - 1 : (boarded > 0 ? boarded - 1 : null);
  return {
    ok: true,
    value: {
      minutes: best.info.totalTime,
      fare: typeof fare === 'number' && Number.isFinite(fare) && fare >= 0 ? fare : null,
      transfers,
      legs: legs.length ? legs : null,
      pathType: best.pathType ?? best.info.pathType ?? null,
    },
  };
}

/**
 * 실제 경로의 탑승 구간(subPath)을 뽑는다.
 *
 * trafficType 은 1=지하철, 2=버스, 3=도보다. 도보는 그리지 않는다 — 노선도 그림에
 * 올릴 게 없고, 총 소요시간에는 이미 들어가 있다.
 *
 * 노선 색·우리 노선 키는 여기서 붙이지 않는다. 이 결과가 그대로 route_cache 에 들어가는데,
 * 색 표를 고칠 때마다 캐시가 통째로 낡으면 곤란하다. 색은 꺼내 쓸 때(decorateLegs) 붙인다.
 */
export function parseLegs(path) {
  const subs = Array.isArray(path?.subPath) ? path.subPath : [];
  const out = [];
  for (const sp of subs) {
    const t = Number(sp?.trafficType);
    if (t !== 1 && t !== 2) continue;                     // 도보(3)·미상은 건너뛴다
    const lane = Array.isArray(sp.lane) ? sp.lane[0] : sp.lane;
    const mode = t === 1 ? 'subway' : 'bus';
    const name = mode === 'subway'
      ? String(lane?.name ?? '').trim()
      : String(lane?.busNo ?? lane?.name ?? '').trim();
    const stops = Number(sp.stationCount);
    const min = Number(sp.sectionTime);
    out.push({
      mode,
      name: name || null,
      // 지하철은 ODsay 노선코드, 버스는 노선 종류(색을 고르는 데 쓴다)
      code: mode === 'subway' ? numOrNull(lane?.subwayCode) : null,
      type: mode === 'bus' ? numOrNull(lane?.type) : null,
      from: String(sp.startName ?? '').trim() || null,
      to: String(sp.endName ?? '').trim() || null,
      stops: Number.isFinite(stops) && stops > 0 ? stops : 1,
      min: Number.isFinite(min) && min > 0 ? min : null,
    });
  }
  return out;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 응답을 로그에 남길 수 있는 짧은 문자열로 (순환참조·과대 응답 방어) */
function safeJson(body) {
  try { return JSON.stringify(body).slice(0, 300); } catch { return String(body).slice(0, 300); }
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
  return out.replace(/apiKey=[^&\s]+/gi, 'apiKey=***').slice(0, 300);
}
