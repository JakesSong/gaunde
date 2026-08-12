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

-- ---------------------------------------------------------------- RLS
-- 이 앱은 브라우저에서 Supabase 를 직접 부르지 않는다.
-- 모든 접근은 service_role 키를 쥔 백엔드(Render)를 거치므로
-- anon/authenticated 롤에는 아무 권한도 주지 않는다.
alter table meetings     enable row level security;
alter table participants enable row level security;
-- (정책을 만들지 않으면 anon 키로는 아무것도 읽거나 쓸 수 없다 = 의도된 상태)

-- ---------------------------------------------------------------- 정리
-- 링크는 일회성이므로 오래된 모임은 지워도 된다. 필요하면 pg_cron 으로 돌린다.
--   select cron.schedule('gaunde-cleanup', '0 4 * * *',
--     $$delete from meetings where created_at < now() - interval '90 days'$$);
