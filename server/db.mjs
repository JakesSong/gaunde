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

/**
 * route_cache 레그 스키마 판(版).
 *
 * legs(실제 경로의 탑승 구간)는 나중에 추가한 열이라, 그 전에 저장된 행에는 없다.
 * 그 행이 캐시 수명(7일) 동안 살아 있는 한 화면은 조용히 지하철 그래프 경로로
 * 되돌아가고, 요약의 환승 수와 그림이 어긋난 채로 남는다.
 *
 * 그래서 읽을 때 "레그가 없고, 레그를 담기 시작한 뒤에 쓰인 행도 아닌" 행은
 * 캐시에 없는 셈 친다 → 다음 조회에서 ODsay 로 다시 채워진다. 채워 넣을 때
 * 이 판 번호를 같이 새기므로, 정말로 레그가 없는 경로(도보만 있는 응답 등)라도
 * 한 번 다시 물어본 뒤에는 그대로 캐시에 남는다 — 매번 다시 부르지 않는다.
 *
 * 레그 모양을 바꿔서 옛 행을 다시 받아와야 할 때 이 번호를 올린다.
 */
export const ROUTE_CACHE_LEGS_REV = 1;

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
      CREATE INDEX IF NOT EXISTS participants_meeting ON participants(meeting_id);
      CREATE TABLE IF NOT EXISTS route_cache (
        from_id    INTEGER NOT NULL,
        to_id      INTEGER NOT NULL,
        minutes    REAL NOT NULL,
        fare       INTEGER,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (from_id, to_id)
      );
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
      CREATE TABLE IF NOT EXISTS meeting_results (
        meeting_id        TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        participants_hash TEXT NOT NULL,
        result_json       TEXT NOT NULL,
        routing           TEXT,
        created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    this.migrateParticipantIdentity();
    this.migrateFeedback();
    this.migrateResultView();
    this.migrateRouteTransfers();
  }

  /* 참여자 식별을 이름 → client_id 로 옮긴다. (아래 PostgresStore 에 같은 설명이 있다) */
  migrateParticipantIdentity() {
    const cols = this.db.prepare('PRAGMA table_info(participants)').all();
    if (!cols.some((c) => c.name === 'client_id')) {
      this.db.exec('ALTER TABLE participants ADD COLUMN client_id TEXT');
    }
    this.db.exec(`
      DROP INDEX IF EXISTS participants_meeting_name;
      CREATE UNIQUE INDEX IF NOT EXISTS participants_meeting_client
        ON participants(meeting_id, client_id);
    `);
  }

  /* 결과 피드백은 모임·기기당 한 표만 세고, 마음이 바뀌면 마지막 값으로 갱신한다. */
  migrateFeedback() {
    const cols = this.db.prepare('PRAGMA table_info(events)').all();
    if (!cols.some((c) => c.name === 'client_key')) {
      this.db.exec('ALTER TABLE events ADD COLUMN client_key TEXT');
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_feedback_once
        ON events(meeting_id, client_key) WHERE event = 'result_feedback';
    `);
  }

  async upsertFeedback(meetingId, meetingToken, clientKey, meta) {
    this.db.prepare(
      `INSERT INTO events (id, event, meeting_id, meeting_token, client_key, meta)
       VALUES (?, 'result_feedback', ?, ?, ?, ?)
       ON CONFLICT(meeting_id, client_key) WHERE event = 'result_feedback'
       DO UPDATE SET meta = excluded.meta,
                     created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(crypto.randomUUID(), meetingId, meetingToken ?? null, clientKey, JSON.stringify(meta));
  }

  /* 결과 화면을 실제로 본 기기 — 모임·기기당 한 행. (PostgresStore 에 같은 설명이 있다) */
  migrateResultView() {
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_resultview_once
        ON events(meeting_id, client_key) WHERE event = 'result_view';
    `);
  }

  async upsertResultView(meetingId, meetingToken, clientKey) {
    this.db.prepare(
      `INSERT INTO events (id, event, meeting_id, meeting_token, client_key)
       VALUES (?, 'result_view', ?, ?, ?)
       ON CONFLICT(meeting_id, client_key) WHERE event = 'result_view'
       DO NOTHING`,
    ).run(crypto.randomUUID(), meetingId, meetingToken ?? null, clientKey);
  }

  /* 결과 스냅샷 — 모임당 한 행만 둔다(최신이 이긴다).
   * 참여자 구성이 그대로면 재계산 없이 이걸 그대로 돌려준다. */
  async getMeetingResult(meetingId, hash, routing, ttlDays) {
    const row = this.db.prepare(
      `SELECT result_json FROM meeting_results
       WHERE meeting_id = ? AND participants_hash = ? AND routing IS ?
         AND julianday('now') - julianday(created_at) < ?`,
    ).get(meetingId, hash, routing ?? null, ttlDays);
    return row ? row.result_json : null;
  }

  async putMeetingResult(meetingId, hash, json, routing) {
    this.db.prepare(
      `INSERT INTO meeting_results (meeting_id, participants_hash, result_json, routing)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(meeting_id) DO UPDATE SET
         participants_hash = excluded.participants_hash,
         result_json = excluded.result_json,
         routing = excluded.routing,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(meetingId, hash, json, routing ?? null);
  }

  /* 환승 횟수·경로 레그는 나중에 추가했다. 화면에 "환승 N회" 와 경로 그림으로 나가는 값이라
     그래프 짐작이 아니라 실제 경로 값을 써야 해서 캐시에도 같이 담는다.
     legs 는 JSON 문자열이다 (탑승 구간 배열 — 캐시가 채워지기 전 행에는 없다).
     legs_rev 는 그 행을 어느 레그 스키마로 채웠는지 (ROUTE_CACHE_LEGS_REV 참고). */
  migrateRouteTransfers() {
    const cols = this.db.prepare('PRAGMA table_info(route_cache)').all();
    if (!cols.some((c) => c.name === 'transfers')) {
      this.db.exec('ALTER TABLE route_cache ADD COLUMN transfers INTEGER');
    }
    if (!cols.some((c) => c.name === 'legs')) {
      this.db.exec('ALTER TABLE route_cache ADD COLUMN legs TEXT');
    }
    if (!cols.some((c) => c.name === 'legs_rev')) {
      this.db.exec('ALTER TABLE route_cache ADD COLUMN legs_rev INTEGER');
    }
  }

  /* 레그 없는 옛 행은 없는 셈 친다 — 마지막 조건이 그것이다 (ROUTE_CACHE_LEGS_REV 참고). */
  async getRouteCache(fromId, toId, ttlDays) {
    return this.db.prepare(
      `SELECT minutes, fare, transfers, legs FROM route_cache
       WHERE from_id = ? AND to_id = ?
         AND julianday('now') - julianday(updated_at) < ?
         AND ((legs IS NOT NULL AND legs <> '') OR COALESCE(legs_rev, 0) >= ?)`,
    ).get(fromId, toId, ttlDays, ROUTE_CACHE_LEGS_REV) ?? null;
  }

  async putRouteCache(fromId, toId, minutes, fare, transfers, legs) {
    this.db.prepare(
      `INSERT INTO route_cache (from_id, to_id, minutes, fare, transfers, legs, legs_rev)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_id, to_id) DO UPDATE SET
         minutes = excluded.minutes, fare = excluded.fare, transfers = excluded.transfers,
         legs = excluded.legs, legs_rev = excluded.legs_rev,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    ).run(fromId, toId, minutes, fare ?? null,
      Number.isFinite(transfers) ? transfers : null, legs ?? null, ROUTE_CACHE_LEGS_REV);
  }

  async getRouteCacheCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS c FROM route_cache').get().c);
  }

  async logEvent(event, meetingId, meetingToken, meta) {
    this.db.prepare(
      'INSERT INTO events (id, event, meeting_id, meeting_token, meta) VALUES (?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), event, meetingId ?? null, meetingToken ?? null, meta ? JSON.stringify(meta) : null);
  }

  async getStats(range = null) {
    const one = (sql, p = []) => Number(Object.values(this.db.prepare(sql).get(...p))[0]);
    const rows = (sql, p = []) => this.db.prepare(sql).all(...p);

    /* created_at 은 ISO-8601 UTC 문자열이라 사전순 비교가 곧 시간순 비교다. */
    const win = (col) => (range ? ` ${col} >= ? AND ${col} < ?` : ' 1=1');
    const p = range ? [range.fromIso ?? '', range.toIso ?? '9999'] : [];

    return shapeStats({
      range,
      links: one(`SELECT COUNT(*) AS c FROM meetings WHERE${win('created_at')}`, p),
      // 이벤트는 "그 기간에 일어난 것" 기준
      eventRows: rows(`SELECT event, COUNT(*) AS c FROM events WHERE${win('created_at')} GROUP BY event`, p),
      // 코호트(그 기간에 만들어진 모임) 기준 — 참여자가 다음 날 들어와도 그 모임의 성과로 친다
      sizeRows: rows(`SELECT n, COUNT(*) AS c FROM (
          SELECT p.meeting_id, COUNT(*) AS n FROM participants p
          JOIN meetings m ON m.id = p.meeting_id
          WHERE${win('m.created_at')} GROUP BY p.meeting_id) GROUP BY n`, p),
      reachedResult: one(`SELECT COUNT(DISTINCT e.meeting_id) AS c FROM events e
          JOIN meetings m ON m.id = e.meeting_id
          WHERE e.event = 'result_viewed' AND${win('m.created_at')}`, p),
      shared: one(`SELECT COUNT(DISTINCT e.meeting_id) AS c FROM events e
          JOIN meetings m ON m.id = e.meeting_id
          WHERE e.event = 'share_clicked' AND${win('m.created_at')}`, p),
      // 만족도는 "그 기간에 남긴 피드백" 기준 (이벤트 발생 시각)
      feedbackRows: rows(`SELECT json_extract(meta,'$.value') AS value,
             json_extract(meta,'$.reason') AS reason, COUNT(*) AS c
          FROM events WHERE event = 'result_feedback' AND${win('created_at')}
          GROUP BY value, reason`, p),
      /* 사람 단위 지표의 재료. 해시 대조는 SQL 이 아니라 JS 에서 한다 —
         SQLite 에는 sha256() 이 없어서 방언마다 다른 SQL 을 쓰게 되기 때문이다.
         (분모) 그 기간에 만들어진 모임의 참여자 전원 */
      viewerParticipantRows: rows(`SELECT p.meeting_id AS meeting_id, p.client_id AS client_id
          FROM participants p JOIN meetings m ON m.id = p.meeting_id
          WHERE${win('m.created_at')}`, p),
      /* (분자 후보) 그 모임들에 남은 result_view 기기 키 */
      viewerKeyRows: rows(`SELECT DISTINCT e.meeting_id AS meeting_id, e.client_key AS client_key
          FROM events e JOIN meetings m ON m.id = e.meeting_id
          WHERE e.event = 'result_view' AND e.client_key IS NOT NULL AND${win('m.created_at')}`, p),
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

  async upsertParticipant(meetingId, name, station, stationId, clientId) {
    const existing = clientId
      ? this.db.prepare('SELECT id FROM participants WHERE meeting_id = ? AND client_id = ?').get(meetingId, clientId)
      : null;
    if (existing) {
      this.db.prepare('UPDATE participants SET name = ?, station = ?, station_id = ? WHERE id = ?')
        .run(name, station, stationId, existing.id);
      return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(existing.id);
    }
    const id = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO participants (id, meeting_id, name, station, station_id, client_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, meetingId, name, station, stationId, clientId ?? null);
    return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
  }

  async updateParticipant(meetingId, participantId, fields) {
    const cur = this.db.prepare('SELECT * FROM participants WHERE meeting_id = ? AND id = ?')
      .get(meetingId, participantId);
    if (!cur) return null;
    this.db.prepare('UPDATE participants SET name = ?, station = ?, station_id = ? WHERE id = ?')
      .run(fields.name ?? cur.name, fields.station ?? cur.station,
        fields.stationId ?? cur.station_id, participantId);
    return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(participantId);
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
      CREATE INDEX IF NOT EXISTS participants_meeting ON participants(meeting_id);
      CREATE TABLE IF NOT EXISTS route_cache (
        from_id    integer NOT NULL,
        to_id      integer NOT NULL,
        minutes    real NOT NULL,
        fare       integer,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (from_id, to_id)
      );
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
      CREATE TABLE IF NOT EXISTS meeting_results (
        meeting_id        uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        participants_hash text NOT NULL,
        result_json       text NOT NULL,
        routing           text,
        created_at        timestamptz NOT NULL DEFAULT now()
      );
    `);
    // RLS 는 supabase/schema.sql 과 동일하게. 백엔드는 테이블 소유자로 붙으므로 영향받지 않고,
    // anon 키로는 아무것도 못 읽는 상태가 된다. ALTER 는 멱등이라 매 부팅 실행해도 안전하다.
    /* 참여자 식별을 이름 → client_id 로 옮긴다.
     *
     * 예전에는 (meeting_id, name) 이 유일키라, 이름이 같은 두 사람이 등록하면
     * 뒤에 온 사람이 앞사람을 조용히 덮어썼다. 둘 다 201 을 받는데 참여자는 1명이 되고
     * 결과는 "두 명 이상 필요" 로 실패했다. 같은 역에서 출발하는 일행이 이름을 대충 적을 때
     * 특히 잘 걸렸다.
     *
     * 이제 기기마다 만든 client_id 로 구분한다. 이름은 그냥 표시용이라 겹쳐도 된다. */
    await this.pool.query(`
      ALTER TABLE participants ADD COLUMN IF NOT EXISTS client_id text;
      DROP INDEX IF EXISTS participants_meeting_name;
      CREATE UNIQUE INDEX IF NOT EXISTS participants_meeting_client
        ON participants(meeting_id, client_id);
    `);
    /* 결과 피드백은 모임·기기당 한 표. 마음이 바뀌면 마지막 값으로 갱신한다.
     * client_key 는 기기 식별자 원본이 아니라 모임별로 해시한 값이라
     * 모임을 가로질러 같은 기기를 추적할 수 없다. */
    await this.pool.query(`
      ALTER TABLE events ADD COLUMN IF NOT EXISTS client_key text;
      ALTER TABLE route_cache ADD COLUMN IF NOT EXISTS transfers integer;
      -- 실제 경로의 탑승 구간(JSON). 시간을 잰 그 경로를 그대로 그리려고 같이 담는다.
      ALTER TABLE route_cache ADD COLUMN IF NOT EXISTS legs text;
      -- 그 행을 채운 레그 스키마 판. 옛 행은 null 이라 읽을 때 걸러진다.
      ALTER TABLE route_cache ADD COLUMN IF NOT EXISTS legs_rev integer;
      CREATE UNIQUE INDEX IF NOT EXISTS events_feedback_once
        ON events(meeting_id, client_key) WHERE event = 'result_feedback';
    `);
    /* 결과 화면을 실제로 본 기기 — 모임·기기당 한 행만 남긴다.
     * result_viewed(모임 단위 조회수)로는 "몇 명이 봤나" 를 셀 수 없어서 따로 둔다.
     * 여기서도 원본 기기 식별자가 아니라 모임별 해시(client_key)만 저장한다. */
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS events_resultview_once
        ON events(meeting_id, client_key) WHERE event = 'result_view';
    `);
    await this.pool.query(`
      ALTER TABLE meetings     ENABLE ROW LEVEL SECURITY;
      ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
      ALTER TABLE events       ENABLE ROW LEVEL SECURITY;
      ALTER TABLE route_cache  ENABLE ROW LEVEL SECURITY;
      ALTER TABLE meeting_results ENABLE ROW LEVEL SECURITY;
    `);
  }

  async getMeetingResult(meetingId, hash, routing, ttlDays) {
    const { rows } = await this.pool.query(
      `SELECT result_json FROM meeting_results
       WHERE meeting_id = $1 AND participants_hash = $2 AND routing IS NOT DISTINCT FROM $3
         AND created_at > now() - ($4 || ' days')::interval`,
      [meetingId, hash, routing ?? null, String(ttlDays)],
    );
    return rows[0] ? rows[0].result_json : null;
  }

  async putMeetingResult(meetingId, hash, json, routing) {
    await this.pool.query(
      `INSERT INTO meeting_results (meeting_id, participants_hash, result_json, routing)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (meeting_id) DO UPDATE SET
         participants_hash = EXCLUDED.participants_hash,
         result_json = EXCLUDED.result_json,
         routing = EXCLUDED.routing,
         created_at = now()`,
      [meetingId, hash, json, routing ?? null],
    );
  }

  async upsertFeedback(meetingId, meetingToken, clientKey, meta) {
    await this.pool.query(
      `INSERT INTO events (event, meeting_id, meeting_token, client_key, meta)
       VALUES ('result_feedback', $1, $2, $3, $4)
       ON CONFLICT (meeting_id, client_key) WHERE event = 'result_feedback'
       DO UPDATE SET meta = EXCLUDED.meta, created_at = now()`,
      [meetingId, meetingToken ?? null, clientKey, JSON.stringify(meta)],
    );
  }

  /* 두 번째부터는 아무것도 하지 않는다 — 처음 본 시각을 그대로 둔다. */
  async upsertResultView(meetingId, meetingToken, clientKey) {
    await this.pool.query(
      `INSERT INTO events (event, meeting_id, meeting_token, client_key)
       VALUES ('result_view', $1, $2, $3)
       ON CONFLICT (meeting_id, client_key) WHERE event = 'result_view'
       DO NOTHING`,
      [meetingId, meetingToken ?? null, clientKey],
    );
  }

  /* 레그 없는 옛 행은 없는 셈 친다 — 마지막 조건이 그것이다 (ROUTE_CACHE_LEGS_REV 참고). */
  async getRouteCache(fromId, toId, ttlDays) {
    const { rows } = await this.pool.query(
      `SELECT minutes, fare, transfers, legs FROM route_cache
       WHERE from_id = $1 AND to_id = $2 AND updated_at > now() - ($3 || ' days')::interval
         AND ((legs IS NOT NULL AND legs <> '') OR COALESCE(legs_rev, 0) >= $4)`,
      [fromId, toId, String(ttlDays), ROUTE_CACHE_LEGS_REV],
    );
    return rows[0] ?? null;
  }

  async putRouteCache(fromId, toId, minutes, fare, transfers, legs) {
    await this.pool.query(
      `INSERT INTO route_cache (from_id, to_id, minutes, fare, transfers, legs, legs_rev)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (from_id, to_id)
       DO UPDATE SET minutes = EXCLUDED.minutes, fare = EXCLUDED.fare,
                     transfers = EXCLUDED.transfers, legs = EXCLUDED.legs,
                     legs_rev = EXCLUDED.legs_rev, updated_at = now()`,
      [fromId, toId, minutes, fare ?? null,
        Number.isFinite(transfers) ? transfers : null, legs ?? null, ROUTE_CACHE_LEGS_REV],
    );
  }

  async getRouteCacheCount() {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS c FROM route_cache');
    return rows[0].c;
  }

  async logEvent(event, meetingId, meetingToken, meta) {
    await this.pool.query(
      'INSERT INTO events (event, meeting_id, meeting_token, meta) VALUES ($1, $2, $3, $4)',
      [event, meetingId ?? null, meetingToken ?? null, meta ? JSON.stringify(meta) : null],
    );
  }

  async getStats(range = null) {
    const q = (sql, p = []) => this.pool.query(sql, p).then((r) => r.rows);

    /* 범위가 없으면 항상 참인 조건을 넣어 쿼리 모양을 하나로 유지한다 */
    const win = (col) => (range ? ` ${col} >= $1::timestamptz AND ${col} < $2::timestamptz` : ' true');
    const p = range ? [range.fromIso ?? '-infinity', range.toIso ?? 'infinity'] : [];

    const [meet, eventRows, sizeRows, reached, shared, feedbackRows,
      viewerParticipantRows, viewerKeyRows] = await Promise.all([
      q(`SELECT COUNT(*)::int AS c FROM meetings WHERE${win('created_at')}`, p),
      // 이벤트는 "그 기간에 일어난 것" 기준
      q(`SELECT event, COUNT(*)::int AS c FROM events WHERE${win('created_at')} GROUP BY event`, p),
      // 코호트(그 기간에 만들어진 모임) 기준
      q(`SELECT n, COUNT(*)::int AS c FROM (
           SELECT p.meeting_id, COUNT(*)::int AS n FROM participants p
           JOIN meetings m ON m.id = p.meeting_id
           WHERE${win('m.created_at')} GROUP BY p.meeting_id) s GROUP BY n`, p),
      q(`SELECT COUNT(DISTINCT e.meeting_id)::int AS c FROM events e
         JOIN meetings m ON m.id = e.meeting_id
         WHERE e.event = 'result_viewed' AND${win('m.created_at')}`, p),
      q(`SELECT COUNT(DISTINCT e.meeting_id)::int AS c FROM events e
         JOIN meetings m ON m.id = e.meeting_id
         WHERE e.event = 'share_clicked' AND${win('m.created_at')}`, p),
      // 만족도는 "그 기간에 남긴 피드백" 기준 (이벤트 발생 시각)
      q(`SELECT meta->>'value' AS value, meta->>'reason' AS reason, COUNT(*)::int AS c
         FROM events WHERE event = 'result_feedback' AND${win('created_at')}
         GROUP BY value, reason`, p),
      /* 사람 단위 지표의 재료. 해시 대조는 SQL 이 아니라 JS 에서 한다 —
         SQLite 에는 sha256() 이 없어 여기서만 되는 SQL 을 쓰게 되기 때문이다.
         (분모) 그 기간에 만들어진 모임의 참여자 전원 */
      q(`SELECT p.meeting_id::text AS meeting_id, p.client_id AS client_id
         FROM participants p JOIN meetings m ON m.id = p.meeting_id
         WHERE${win('m.created_at')}`, p),
      /* (분자 후보) 그 모임들에 남은 result_view 기기 키 */
      q(`SELECT DISTINCT e.meeting_id::text AS meeting_id, e.client_key AS client_key
         FROM events e JOIN meetings m ON m.id = e.meeting_id
         WHERE e.event = 'result_view' AND e.client_key IS NOT NULL AND${win('m.created_at')}`, p),
    ]);
    return shapeStats({
      range,
      links: meet[0].c,
      eventRows,
      sizeRows,
      reachedResult: reached[0].c,
      shared: shared[0].c,
      feedbackRows,
      viewerParticipantRows,
      viewerKeyRows,
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

  async upsertParticipant(meetingId, name, station, stationId, clientId) {
    if (!clientId) {
      // client_id 없는 호출(구버전 프런트·직접 API 사용)은 그냥 새 행으로 넣는다.
      const { rows } = await this.pool.query(
        `INSERT INTO participants (meeting_id, name, station, station_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [meetingId, name, station, stationId],
      );
      return rows[0];
    }
    const { rows } = await this.pool.query(
      `INSERT INTO participants (meeting_id, name, station, station_id, client_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (meeting_id, client_id)
       DO UPDATE SET name = EXCLUDED.name, station = EXCLUDED.station, station_id = EXCLUDED.station_id
       RETURNING *`,
      [meetingId, name, station, stationId, clientId],
    );
    return rows[0];
  }

  async updateParticipant(meetingId, participantId, fields) {
    const { rows } = await this.pool.query(
      `UPDATE participants SET
         name = COALESCE($3, name), station = COALESCE($4, station),
         station_id = COALESCE($5, station_id)
       WHERE meeting_id = $1 AND id = $2 RETURNING *`,
      [meetingId, participantId, fields.name ?? null, fields.station ?? null, fields.stationId ?? null],
    );
    return rows[0] ?? null;
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
/* mode_fare / mode_transfers 는 결과 화면의 기준 토글을 실제로 쓰는지 보는 값이다.
   기본(시간)으로 되돌아오는 건 세지 않는다 — 켜본 적이 있는지가 알고 싶은 것이다. */
export const TRACKED_EVENTS = ['room_created', 'origin_submitted', 'result_viewed', 'result_view', 'share_clicked', 'share_kakao', 'result_feedback', 'mode_fare', 'mode_transfers'];

/**
 * 기기 식별자를 모임별로 해시한 값 (events.client_key).
 *
 * 원본 clientId 는 저장하지 않는다. 모임 id 를 섞으므로 같은 기기라도 모임마다
 * 다른 값이 되어, 모임을 가로질러 한 기기를 따라다닐 수 없다.
 *
 * 쓰는 쪽(server/index.mjs)과 대조하는 쪽(shapeStats)이 같은 함수를 쓰게 여기 둔다.
 * 규칙이 한 글자라도 갈리면 대조가 조용히 0 이 되고, 그건 눈치채기 어렵다.
 */
export function deviceKey(meetingId, clientId) {
  return crypto.createHash('sha256').update(`${meetingId}|${clientId}`).digest('hex').slice(0, 32);
}

/**
 * 참여자 관점 지표 — "참여자 중 결과 화면을 실제로 본 사람 비율".
 *
 *   분모 = 그 기간에 만들어진 모임(코호트)의 참여자 수
 *   분자 = 그중 자기 기기로 결과 화면을 본 사람 수
 *          (참여자의 client_id 로 만든 deviceKey 가 같은 모임의 result_view 에 있으면 본 것)
 *
 * result_viewed 는 요청 한 건마다 쌓이는 모임 단위 조회수라 사람 수를 못 센다.
 * 새로고침 한 번에 하나씩 늘고, 세 명이 한 화면을 같이 봐도 1 이다. 그래서 따로 센다.
 *
 * client_id 가 없는 옛 참여자는 대조할 값이 없어 분자에 절대 들지 못한다.
 * 조용히 비율만 떨어뜨리면 오해하기 쉬우므로 그 수도 같이 내보낸다.
 */
function shapeResultViewers(participantRows, keyRows) {
  const seen = new Set(keyRows.map((r) => `${r.meeting_id}|${r.client_key}`));
  let participants = 0, viewed = 0, unmatchable = 0;
  for (const r of participantRows) {
    participants++;
    if (!r.client_id) { unmatchable++; continue; }
    if (seen.has(`${r.meeting_id}|${deviceKey(r.meeting_id, r.client_id)}`)) viewed++;
  }
  return {
    name: '참여자 중 결과 화면을 본 사람 비율',
    definition: {
      numerator: '참여자 중 deviceKey(meeting_id, client_id) 가 같은 모임의 result_view.client_key 로 남은 사람 수',
      denominator: '그 기간에 만들어진 모임의 참여자 수',
      basis: 'meetings.created_at (코호트)',
    },
    participants,
    viewedParticipants: viewed,
    percent: participants ? +((viewed / participants) * 100).toFixed(1) : 0,
    /* 참고값 — 결과를 본 고유 기기 수. 출발역을 등록하지 않고 링크만 열어본 사람도 들어가므로
       viewedParticipants 보다 클 수 있다. 분자로 쓰지 않는다. */
    viewerDevices: keyRows.length,
    participantsWithoutClientId: unmatchable,
  };
}

function shapeStats({ range, links, eventRows, sizeRows, reachedResult, shared, feedbackRows = [],
  viewerParticipantRows = [], viewerKeyRows = [] }) {
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
    /* 어느 구간을 본 건지. 없으면 전체 기간.
     * kpi·funnel·참여자 분포는 "그 기간에 만들어진 모임" 코호트 기준이고,
     * events 는 "그 기간에 일어난 이벤트" 기준이다. 둘을 섞으면 퍼널이 100%를 넘는다. */
    range: range
      ? { from: range.from, to: range.to, tz: range.tz, toExclusive: range.toExclusive,
          fromUtc: range.fromIso, toUtc: range.toIso,
          basis: { kpi: 'meetings.created_at', funnel: 'meetings.created_at',
            events: 'events.created_at', resultViewers: 'meetings.created_at' } }
      : null,
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
    /* 결과 만족도 — 모임·기기당 한 표(마지막 값 우선)로 이미 집계된 행들이다.
       satisfactionPercent 는 good/(good+bad). 표본이 적으면 흔들리니 sample 도 같이 본다. */
    feedback: (() => {
      let good = 0, bad = 0;
      const reasons = {};
      for (const r of feedbackRows) {
        const n = Number(r.c);
        if (r.value === 'good') good += n;
        else if (r.value === 'bad') {
          bad += n;
          if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + n;
        }
      }
      const sample = good + bad;
      return {
        good, bad, sample,
        satisfactionPercent: sample ? +((good / sample) * 100).toFixed(1) : null,
        badReasons: reasons,
      };
    })(),
    /* 사람 단위 결과 도달 — funnel 의 "결과 도달"(모임 단위)과 분모가 다르다.
       퍼널은 모임 수, 이쪽은 사람 수다. 섞어 읽지 않도록 이름을 나눠 둔다. */
    resultViewers: shapeResultViewers(viewerParticipantRows, viewerKeyRows),
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
