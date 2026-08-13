/**
 * 기본 어댑터 — 자체 수도권 전철 그래프.
 *
 * 외부 호출이 없어 무료이고, 키도 한도도 없다.
 * 대신 버스를 못 쓰고 요금은 근사치다.
 */
export class GraphRouter {
  constructor({ graph }) {
    this.graph = graph;
  }

  get name() { return 'subway-graph'; }

  get description() {
    return '수도권 전철 그래프 자체 계산 (각역정차 기준, 버스 미포함)';
  }

  async findMeetingPoint(originIds, opts) {
    return this.graph.findMeetingPoint(originIds, opts);
  }
}
