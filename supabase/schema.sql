-- 가운데 — Supabase(PostgreSQL) 스키마
--
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.
-- 서버가 기동할 때 CREATE TABLE IF NOT EXISTS 로 같은 스키마를 만들지만,
-- RLS 정책까지 포함한 정식 정의는 이 파일이 기준입니다.

create table if not exists meetings (
  id         uuid primary key default gen_random_uuid(),
  token      text not null unique,
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists participants (
  id         uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  name       text not null,
  station    text not null,          -- 역 이름 (표시용, 그래프 재빌드에도 살아남는 값)
  station_id integer not null,       -- 그래프 역 id (빠른 조회용 캐시)
  created_at timestamptz not null default now()
);

create unique index if not exists participants_meeting_name on participants(meeting_id, name);
create index        if not exists participants_meeting      on participants(meeting_id);

-- ---------------------------------------------------------------- 측정 이벤트
-- KPI = 생성된 링크 중 참여자 3명 이상 모인 비율 (목표 30%)
--
-- 이벤트 4종: room_created / origin_submitted / result_viewed / share_clicked
-- 남기는 건 "무슨 일이 언제 어느 모임에서" 뿐이다.
-- IP·User-Agent·쿠키·기기 식별자는 저장하지 않는다.
--
-- 이 테이블은 서버 부팅 시 자동 생성되므로 Supabase 에서 수동 실행하지 않아도 된다.
-- (여기 적어두는 건 정식 정의를 한곳에 모아두기 위해서다)
create table if not exists events (
  id            uuid primary key default gen_random_uuid(),
  event         text not null,
  -- 모임이 지워져도 집계는 남아야 하므로 cascade 가 아니라 set null
  meeting_id    uuid references meetings(id) on delete set null,
  meeting_token text,
  meta          jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists events_event   on events(event);
create index if not exists events_meeting on events(meeting_id);
create index if not exists events_created on events(created_at);

-- ---------------------------------------------------------------- RLS
-- 이 앱은 브라우저에서 Supabase 를 직접 부르지 않는다.
-- 모든 접근은 연결 문자열을 쥔 백엔드(Render)를 거치므로
-- anon/authenticated 롤에는 아무 권한도 주지 않는다.
alter table meetings     enable row level security;
alter table participants enable row level security;
alter table events       enable row level security;
-- (정책을 만들지 않으면 anon 키로는 아무것도 읽거나 쓸 수 없다 = 의도된 상태)

-- ---------------------------------------------------------------- 정리
-- 링크는 일회성이므로 오래된 모임은 지워도 된다. 필요하면 pg_cron 으로 돌린다.
--   select cron.schedule('gaunde-cleanup', '0 4 * * *',
--     $$delete from meetings where created_at < now() - interval '90 days'$$);
