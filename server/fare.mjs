/**
 * 요금 근사 계산.
 *
 * 수도권 통합요금(거리비례) + 이용한 노선의 별도운임.
 * 정확한 요금이 목적이 아니라 "동률일 때 더 싼 쪽" 을 가르는 게 목적이다.
 * ODsay 어댑터를 붙이면 여기 대신 API 가 준 요금을 쓴다.
 */
import { FARE } from './config.mjs';

/** 거리에 따른 추가운임(원) */
export function distanceFare(km) {
  if (km <= FARE.baseKm) return 0;
  const capped = Math.min(km, FARE.longFromKm);
  let extra = Math.ceil((capped - FARE.baseKm) / FARE.midStepKm) * FARE.midStepWon;
  if (km > FARE.longFromKm) {
    extra += Math.ceil((km - FARE.longFromKm) / FARE.longStepKm) * FARE.longStepWon;
  }
  return extra;
}

/**
 * 한 사람의 편도 요금.
 * @param {number} km        이동 거리
 * @param {string[]} lines   이용한 노선 키 (중복 제거된 것)
 * @param {object} lineTable graph.lines
 */
export function fareFor(km, lines, lineTable) {
  if (!km || !lines?.length) return 0;                       // 안 타면 0원
  const extra = lines.reduce((s, l) => s + (lineTable[l]?.extraFare || 0), 0);
  return FARE.base + distanceFare(km) + extra;
}

/** 별도운임이 붙은 노선만 추려낸다 — UI 에서 "왜 비싼지" 보여주기 위해 */
export function surchargeLines(lines, lineTable) {
  return lines.filter((l) => (lineTable[l]?.extraFare || 0) > 0)
    .map((l) => ({ line: l, name: lineTable[l].name, won: lineTable[l].extraFare }));
}
