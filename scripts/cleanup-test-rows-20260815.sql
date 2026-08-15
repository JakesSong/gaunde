-- 2026-08-15 피드백 저장 라이브 검증에서 넣은 테스트 행 정리.
--
-- 왜 남았나: 실서버 Postgres 에 실제로 쓰기가 되는지 확인하려면 진짜 모임과
-- 진짜 result_feedback 이벤트가 있어야 했다. 확인은 끝났고(정상), 이 행들이
-- KPI 분모(생성된 링크 수)와 만족도 표본을 부풀리고 있으므로 지운다.
--
-- 실행: Supabase SQL Editor 에 그대로 붙여넣는다.
-- 순서 주의 — events.meeting_id 는 on delete set null 이라 모임을 먼저 지우면
-- 토큰으로 이벤트를 되찾을 수 없다. 이벤트를 먼저 지운다.

begin;

-- 지우기 전에 뭐가 지워지는지 눈으로 본다
select 'events' as tbl, event, count(*)
  from events
 where meeting_token in ('ed86xde5ad', 'g66htqc6ef')
 group by event
union all
select 'meetings', token, count(*)
  from meetings
 where token in ('ed86xde5ad', 'g66htqc6ef')
 group by token;

-- 1) 검증용 이벤트 (room_created / origin_submitted / result_viewed / result_feedback)
delete from events
 where meeting_token in ('ed86xde5ad', 'g66htqc6ef');

-- 2) 검증용 모임 — participants, meeting_results 는 cascade 로 함께 지워진다
delete from meetings
 where token in ('ed86xde5ad', 'g66htqc6ef');

commit;

-- 정리 뒤 기대값: result_feedback 5건 → 1건, links 41 → 39.
-- 확인:  curl -s https://gaunde-api.onrender.com/api/stats | jq '.kpi, .feedback, .events'
