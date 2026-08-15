/**
 * 기기별 result_view — "참여자 중 결과 화면을 실제로 본 사람 비율".
 *
 * 기존 result_viewed 는 결과 API 가 불릴 때마다 쌓이는 모임 단위 조회수라
 * 사람 수를 못 센다. 한 사람이 새로고침해도 늘고, 세 명이 한 화면을 같이 봐도 1 이다.
 *
 * 여기서 보는 것:
 *   1) 같은 기기가 몇 번을 보내도 행은 하나 (부분 유니크 인덱스)
 *   2) 참여자 client_id ↔ 이벤트 client_key 대조가 실제로 맞물리는지
 *      (규칙이 갈리면 대조가 조용히 0 이 된다 — 가장 무서운 실패 모양이다)
 *   3) 구간 필터가 다른 지표와 같은 코호트 기준으로 도는지
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { openStore, deviceKey } from '../server/db.mjs';
import { parseRange, nextDay } from '../server/daterange.mjs';

describe('기기별 result_view', () => {
  let store;

  /** 참여자 client_id 는 `${id}-c${i}` 로 심는다 (stats-range 테스트와 같은 규칙) */
  function seedMeeting(id, createdAtIso, participantCount) {
    store.db.prepare('INSERT INTO meetings (id, token, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'tok-' + id, '모임 ' + id, createdAtIso);
    for (let i = 0; i < participantCount; i++) {
      store.db.prepare(
        `INSERT INTO participants (id, meeting_id, name, station, station_id, client_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(`${id}-p${i}`, id, '참여자' + i, '강남', 66, `${id}-c${i}`, createdAtIso);
    }
  }

  /** 그 모임의 i 번째 참여자가 자기 기기로 결과를 봤다고 기록한다 */
  const view = (id, i) => store.upsertResultView(id, 'tok-' + id, deviceKey(id, `${id}-c${i}`));

  const countRows = () =>
    Number(store.db.prepare("SELECT COUNT(*) AS c FROM events WHERE event = 'result_view'").get().c);

  beforeEach(async () => {
    process.env.SQLITE_PATH = path.join(os.tmpdir(),
      `gaunde-rv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    delete process.env.DATABASE_URL;
    ({ store } = await openStore());
  });

  test('같은 기기가 여러 번 보내도 한 행', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 3);
    await view('a', 0);
    await view('a', 0);
    await view('a', 0);
    assert.equal(countRows(), 1);

    const s = await store.getStats(null);
    assert.equal(s.resultViewers.viewedParticipants, 1, '재전송이 사람 수를 부풀리면 안 된다');
    assert.equal(s.resultViewers.viewerDevices, 1);
  });

  test('다른 기기는 따로 센다', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 3);
    await view('a', 0);
    await view('a', 1);
    assert.equal(countRows(), 2);

    const s = await store.getStats(null);
    assert.equal(s.resultViewers.participants, 3, '분모 = 참여자 수');
    assert.equal(s.resultViewers.viewedParticipants, 2, '분자 = 본 사람 수');
    assert.equal(s.resultViewers.percent, 66.7);
  });

  test('같은 기기라도 모임이 다르면 다른 키다 (모임 간 추적 불가)', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 1);
    seedMeeting('b', '2026-08-13T03:00:00.000Z', 1);
    assert.notEqual(deviceKey('a', 'same-device'), deviceKey('b', 'same-device'));

    await store.upsertResultView('a', 'tok-a', deviceKey('a', 'same-device'));
    await store.upsertResultView('b', 'tok-b', deviceKey('b', 'same-device'));
    assert.equal(countRows(), 2, '모임이 다르면 유니크 인덱스에 걸리지 않는다');
  });

  test('원본 client_id 는 events 에 남지 않는다', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 1);
    await view('a', 0);
    const row = store.db.prepare("SELECT * FROM events WHERE event = 'result_view'").get();
    assert.equal(row.client_key, deviceKey('a', 'a-c0'));
    assert.notEqual(row.client_key, 'a-c0');
    assert.equal(row.meta, null, 'meta 에도 아무것도 담지 않는다');
    assert.ok(!JSON.stringify(row).includes('a-c0'), `원본 식별자가 남았다: ${JSON.stringify(row)}`);
  });

  test('참여하지 않은 사람이 본 것은 기기 수에만 들어간다', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 2);
    await view('a', 0);
    // 출발역을 등록하지 않고 링크만 열어본 사람
    await store.upsertResultView('a', 'tok-a', deviceKey('a', '구경만-한-기기'));

    const s = await store.getStats(null);
    assert.equal(s.resultViewers.viewedParticipants, 1, '분자는 참여자만 센다');
    assert.equal(s.resultViewers.viewerDevices, 2, '참고값에는 다 들어간다');
    assert.ok(s.resultViewers.percent <= 100, '비율이 100%를 넘으면 안 된다');
  });

  test('client_id 없는 옛 참여자는 분자에 못 들고, 그 수가 드러난다', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 1);
    store.db.prepare(
      `INSERT INTO participants (id, meeting_id, name, station, station_id, created_at)
       VALUES ('a-old', 'a', '옛사람', '강남', 66, '2026-08-13T03:00:00.000Z')`,
    ).run();
    await view('a', 0);

    const s = await store.getStats(null);
    assert.equal(s.resultViewers.participants, 2);
    assert.equal(s.resultViewers.viewedParticipants, 1);
    assert.equal(s.resultViewers.participantsWithoutClientId, 1);
  });

  test('구간 필터는 모임 코호트 기준으로 돈다', async () => {
    seedMeeting('a', '2026-08-12T14:59:59.000Z', 2);   // KST 8/12 — 밖
    seedMeeting('b', '2026-08-12T15:00:00.000Z', 2);   // KST 8/13 00:00 — 안
    await view('a', 0);
    await view('b', 0);
    await view('b', 1);

    const day = (d) => parseRange({ from: d, to: nextDay(d) }).range;
    const d13 = await store.getStats(day('2026-08-13'));
    assert.equal(d13.resultViewers.participants, 2, 'b 의 참여자만');
    assert.equal(d13.resultViewers.viewedParticipants, 2);
    assert.equal(d13.resultViewers.percent, 100);

    const d12 = await store.getStats(day('2026-08-12'));
    assert.equal(d12.resultViewers.viewedParticipants, 1, 'a 만');

    const none = await store.getStats(day('2020-01-01'));
    assert.equal(none.resultViewers.participants, 0);
    assert.equal(none.resultViewers.percent, 0, '표본이 없으면 0 (0으로 나누지 않는다)');

    const all = await store.getStats(null);
    assert.equal(all.resultViewers.participants, 4);
    assert.equal(all.resultViewers.viewedParticipants, 3);
  });

  test('응답에 분모·분자 정의가 적혀 있다', async () => {
    const s = await store.getStats(null);
    const rv = s.resultViewers;
    assert.match(rv.name, /참여자/);
    assert.match(rv.definition.numerator, /result_view/);
    assert.match(rv.definition.denominator, /참여자/);
    assert.equal(rv.definition.basis, 'meetings.created_at (코호트)');
  });

  test('result_view 는 집계 이벤트 목록에도 들어간다', async () => {
    seedMeeting('a', '2026-08-13T03:00:00.000Z', 1);
    await view('a', 0);
    const s = await store.getStats(null);
    assert.equal(s.events.result_view, 1);
    assert.equal(s.events.result_viewed, 0, '모임 단위 조회수와 섞이지 않는다');
  });
});
