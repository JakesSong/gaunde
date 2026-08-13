/**
 * 통계 조회용 날짜 구간 해석.
 *
 * created_at 은 UTC 로 저장되지만, 쓰는 사람은 한국 날짜로 생각한다.
 * "8월 13일" 이라고 하면 KST 8/13 00:00 ~ 8/14 00:00 이고,
 * 이는 UTC 로 8/12 15:00 ~ 8/13 15:00 이다.
 *
 * to 는 **exclusive** 다. [from, to) 반열린 구간.
 *   하루만 보려면  ?from=2026-08-13&to=2026-08-14
 * 이 규칙은 응답의 range.toExclusive 로도 함께 내보낸다.
 */

/** 한국 표준시는 UTC+9 고정이다 (서머타임 없음) */
export const KST_OFFSET_MIN = 9 * 60;
export const TZ = 'Asia/Seoul';

/**
 * 'YYYY-MM-DD' (KST 기준 날짜) → 그 날 자정의 UTC 시각.
 * 형식이나 날짜가 잘못되면 null.
 */
export function kstDayToUtc(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);

  // 2026-02-30 같은 값은 Date.UTC 가 조용히 넘겨버리므로 되돌려 확인한다
  const back = new Date(midnightUtc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;

  return new Date(midnightUtc - KST_OFFSET_MIN * 60_000);
}

/**
 * 쿼리스트링의 from/to 를 구간으로 바꾼다.
 * 둘 다 없으면 {range: null} (전체 기간).
 *
 * @returns {{range: object|null, error?: string}}
 */
export function parseRange({ from, to } = {}) {
  const hasFrom = from !== undefined && from !== '';
  const hasTo = to !== undefined && to !== '';
  if (!hasFrom && !hasTo) return { range: null };

  const fromUtc = hasFrom ? kstDayToUtc(from) : null;
  const toUtc = hasTo ? kstDayToUtc(to) : null;

  if (hasFrom && !fromUtc) return { range: null, error: `from 날짜 형식이 잘못됐습니다: '${from}' (YYYY-MM-DD)` };
  if (hasTo && !toUtc) return { range: null, error: `to 날짜 형식이 잘못됐습니다: '${to}' (YYYY-MM-DD)` };

  if (fromUtc && toUtc && toUtc <= fromUtc) {
    return {
      range: null,
      error: `to 는 exclusive 입니다. 하루만 보려면 to 를 다음 날로 주세요 (예: from=${from}&to=${nextDay(from)})`,
    };
  }

  return {
    range: {
      from, to: to ?? null,
      fromIso: fromUtc ? fromUtc.toISOString() : null,
      toIso: toUtc ? toUtc.toISOString() : null,
      tz: TZ,
      toExclusive: true,
    },
  };
}

/** 'YYYY-MM-DD' 의 다음 날 (오류 메시지용) */
export function nextDay(text) {
  const d = kstDayToUtc(text);
  if (!d) return text;
  const kst = new Date(d.getTime() + KST_OFFSET_MIN * 60_000 + 24 * 3600_000);
  return kst.toISOString().slice(0, 10);
}
