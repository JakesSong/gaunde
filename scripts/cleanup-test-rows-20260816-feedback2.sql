-- 2026-08-16 피드백 라운드2 라이브 검증에서 넣은 테스트 행 정리.
--
-- 왜 남았나: 이번 라운드는 응답 모양이 바뀌었다(timeBasis·marginMin·lastTrain·tags·
-- candidateSources). 실서버에서 ODsay 가 살아 있을 때 배지가 "실시간 대중교통 기준" 으로
-- 뜨는지, 후보 3곳의 노선 구성이 서로 다른지는 진짜 모임·진짜 참여자로만 볼 수 있었다.
-- 확인은 끝났다 — 노량진[9,1] / 대방[1,신림] / 신길[5,1] 로 노선이 갈렸고,
-- 4명 전원 timeSource=odsay 라 오차 폭(±)은 붙지 않았다.
-- 이제 이 행들이 KPI 분모(생성된 링크·참여자 수)를 부풀리므로 지운다.
--
-- 실행: Supabase SQL Editor 에 그대로 붙여넣는다.
-- 순서 주의 — events.meeting_id 는 on delete set null 이라 모임을 먼저 지우면
-- 토큰으로 이벤트를 되찾을 수 없다. 이벤트를 먼저 지운다.

begin;

-- 지우기 전에 뭐가 지워지는지 눈으로 본다
select 'events' as tbl, event, count(*)
  from events
 where meeting_token = 'zv9nm99nr6'
 group by event
union all
select 'meetings', token, count(*)
  from meetings
 where token = 'zv9nm99nr6'
 group by token;

-- 1) 검증용 이벤트 (room_created / origin_submitted / result_viewed / result_view)
delete from events
 where meeting_token = 'zv9nm99nr6';

-- 2) 검증용 모임 — participants, meeting_results 는 cascade 로 함께 지워진다
--    참여자는 [TEST]A ~ [TEST]D 네 명이다
delete from meetings
 where token = 'zv9nm99nr6';

commit;

-- route_cache 는 지우지 않는다. 역쌍(강남·의정부·인천·수원 ↔ 후보역) 단위라
-- 어느 모임에도 묶여 있지 않고, 지우면 다음 사용자가 ODsay 쿼터를 다시 쓴다.
--
-- 확인:  curl -s https://gaunde-api.onrender.com/api/stats | jq '.kpi, .events'
