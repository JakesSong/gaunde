/**
 * /api/stats 날짜 필터 검증.
 *
 * created_at 은 UTC 로 저장되고 사용자는 한국 날짜로 묻는다.
 * 경계(UTC 15:00 = KST 익일 00:00)에서 하루가 밀리지 않는지가 핵심이다.
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, TRACKED_EVENTS } from '../server/db.mjs';
import { parseRange, kstDayToUtc, nextDay } from '../server/daterange.mjs';

/* ============================================================ 날짜 해석 */
describe('KST 날짜 해석', () => {
  test('KST 자정은 전날 UTC 15:00 이다', () => {
    assert.equal(kstDayToUtc('2026-08-13').toISOString(), '2026-08-12T15:00:00.000Z');
    assert.equal(kstDayToUtc('2026-08-14').toISOString(), '2026-08-13T15:00:00.000Z');
    assert.equal(kstDayToUtc('2026-01-01').toISOString(), '2025-12-31T15:00:00.000Z');
  });

  test('잘못된 날짜는 null', () => {
    for (const bad of ['2026-8-13', '20260813', '2026-13-01', '2026-02-30', 'yesterday', '', null, undefined, '2026-08-13T00:00:00Z']) {
      assert.equal(kstDayToUtc(bad), null, String(bad));
    }
  });

  test('parseRange: 없으면 전체, 있으면 반열린 구간', () => {
    assert.equal(parseRange({}).range, null);
    assert.equal(parseRange({ from: '', to: '' }).range, null);

    const { range } = parseRange({ from: '2026-08-13', to: '2026-08-14' });
    assert.equal(range.fromIso, '2026-08-12T15:00:00.000Z');
    assert.equal(range.toIso, '2026-08-13T15:00:00.000Z');
    assert.equal(range.tz, 'Asia/Seoul');
    assert.equal(range.toExclusive, true);
  });

  test('한쪽만 줘도 된다', () => {
    assert.equal(parseRange({ from: '2026-08-13' }).range.toIso, null);
    assert.equal(parseRange({ to: '2026-08-14' }).range.fromIso, null);
  });

  test('형식 오류와 뒤집힌 구간은 에러', () => {
    assert.match(parseRange({ from: 'nope' }).error, /from 날짜 형식/);
    assert.match(parseRange({ to: '2026-99-99' }).error, /to 날짜 형식/);
    // to 가 exclusive 라 같은 날을 주면 빈 구간이 된다 → 조용히 0 을 주는 대신 알려준다
    const same = parseRange({ from: '2026-08-13', to: '2026-08-13' });
    assert.match(same.error, /exclusive/);
    assert.match(same.error, /2026-08-14/);
    assert.match(parseRange({ from: '2026-08-14', to: '2026-08-13' }).error, /exclusive/);
  });

  test('nextDay 는 월말도 넘긴다', () => {
    assert.equal(nextDay('2026-08-31'), '2026-09-01');
    assert.equal(nextDay('2026-12-31'), '2027-01-01');
  });
});

/* ============================================================ 집계 필터 */
describe('구간별 집계', () => {
  let store, tmp;

  /** created_at 을 직접 박아 과거 데이터를 만든다 */
  function seedMeeting(id, createdAtIso, participants, events = []) {
    store.db.prepare('INSERT INTO meetings (id, token, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'tok-' + id, '모임 ' + id, createdAtIso);
    participants.forEach((n, i) => {
      store.db.prepare(
        'INSERT INTO participants (id, meeting_id, name, station, station_id, client_id, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(`${id}-p${i}`, id, n, '강남', 66, `${id}-c${i}`, createdAtIso);
    });
    events.forEach(([ev, at], i) => {
      store.db.prepare('INSERT INTO events (id, event, meeting_id, created_at) VALUES (?,?,?,?)')
        .run(`${id}-e${i}`, ev, id, at);
    });
  }

  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `gaunde-range-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.SQLITE_PATH = tmp;
    delete process.env.DATABASE_URL;
    ({ store } = await openStore());

    /* KST 8/13 하루 = UTC 8/12 15:00 ~ 8/13 15:00
     *   경계 바로 앞/뒤를 일부러 심는다 */
    seedMeeting('a', '2026-08-12T14:59:59.000Z', ['1', '2', '3'], [['room_created', '2026-08-12T14:59:59.000Z']]); // KST 8/12 23:59 — 밖
    seedMeeting('b', '2026-08-12T15:00:00.000Z', ['1', '2', '3'], [['room_created', '2026-08-12T15:00:00.000Z']]); // KST 8/13 00:00 — 안
    seedMeeting('c', '2026-08-13T03:00:00.000Z', ['1', '2'], [
      ['room_created', '2026-08-13T03:00:00.000Z'],
      ['result_viewed', '2026-08-13T03:10:00.000Z'],
    ]);                                                                                                            // KST 8/13 12:00 — 안
    seedMeeting('d', '2026-08-13T14:59:59.000Z', ['1', '2', '3', '4'], [
      ['room_created', '2026-08-13T14:59:59.000Z'],
      ['result_viewed', '2026-08-13T14:59:59.000Z'],
      ['share_clicked', '2026-08-13T14:59:59.000Z'],
    ]);                                                                                                            // KST 8/13 23:59 — 안
    seedMeeting('e', '2026-08-13T15:00:00.000Z', ['1', '2', '3'], [['room_created', '2026-08-13T15:00:00.000Z']]); // KST 8/14 00:00 — 밖
  });

  const day = (d) => parseRange({ from: d, to: nextDay(d) }).range;

  test('KST 8/13 하루만 정확히 잡는다 (UTC 경계 포함)', async () => {
    const s = await store.getStats(day('2026-08-13'));
    // b, c, d 만 (a 는 1초 전, e 는 정각 다음날)
    assert.equal(s.kpi.links, 3, 'a(직전)나 e(익일 00:00)가 섞였다');
    assert.equal(s.kpi.roomsWith3Plus, 2, 'b(3명), d(4명)');
    assert.equal(s.kpi.ratioPercent, 66.7);
  });

  test('경계 하루 앞뒤가 서로 안 섞인다', async () => {
    const d12 = await store.getStats(day('2026-08-12'));
    assert.equal(d12.kpi.links, 1, 'a 만');
    assert.equal(d12.events.room_created, 1);

    const d14 = await store.getStats(day('2026-08-14'));
    assert.equal(d14.kpi.links, 1, 'e 만');
    assert.equal(d14.events.room_created, 1);

    const all = await store.getStats(null);
    assert.equal(all.kpi.links, 5, '필터 없으면 전체');
    assert.equal(d12.kpi.links + (await store.getStats(day('2026-08-13'))).kpi.links + d14.kpi.links,
      all.kpi.links, '하루씩 쪼갠 합이 전체와 같아야 한다');
  });

  test('이벤트·퍼널·참여자 분포가 모두 구간 기준으로 다시 계산된다', async () => {
    const s = await store.getStats(day('2026-08-13'));
    /* 이벤트 종류가 늘어도(예: share_kakao) 이 테스트가 깨지지 않게 목록은 소스에서 가져오고,
       0 이 아닌 값만 눈으로 못 박는다. */
    assert.deepEqual(s.events, Object.assign(
      Object.fromEntries(TRACKED_EVENTS.map((e) => [e, 0])),
      { room_created: 3, result_viewed: 2, share_clicked: 1 },
    ));
    assert.deepEqual(s.participantsHistogram, { 2: 1, 3: 1, 4: 1 }, 'b/c/d 의 참여자 수');

    const steps = Object.fromEntries(s.funnel.map((f) => [f.step, f.meetings]));
    assert.equal(steps['링크 생성'], 3);
    assert.equal(steps['참여자 1명 이상'], 3);
    assert.equal(steps['참여자 3명 이상'], 2);
    assert.equal(steps['결과 도달'], 2);   // c, d
    assert.equal(steps['공유 클릭'], 1);   // d
    assert.ok(s.funnel.every((f, i, arr) => i === 0 || f.meetings <= arr[i - 1].meetings), '퍼널 단조 감소');
  });

  test('만족도 집계도 구간 필터를 탄다', async () => {
    // 8/13 과 8/14 에 각각 피드백을 심는다
    const fb = (id, at, value, reason, key) =>
      store.db.prepare(
        `INSERT INTO events (id, event, meeting_id, client_key, meta, created_at)
         VALUES (?, 'result_feedback', 'c', ?, ?, ?)`,
      ).run(id, key, JSON.stringify({ value, reason, station: '서울역' }), at);
    fb('f1', '2026-08-13T03:00:00.000Z', 'good', null, 'k1');
    fb('f2', '2026-08-13T04:00:00.000Z', 'bad', 'too_far', 'k2');
    fb('f3', '2026-08-14T03:00:00.000Z', 'bad', 'many_transfers', 'k3');

    const d13 = await store.getStats(day('2026-08-13'));
    assert.deepEqual(
      { good: d13.feedback.good, bad: d13.feedback.bad, pct: d13.feedback.satisfactionPercent },
      { good: 1, bad: 1, pct: 50 });
    assert.deepEqual(d13.feedback.badReasons, { too_far: 1 });

    const d14 = await store.getStats(day('2026-08-14'));
    assert.deepEqual({ good: d14.feedback.good, bad: d14.feedback.bad }, { good: 0, bad: 1 });
    assert.deepEqual(d14.feedback.badReasons, { many_transfers: 1 });

    const all = await store.getStats(null);
    assert.equal(all.feedback.sample, 3);

    const none = await store.getStats(day('2020-01-01'));
    assert.equal(none.feedback.sample, 0);
    assert.equal(none.feedback.satisfactionPercent, null, '표본이 없으면 비율은 null');
  });

  test('응답에 range 메타가 붙고, 없으면 null', async () => {
    const s = await store.getStats(day('2026-08-13'));
    assert.equal(s.range.from, '2026-08-13');
    assert.equal(s.range.to, '2026-08-14');
    assert.equal(s.range.tz, 'Asia/Seoul');
    assert.equal(s.range.toExclusive, true);
    assert.equal(s.range.fromUtc, '2026-08-12T15:00:00.000Z');
    assert.equal(s.range.toUtc, '2026-08-13T15:00:00.000Z');
    assert.equal((await store.getStats(null)).range, null);
  });

  test('한쪽만 준 구간도 동작한다', async () => {
    const fromOnly = await store.getStats(parseRange({ from: '2026-08-13' }).range);
    assert.equal(fromOnly.kpi.links, 4, 'b,c,d,e');
    const toOnly = await store.getStats(parseRange({ to: '2026-08-13' }).range);
    assert.equal(toOnly.kpi.links, 1, 'a 만');
  });

  test('데이터가 없는 구간은 0 으로 안전하게 나온다', async () => {
    const s = await store.getStats(day('2020-01-01'));
    assert.equal(s.kpi.links, 0);
    assert.equal(s.kpi.ratioPercent, 0);
    assert.equal(s.kpi.metTarget, false);
    assert.deepEqual(s.participantsHistogram, {});
    assert.ok(s.funnel.every((f) => f.meetings === 0 && f.percentOfLinks === 0));
  });
});
