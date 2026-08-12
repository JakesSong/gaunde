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
