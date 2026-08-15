/**
 * API 주소 설정.
 *
 * 같은 서버가 프런트도 서빙하면(로컬 개발, Render 단독 배포) 빈 문자열로 두면 된다.
 * GitHub Pages 처럼 프런트만 따로 올릴 때는 백엔드 주소를 여기에 적는다.
 */
window.GAUNDE_API = (function () {
  var h = location.hostname;
  if (h.endsWith('github.io')) {
    // Render 백엔드 주소로 바꿔 주세요. (예: 'https://gaunde-api.onrender.com')
    return 'https://gaunde-api.onrender.com';
  }
  return '';   // 같은 오리진
})();

/**
 * 카카오톡 공유용 JavaScript 앱키.
 *
 * 비워두면 "카카오톡으로 보내기" 버튼 자체가 안 나오고, 지금처럼
 * 이미지 + 링크 공유(Web Share / 다운로드)로만 동작한다. 키가 없다고 깨지지 않는다.
 *
 * 넣는 법
 *   1) https://developers.kakao.com > 내 애플리케이션 > 앱 키 > **JavaScript 키** 를 복사한다.
 *      (REST API 키·Admin 키가 아니다. JavaScript 키만 브라우저에 노출해도 되는 키다.)
 *   2) 같은 콘솔의 플랫폼 > Web 에 서비스 도메인을 등록한다.
 *      https://jakessong.github.io  (로컬 확인이 필요하면 http://localhost:3000 도)
 *   3) 아래 빈 문자열을 그 키로 바꾼다.
 *
 * JavaScript 키는 도메인이 묶인 공개 키라 프런트에 노출되는 것이 정상이다.
 * 그래도 이 저장소에 커밋하고 싶지 않다면, 이 파일을 배포 직전에만 채우거나
 * 다른 스크립트에서 window.KAKAO_KEY 를 정의해도 된다 — app.js 는 값만 본다.
 */
window.KAKAO_KEY = window.KAKAO_KEY || '';
