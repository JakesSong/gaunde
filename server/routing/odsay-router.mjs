/**
 * ODsay 어댑터 — 골격만. **아직 실제 호출은 하지 않는다.**
 *
 * ODSAY_KEY 가 있을 때만 생성되고, 키가 없으면 이 파일의 코드는 한 줄도 돌지 않는다.
 *
 * 왜 캐시가 먼저인가
 *   무료 티어는 하루 호출 수가 제한된다. 중간지점 계산은 (참여자 수 × 후보 역 수) 만큼
 *   길찾기가 필요해 금방 한도를 넘긴다. 참여자 5명 × 후보 130개 = 650회다.
 *   역 좌표는 고정이므로 역쌍 결과는 오래 유효하다 → route_cache 에 담아두고 재사용한다.
 *   후보를 환승역으로 줄여둔 것(config.HUB_MIN_LINES)도 같은 이유다.
 *
 * 키를 꽂은 뒤 할 일
 *   1. fetchPair() 안의 TODO 를 ODsay 대중교통 길찾기 호출로 채운다.
 *      searchPubTransPathT: SX,SY,EX,EY (경도,위도) → path[].info.totalTime / payment
 *   2. lookupPair() 의 캐시 히트/미스 흐름은 그대로 두면 된다.
 *   3. 아래 findMeetingPoint 의 fallback(super 대신 그래프 사용)을 걷어낸다.
 *
 * 지금은 키가 있어도 안전하게 그래프 결과를 돌려준다 —
 * 미완성 어댑터가 조용히 틀린 답을 내는 것보다 낫다.
 */
import { GraphRouter } from './graph-router.mjs';

/** 캐시 유효기간(일). 노선 개편이 잦지 않으므로 넉넉히 잡는다. */
const CACHE_TTL_DAYS = 90;

export class OdsayRouter extends GraphRouter {
  constructor({ graph, store, apiKey }) {
    super({ graph });
    this.store = store;
    this.apiKey = apiKey;
    this.enabled = false;      // fetchPair 를 구현하면 true 로 바꾼다
  }

  get name() { return this.enabled ? 'odsay' : 'subway-graph (odsay-pending)'; }

  get description() {
    return this.enabled
      ? 'ODsay 대중교통 길찾기 (버스 포함, 실제 요금)'
      : 'ODSAY_KEY 는 있지만 어댑터가 아직 미구현이라 그래프 계산으로 답한다';
  }

  async init() {
    // route_cache 는 store 가 부팅 때 만든다. 여기서는 캐시 상태만 확인한다.
    if (!this.store?.getRouteCacheCount) return;
    const n = await this.store.getRouteCacheCount();
    console.log(`  ODsay 어댑터 준비 (캐시 ${n}건, 실제 호출은 아직 비활성)`);
  }

  /**
   * 역쌍 하나의 소요시간·요금. 캐시 우선, 없으면 API.
   * @returns {Promise<{minutes:number, fare:number}|null>}
   */
  async lookupPair(fromId, toId) {
    const cached = await this.store.getRouteCache(fromId, toId, CACHE_TTL_DAYS);
    if (cached) return { minutes: cached.minutes, fare: cached.fare };

    const fresh = await this.fetchPair(fromId, toId);
    if (!fresh) return null;
    await this.store.putRouteCache(fromId, toId, fresh.minutes, fresh.fare);
    return fresh;
  }

  /**
   * ODsay 호출 지점. 구현 전까지 null 을 돌려준다.
   * null 이면 호출부가 그래프 계산으로 되돌아간다.
   */
  async fetchPair(fromId, toId) {
    // TODO: ODsay searchPubTransPathT 호출
    //   const a = this.graph.stations[fromId], b = this.graph.stations[toId];
    //   const url = `https://api.odsay.com/v1/api/searchPubTransPathT`
    //     + `?apiKey=${encodeURIComponent(this.apiKey)}`
    //     + `&SX=${a.lng}&SY=${a.lat}&EX=${b.lng}&EY=${b.lat}`;
    //   const best = (await fetch(url).then(r => r.json()))?.result?.path?.[0];
    //   return best ? { minutes: best.info.totalTime, fare: best.info.payment } : null;
    void fromId; void toId;
    return null;
  }

  async findMeetingPoint(originIds, opts) {
    if (!this.enabled) return super.findMeetingPoint(originIds, opts);

    // 구현되면: 후보(hubIds) × 참여자 조합을 lookupPair 로 채우고,
    // graph.findMeetingPoint 와 같은 밴드/평균/요금 규칙으로 고른다.
    throw new Error('ODsay 라우팅 미구현');
  }
}
