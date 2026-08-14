/**
 * 결과 스냅샷 캐시.
 *
 * 결과 링크로 다시 들어올 때마다 후보 130개 minimax 를 다시 돌리고 ODsay 를 다시 부르면
 * 쿼터와 CPU 가 그냥 샌다. 참여자 구성이 그대로면 저장해둔 결과를 그대로 준다.
 *
 * 여기서는 저장소 계층과 해시 규칙을 본다. "두 번째 호출에 계산이 0회" 인지는
 * e2e 에서 라우터 호출 카운터로 확인한다.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore } from '../server/db.mjs';

/** server/index.mjs 의 participantsHash 와 같은 규칙 */
function participantsHash(participants, fingerprint = 'fp') {
  const parts = participants.map((p) => `${p.id}|${p.name}|${p.station_id}`).sort();
  return crypto.createHash('sha256')
    .update(`${fingerprint}\n${parts.join('\n')}`).digest('hex').slice(0, 32);
}

const P = (id, name, station_id) => ({ id, name, station_id });

describe('참여자 구성 해시', () => {
  test('순서가 달라도 같은 해시 (정렬)', () => {
    const a = [P('1', '규민', 66), P('2', '지현', 63), P('3', '태윤', 88)];
    const b = [P('3', '태윤', 88), P('1', '규민', 66), P('2', '지현', 63)];
    assert.equal(participantsHash(a), participantsHash(b));
  });

  test('출발역이 바뀌면 해시도 바뀐다', () => {
    const a = [P('1', '규민', 66), P('2', '지현', 63)];
    const b = [P('1', '규민', 66), P('2', '지현', 88)];
    assert.notEqual(participantsHash(a), participantsHash(b));
  });

  test('이름만 바뀌어도 해시가 바뀐다', () => {
    /* 응답의 routes[].name 에 이름이 실리므로, 이름만 고쳐도 캐시는 무효여야 한다.
       출발역만 해시하면 이름을 바꿔도 예전 이름이 그대로 나온다. */
    const a = [P('1', '규민', 66), P('2', '지현', 63)];
    const b = [P('1', '규민이', 66), P('2', '지현', 63)];
    assert.notEqual(participantsHash(a), participantsHash(b));
  });

  test('인원이 늘거나 줄면 해시가 바뀐다', () => {
    const a = [P('1', '규민', 66), P('2', '지현', 63)];
    assert.notEqual(participantsHash(a), participantsHash([...a, P('3', '태윤', 88)]));
    assert.notEqual(participantsHash(a), participantsHash([a[0]]));
  });

  test('같은 역에 두 명이어도 각자 세어진다', () => {
    const a = [P('1', 'A', 66), P('2', 'B', 66)];
    const b = [P('1', 'A', 66)];
    assert.notEqual(participantsHash(a), participantsHash(b));
  });

  test('노선도를 다시 빌드하면(지문 변경) 캐시가 무효가 된다', () => {
    const a = [P('1', '규민', 66)];
    assert.notEqual(participantsHash(a, 'build-1'), participantsHash(a, 'build-2'));
  });
});

describe('결과 스냅샷 저장소', () => {
  let store;

  beforeEach(async () => {
    process.env.SQLITE_PATH = path.join(
      os.tmpdir(), `gaunde-rc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    delete process.env.DATABASE_URL;
    ({ store } = await openStore());
    store.db.prepare('INSERT INTO meetings (id, token, name) VALUES (?,?,?)').run('m1', 't1', '모임');
  });

  test('저장하면 같은 해시로 다시 읽힌다', async () => {
    await store.putMeetingResult('m1', 'h1', '{"best":1}', 'subway-graph');
    assert.equal(await store.getMeetingResult('m1', 'h1', 'subway-graph', 7), '{"best":1}');
  });

  test('해시가 다르면 못 읽는다 (참여자 구성 변경)', async () => {
    await store.putMeetingResult('m1', 'h1', '{"best":1}', 'subway-graph');
    assert.equal(await store.getMeetingResult('m1', 'h2', 'subway-graph', 7), null);
  });

  test('라우팅 방식이 바뀌면 못 읽는다', async () => {
    // ODsay 가 살아나면 시간·요금이 달라지므로 그래프로 계산한 결과를 그대로 쓰면 안 된다
    await store.putMeetingResult('m1', 'h1', '{"best":1}', 'subway-graph');
    assert.equal(await store.getMeetingResult('m1', 'h1', 'odsay+subway', 7), null);
  });

  test('TTL 이 지나면 못 읽는다', async () => {
    await store.putMeetingResult('m1', 'h1', '{"best":1}', 'subway-graph');
    store.db.prepare("UPDATE meeting_results SET created_at = '2020-01-01T00:00:00.000Z'").run();
    assert.equal(await store.getMeetingResult('m1', 'h1', 'subway-graph', 7), null);
    assert.equal(await store.getMeetingResult('m1', 'h1', 'subway-graph', 99999), '{"best":1}');
  });

  test('모임당 한 행만 남는다 (최신이 이긴다)', async () => {
    await store.putMeetingResult('m1', 'h1', '{"v":1}', 'subway-graph');
    await store.putMeetingResult('m1', 'h2', '{"v":2}', 'subway-graph');
    await store.putMeetingResult('m1', 'h3', '{"v":3}', 'subway-graph');
    const n = store.db.prepare('SELECT COUNT(*) AS c FROM meeting_results').get().c;
    assert.equal(Number(n), 1, '오래된 행이 쌓이면 안 된다');
    assert.equal(await store.getMeetingResult('m1', 'h3', 'subway-graph', 7), '{"v":3}');
    assert.equal(await store.getMeetingResult('m1', 'h1', 'subway-graph', 7), null);
  });

  test('같은 키로 두 번 저장해도 결과가 같다 (멱등)', async () => {
    await store.putMeetingResult('m1', 'h1', '{"v":1}', 'subway-graph');
    await store.putMeetingResult('m1', 'h1', '{"v":1}', 'subway-graph');
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS c FROM meeting_results').get().c), 1);
    assert.equal(await store.getMeetingResult('m1', 'h1', 'subway-graph', 7), '{"v":1}');
  });

  test('모임이 지워지면 스냅샷도 같이 지워진다', async () => {
    await store.putMeetingResult('m1', 'h1', '{"v":1}', 'subway-graph');
    store.db.prepare('DELETE FROM meetings WHERE id = ?').run('m1');
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS c FROM meeting_results').get().c), 0);
  });
});
