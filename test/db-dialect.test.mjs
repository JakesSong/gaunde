/**
 * SQL 방언 가드.
 *
 * 실제로 터진 사고: meeting_results 테이블 DDL 을 추가하면서 SQLite 정의가
 * PostgresStore.migrate 안으로 들어갔다. strftime() 은 SQLite 전용이라
 * Render(Postgres)에서 부팅이 status 1 로 죽었다.
 *
 *   error: function strftime(unknown, unknown) does not exist  (42883)
 *
 * 로컬 테스트는 SQLite 로만 돌아서 못 잡았다. 두 어댑터의 DDL 이 눈으로는
 * 거의 똑같이 생겨서 텍스트 치환 편집에 특히 취약하다.
 *
 * pg-mem 으로 진짜 Postgres 방언을 돌려보는 것도 시도했지만,
 * gen_random_uuid() 를 DEFAULT 에 못 쓰고 IS NOT DISTINCT FROM 을 파싱하지 못했다.
 * 그걸 맞추려면 운영 SQL 을 에뮬레이터에 맞춰 비틀어야 하고, 그러고도
 * "Postgres 에서 된다" 는 보장은 아니다. 그래서 정적 검사로 간다 —
 * 적어도 이번에 터진 사고는 확실히 잡는다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'server', 'db.mjs'), 'utf8');
const lines = src.split('\n');

/** 클래스 본문의 줄 범위 (다음 최상위 선언 전까지) */
function classLines(name) {
  const start = lines.findIndex((l) => l.startsWith(`class ${name}`));
  assert.ok(start >= 0, `${name} 클래스를 찾지 못했다`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(class |function |export )/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).map((text, i) => ({ text, no: start + i + 1 }));
}

/** SQLite 에만 있는 것 — Postgres 에 들어가면 42883 으로 부팅이 죽는다 */
const SQLITE_ONLY = ['strftime', 'julianday', 'datetime(', 'AUTOINCREMENT', 'PRAGMA'];
/** Postgres 에만 있는 것 — SQLite 에 들어가면 파싱/실행이 깨진다 */
const PG_ONLY = ['gen_random_uuid', 'timestamptz', 'jsonb', '::int', '::timestamptz',
  'NOT DISTINCT FROM', "|| ' days'"];

function offenders(rows, tokens) {
  const out = [];
  for (const { text, no } of rows) {
    for (const tok of tokens) {
      if (text.includes(tok)) out.push(`${no}행 "${tok}" — ${text.trim().slice(0, 70)}`);
    }
  }
  return out;
}

describe('SQL 방언이 어댑터를 넘나들지 않는다', () => {
  test('PostgresStore 에 SQLite 전용 함수가 없다', () => {
    const bad = offenders(classLines('PostgresStore'), SQLITE_ONLY);
    assert.deepEqual(bad, [],
      `Postgres 어댑터에 SQLite 전용 SQL 이 섞였다 (배포 시 42883 으로 부팅 실패):\n  ${bad.join('\n  ')}`);
  });

  test('SqliteStore 에 Postgres 전용 문법이 없다', () => {
    const bad = offenders(classLines('SqliteStore'), PG_ONLY);
    assert.deepEqual(bad, [],
      `SQLite 어댑터에 Postgres 전용 SQL 이 섞였다:\n  ${bad.join('\n  ')}`);
  });

  test('두 어댑터가 같은 메서드를 갖는다 (한쪽만 고치는 실수 방지)', () => {
    const methods = (name) => new Set(
      classLines(name)
        .map((r) => r.text.match(/^\s{2}(?:async\s+)?([a-zA-Z_][\w]*)\s*\(/))
        .filter(Boolean).map((m) => m[1])
        .filter((m) => m !== 'constructor' && m !== 'if' && m !== 'for' && m !== 'while'),
    );
    const a = methods('SqliteStore');
    const b = methods('PostgresStore');
    /* migrate* 는 방언마다 모양이 다른 게 정상이다 —
       SQLite 는 PRAGMA 로 컬럼 유무를 보고 따로 실행하고,
       Postgres 는 ADD COLUMN IF NOT EXISTS 로 migrate() 안에서 끝낸다.
       여기서 보려는 건 "저장소 기능" 이 한쪽에만 생기는 경우다. */
    const isMigration = (m) => /^migrate/.test(m) || m === 'create';
    const onlyA = [...a].filter((m) => !b.has(m) && !isMigration(m));
    const onlyB = [...b].filter((m) => !a.has(m) && !isMigration(m));
    assert.deepEqual(onlyA, [], `SQLite 에만 있는 메서드: ${onlyA.join(', ')}`);
    assert.deepEqual(onlyB, [], `Postgres 에만 있는 메서드: ${onlyB.join(', ')}`);
  });

  test('SQL 은 어댑터 클래스 안에만 있다', () => {
    /* 공용 함수(shapeStats 등)가 SQL 을 들고 있으면 어느 방언인지 알 수 없어지고,
       바로 이번 같은 사고가 다시 난다. */
    const inside = new Set();
    for (const name of ['SqliteStore', 'PostgresStore']) {
      for (const r of classLines(name)) inside.add(r.no);
    }
    const outside = lines
      .map((text, i) => ({ text, no: i + 1 }))
      .filter((r) => !inside.has(r.no))
      .filter((r) => /\b(SELECT |INSERT INTO |CREATE TABLE |ALTER TABLE )/.test(r.text))
      .map((r) => `${r.no}행 — ${r.text.trim().slice(0, 60)}`);
    assert.deepEqual(outside, [], `어댑터 클래스 밖에 SQL 이 있다:\n  ${outside.join('\n  ')}`);
  });
});
