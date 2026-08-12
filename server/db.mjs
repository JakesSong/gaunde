/**
 * 저장소 어댑터.
 *
 *   DATABASE_URL 이 있으면  → PostgreSQL (Supabase)
 *   없으면                  → 로컬 SQLite 파일 (data/gaunde.db)
 *
 * 두 구현이 같은 인터페이스를 제공하므로 서버 코드는 어느 쪽인지 몰라도 된다.
 * 스키마는 supabase/schema.sql 과 같은 모양을 유지한다.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 공유 링크 토큰: 사람이 읽고 옮겨적을 수 있게 혼동되는 글자를 뺀 22^10 공간 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newToken(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/* ------------------------------------------------------------------ SQLite */
class SqliteStore {
  constructor(file) {
    const { DatabaseSync } = require_sqlite();
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meetings (
        id         TEXT PRIMARY KEY,
        token      TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS participants (
        id         TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        station    TEXT NOT NULL,
        station_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS participants_meeting_name
        ON participants(meeting_id, name);
      CREATE INDEX IF NOT EXISTS participants_meeting ON participants(meeting_id);
      CREATE TABLE IF NOT EXISTS events (
        id            TEXT PRIMARY KEY,
        event         TEXT NOT NULL,
        meeting_id    TEXT,
        meeting_token TEXT,
        meta          TEXT,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS events_event   ON events(event);
      CREATE INDEX IF NOT EXISTS events_meeting ON events(meeting_id);
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
    `);
  }

  async logEvent(event, meetingId, meetingToken, meta) {
    this.db.prepare(
      'INSERT INTO events (id, event, meeting_id, meeting_token, meta) VALUES (?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), event, meetingId ?? null, meetingToken ?? null, meta ? JSON.stringify(meta) : null);
  }

  async getStats() {
    const one = (sql) => Number(Object.values(this.db.prepare(sql).get())[0]);
    const rows = (sql) => this.db.prepare(sql).all();
    return shapeStats({
      links: one('SELECT COUNT(*) AS c FROM meetings'),
      eventRows: rows('SELECT event, COUNT(*) AS c FROM events GROUP BY event'),
      sizeRows: rows(`SELECT n, COUNT(*) AS c FROM
        (SELECT meeting_id, COUNT(*) AS n FROM participants GROUP BY meeting_id) GROUP BY n`),
      reachedResult: one(
        "SELECT COUNT(DISTINCT meeting_id) AS c FROM events WHERE event = 'result_viewed' AND meeting_id IS NOT NULL"),
      shared: one(
        "SELECT COUNT(DISTINCT meeting_id) AS c FROM events WHERE event = 'share_clicked' AND meeting_id IS NOT NULL"),
    });
  }

  async createMeeting(name) {
    const id = crypto.randomUUID();
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = newToken();
      try {
        this.db.prepare('INSERT INTO meetings (id, token, name) VALUES (?, ?, ?)').run(id, token, name);
        return this.getMeetingByToken(token);
      } catch (e) {
        if (!/UNIQUE/i.test(e.message)) throw e;   // 토큰 충돌이면 재시도
      }
    }
    throw new Error('토큰 생성 실패');
  }

  async getMeetingByToken(token) {
    return this.db.prepare('SELECT * FROM meetings WHERE token = ?').get(token) ?? null;
  }

  async listParticipants(meetingId) {
    return this.db.prepare(
      'SELECT * FROM participants WHERE meeting_id = ? ORDER BY created_at, id',
    ).all(meetingId);
  }

  async upsertParticipant(meetingId, name, station, stationId) {
    const existing = this.db.prepare(
      'SELECT id FROM participants WHERE meeting_id = ? AND name = ?',
    ).get(meetingId, name);
    if (existing) {
      this.db.prepare('UPDATE participants SET station = ?, station_id = ? WHERE id = ?')
        .run(station, stationId, existing.id);
      return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(existing.id);
    }
    const id = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO participants (id, meeting_id, name, station, station_id) VALUES (?, ?, ?, ?, ?)',
    ).run(id, meetingId, name, station, stationId);
    return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
  }

  async deleteParticipant(meetingId, participantId) {
    const r = this.db.prepare('DELETE FROM participants WHERE meeting_id = ? AND id = ?')
      .run(meetingId, participantId);
    return r.changes > 0;
  }

  async close() { this.db.close(); }
}

function require_sqlite() {
  // node:sqlite 는 실험 기능이라 정적 import 시 경고가 앞서 출력된다. 필요할 때만 로드.
  return globalThis.process.getBuiltinModule('node:sqlite');
}

/* ------------------------------------------------------------------ Postgres */
class PostgresStore {
  constructor(pool) { this.pool = pool; }

  static async create(url) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: url,
      // Supabase 는 TLS 필수. 자체 서명 체인이라 rejectUnauthorized 는 끈다.
      ssl: /supabase|render|amazonaws/.test(url) ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    const store = new PostgresStore(pool);
    await store.migrate();
    return store;
  }

  async migrate() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        token      text NOT NULL UNIQUE,
        name       text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS participants (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        name       text NOT NULL,
        station    text NOT NULL,
        station_id integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS participants_meeting_name
        ON participants(meeting_id, name);
      CREATE INDEX IF NOT EXISTS participants_meeting ON participants(meeting_id);
      CREATE TABLE IF NOT EXISTS events (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event         text NOT NULL,
        -- 모임이 지워져도 집계는 남아야 하므로 CASCADE 가 아니라 SET NULL
        meeting_id    uuid REFERENCES meetings(id) ON DELETE SET NULL,
        meeting_token text,
        meta          jsonb,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS events_event   ON events(event);
      CREATE INDEX IF NOT EXISTS events_meeting ON events(meeting_id);
      CREATE INDEX IF NOT EXISTS events_created ON events(created_at);
    `);
    // RLS 는 supabase/schema.sql 과 동일하게. 백엔드는 테이블 소유자로 붙으므로 영향받지 않고,
    // anon 키로는 아무것도 못 읽는 상태가 된다. ALTER 는 멱등이라 매 부팅 실행해도 안전하다.
    await this.pool.query(`
      ALTER TABLE meetings     ENABLE ROW LEVEL SECURITY;
      ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE events       ENABLE ROW LEVEL SECURITY;
    `);
  }

  async logEvent(event, meetingId, meetingToken, meta) {
    await this.pool.query(
      'INSERT INTO events (event, meeting_id, meeting_token, meta) VALUES ($1, $2, $3, $4)',
      [event, meetingId ?? null, meetingToken ?? null, meta ? JSON.stringify(meta) : null],
    );
  }

  async getStats() {
    const q = (sql) => this.pool.query(sql).then((r) => r.rows);
    const [meet, eventRows, sizeRows, reached, shared] = await Promise.all([
      q('SELECT COUNT(*)::int AS c FROM meetings'),
      q('SELECT event, COUNT(*)::int AS c FROM events GROUP BY event'),
      q(`SELECT n, COUNT(*)::int AS c FROM
         (SELECT meeting_id, COUNT(*)::int AS n FROM participants GROUP BY meeting_id) s GROUP BY n`),
      q("SELECT COUNT(DISTINCT meeting_id)::int AS c FROM events WHERE event = 'result_viewed' AND meeting_id IS NOT NULL"),
      q("SELECT COUNT(DISTINCT meeting_id)::int AS c FROM events WHERE event = 'share_clicked' AND meeting_id IS NOT NULL"),
    ]);
    return shapeStats({
      links: meet[0].c,
      eventRows,
      sizeRows,
      reachedResult: reached[0].c,
      shared: shared[0].c,
    });
  }

  async createMeeting(name) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = newToken();
      try {
        const { rows } = await this.pool.query(
          'INSERT INTO meetings (token, name) VALUES ($1, $2) RETURNING *', [token, name],
        );
        return rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;
      }
    }
    throw new Error('토큰 생성 실패');
  }

  async getMeetingByToken(token) {
    const { rows } = await this.pool.query('SELECT * FROM meetings WHERE token = $1', [token]);
    return rows[0] ?? null;
  }

  async listParticipants(meetingId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM participants WHERE meeting_id = $1 ORDER BY created_at, id', [meetingId],
    );
    return rows;
  }

  async upsertParticipant(meetingId, name, station, stationId) {
    const { rows } = await this.pool.query(
      `INSERT INTO participants (meeting_id, name, station, station_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (meeting_id, name)
       DO UPDATE SET station = EXCLUDED.station, station_id = EXCLUDED.station_id
       RETURNING *`,
      [meetingId, name, station, stationId],
    );
    return rows[0];
  }

  async deleteParticipant(meetingId, participantId) {
    const r = await this.pool.query(
      'DELETE FROM participants WHERE meeting_id = $1 AND id = $2', [meetingId, participantId],
    );
    return r.rowCount > 0;
  }

  async close() { await this.pool.end(); }
}

/* ------------------------------------------------------------------ KPI 집계
 * 두 저장소가 각자 방언으로 뽑은 원시 집계를 같은 모양으로 다듬는다.
 *
 * KPI = 생성된 링크 중 참여자 3명 이상 모인 비율 (목표 30%)
 *
 * 이벤트 총계와 "모임 단위" 퍼널을 나눠서 낸다.
 * 결과 화면은 새로고침하면 또 기록되므로 총계는 부풀 수 있고, 퍼널은 모임 중복을 제거한다. */
const KPI_TARGET_PERCENT = 30;
export const TRACKED_EVENTS = ['room_created', 'origin_submitted', 'result_viewed', 'share_clicked'];

function shapeStats({ links, eventRows, sizeRows, reachedResult, shared }) {
  const events = Object.fromEntries(TRACKED_EVENTS.map((e) => [e, 0]));
  for (const r of eventRows) events[r.event] = Number(r.c);

  const histogram = {};
  let withAny = 0, with3Plus = 0;
  for (const r of sizeRows) {
    const n = Number(r.n), c = Number(r.c);
    histogram[n] = c;
    withAny += c;
    if (n >= 3) with3Plus += c;
  }

  const pct = (x) => (links ? +((x / links) * 100).toFixed(1) : 0);

  return {
    kpi: {
      name: '생성된 링크 중 참여자 3명 이상 모인 비율',
      links,
      roomsWith3Plus: with3Plus,
      ratioPercent: pct(with3Plus),
      targetPercent: KPI_TARGET_PERCENT,
      metTarget: pct(with3Plus) >= KPI_TARGET_PERCENT,
    },
    funnel: [
      { step: '링크 생성',        meetings: links,        percentOfLinks: pct(links) },
      { step: '참여자 1명 이상',   meetings: withAny,      percentOfLinks: pct(withAny) },
      { step: '참여자 3명 이상',   meetings: with3Plus,    percentOfLinks: pct(with3Plus) },
      { step: '결과 도달',        meetings: reachedResult, percentOfLinks: pct(reachedResult) },
      { step: '공유 클릭',        meetings: shared,        percentOfLinks: pct(shared) },
    ],
    events,
    participantsHistogram: histogram,
    generatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ 팩토리 */
export async function openStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const store = await PostgresStore.create(url);
    return { store, kind: 'postgres' };
  }
  const file = process.env.SQLITE_PATH || path.join(ROOT, 'data', 'gaunde.db');
  return { store: new SqliteStore(file), kind: `sqlite (${path.relative(ROOT, file)})` };
}
