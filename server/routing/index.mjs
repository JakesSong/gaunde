/**
 * 라우팅 어댑터.
 *
 * 지금은 자체 지하철 그래프로 계산한다.
 * ODSAY_KEY 가 환경변수에 있으면 ODsay 대중교통 길찾기(버스 포함, 실제 요금)로 갈아탄다.
 * 키가 없으면 ODsay 쪽 코드는 절대 실행되지 않는다.
 *
 * 어댑터가 지켜야 하는 계약:
 *
 *   name                                     : 어떤 방식으로 계산했는지 (응답에 그대로 실린다)
 *   async findMeetingPoint(originIds, opts)  : graph.findMeetingPoint 와 같은 모양을 돌려준다
 *
 * 선택 규칙(동률 밴드 → 평균 → 요금)은 어댑터 위가 아니라 어댑터 안에 있다.
 * ODsay 로 갈아타도 "무엇을 고르는가" 는 그대로 두고 "얼마나 걸리는가" 만 바뀌게 하기 위해서다.
 */
import { GraphRouter } from './graph-router.mjs';
import { OdsayRouter } from './odsay-router.mjs';

export async function createRouter({ graph, store }) {
  const key = process.env.ODSAY_KEY;
  if (key) {
    const router = new OdsayRouter({ graph, store, apiKey: key });
    await router.init();
    return router;
  }
  return new GraphRouter({ graph });
}

export { GraphRouter, OdsayRouter };
