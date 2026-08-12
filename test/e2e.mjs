/**
 * 로컬 end-to-end 검증 (헤드리스).
 *
 * 실제 브라우저 대신 jsdom 으로 public/index.html 을 띄우고
 * 진짜 API 서버(localhost:PORT)를 상대로 목업 3화면 흐름을 그대로 밟는다.
 *
 *   1) 주최자가 모임 생성 → 공유 링크 발급
 *   2) 참여자 5명이 각자 링크로 들어와 출발역 등록 (자동완성 경유)
 *   3) 결과 화면에서 중간지점·각자 소요시간·경로 확인
 *
 *   사용법: node server/index.mjs & node test/e2e.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.E2E_BASE || 'http://localhost:3000';
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let failures = 0;
const log = (s) => console.log(s);
function check(label, cond, detail) {
  if (cond) log(`   ok   ${label}${detail ? '  — ' + detail : ''}`);
  else { failures++; log(`   FAIL ${label}${detail ? '  — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 브라우저 한 개를 띄운다 (한 명의 참여자에 해당) */
async function openPage(search = '') {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) console.error('  [page error]', e.message); });

  const dom = new JSDOM(html, {
    url: BASE + '/' + search,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.fetch = (input, init) => fetch(String(input).startsWith('http') ? input : BASE + input, init);
      win.scrollTo = () => {};
      Object.defineProperty(win.document, 'hidden', { value: false });
      const store = new Map();
      Object.defineProperty(win, 'localStorage', {
        value: {
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k),
        },
      });
    },
  });

  // config.js / app.js 는 jsdom 이 상대경로로 못 가져오므로 직접 주입
  const win = dom.window;
  win.GAUNDE_API = BASE;
  const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  win.eval(appjs);
  await sleep(300);   // /api/stations, /api/meta 로딩 대기
  return dom;
}

const type = (win, id, value) => {
  const el = win.document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
};
const click = (win, id) => win.document.getElementById(id).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
const text = (win, id) => win.document.getElementById(id).textContent.trim();
const visible = (win, n) => win.document.getElementById('s' + n).classList.contains('on');

/* ================================================================= */
log('\n■ 1단계 — 주최자가 모임을 만든다');
const host = await openPage();
const hostWin = host.window;

check('첫 화면은 STEP 1', visible(hostWin, 0), text(hostWin, 'eyebrow'));
check('역 목록 로딩됨', hostWin.document.querySelectorAll('#quick .chip').length === 6);

type(hostWin, 'mname', '금요일 저녁 모임');
click(hostWin, 'make');
await sleep(600);

const shareUrl = text(hostWin, 'linktext');
check('공유 링크 발급됨', /\?m=[a-z0-9]{10}$/.test(shareUrl), shareUrl);
const token = shareUrl.split('?m=')[1];
check('링크 박스 노출', hostWin.document.getElementById('made').hidden === false);

/* ================================================================= */
log('\n■ 2단계 — 참여자 5명이 링크로 들어와 출발역을 고른다');
const PEOPLE = [
  ['규민', '강남'],
  ['지현', '사당'],
  ['태윤', '노원'],
  ['민서', '홍대'],        // 부분 입력 → 자동완성으로 '홍대입구' 선택
  ['현우', '잠실'],
];

let lastWin = null;
for (const [name, query] of PEOPLE) {
  const dom = await openPage('?m=' + token);
  const win = dom.window;
  await sleep(250);

  if (name === '규민') {
    check('링크로 들어오면 STEP 2', visible(win, 1), text(win, 'eyebrow'));
    check('모임 이름 표시', text(win, 'mtitle') === '금요일 저녁 모임', text(win, 'mtitle'));
  }

  type(win, 'pname', name);
  type(win, 'dep', query);
  await sleep(60);

  const options = [...win.document.querySelectorAll('#ac b')].map((b) => b.childNodes[0].textContent);
  if (name === '민서') {
    check("자동완성 '홍대' → 후보 제시", options.length > 0, options.join(', '));
  }
  // 첫 후보 선택
  win.document.querySelector('#ac b').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  await sleep(30);

  const submitDisabled = win.document.getElementById('submit').disabled;
  check(`${name}: 등록 버튼 활성화 (${win.document.getElementById('dep').value})`, !submitDisabled);

  click(win, 'submit');
  await sleep(400);
  lastWin = win;
}

await sleep(200);
check('참여현황 5명', text(lastWin, 'cnt') === '5명 등록', text(lastWin, 'cnt'));
const rows = [...lastWin.document.querySelectorAll('#rows .row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
rows.forEach((r) => log('        · ' + r));
check('로스터에 5명 렌더', rows.length === 5);
check('결과 보기 버튼 활성화', lastWin.document.getElementById('toresult').disabled === false,
  text(lastWin, 'toresult'));

/* 실시간 갱신: 다른 사람이 등록하면 폴링으로 반영되는가 */
log('\n■ 실시간 참여현황 — 다른 참여자가 추가되면 갱신되는지');
await fetch(`${BASE}/api/meetings/${token}/participants`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '수빈', station: '수원' }),
});
await sleep(4800);
check('폴링으로 6명 반영', text(lastWin, 'cnt') === '6명 등록', text(lastWin, 'cnt'));

/* ================================================================= */
log('\n■ 3단계 — 결과 화면');
click(lastWin, 'toresult');
await sleep(700);

check('STEP 3 로 이동', visible(lastWin, 2), text(lastWin, 'eyebrow'));
const title = text(lastWin, 'rtitle');
check('제목에 최대 소요시간', /다 같이 \d+분/.test(title), title);

const hit = lastWin.document.querySelector('#rmap .stop.hit .who');
check('중간지점 역 표시', !!hit && hit.textContent.length > 0, hit && hit.textContent);

const stops = [...lastWin.document.querySelectorAll('#rmap .stop:not(.hit)')]
  .map((s) => s.textContent.replace(/\s+/g, ' ').trim());
stops.forEach((s) => log('        · ' + s));
check('참여자 6명 경로 모두 표시', stops.length === 6, stops.length + '개');
check('각 행에 소요시간·노선', stops.every((s) => /\d+분/.test(s)));

const verdict = text(lastWin, 'verdict');
log('        판정: ' + verdict.replace(/\s+/g, ' '));
check('판정 문구 생성', /기준으로 \d+분/.test(verdict));
check('다른 후보 노출', lastWin.document.getElementById('alts').hidden === false);

const footer = text(lastWin, 'cov');
check('데이터 커버리지 각주', /실측 \d+%/.test(footer), footer);

/* ================================================================= */
log('\n■ 측정 이벤트 — 공유 버튼');
const before = await fetch(`${BASE}/api/stats`).then((r) => r.json());
click(lastWin, 'share');
await sleep(500);
const after = await fetch(`${BASE}/api/stats`).then((r) => r.json());
check('share_clicked 기록됨',
  after.events.share_clicked === before.events.share_clicked + 1,
  `${before.events.share_clicked} → ${after.events.share_clicked}`);

log('\n■ 이벤트 4종이 모두 쌓였는지');
for (const ev of ['room_created', 'origin_submitted', 'result_viewed', 'share_clicked']) {
  check(`${ev}`, after.events[ev] > 0, String(after.events[ev]) + '건');
}

log('\n■ /api/stats KPI');
log('        ' + JSON.stringify(after.kpi));
after.funnel.forEach((f) => log(`        ${f.step.padEnd(12)} ${String(f.meetings).padStart(3)}개  ${f.percentOfLinks}%`));
check('KPI 분모 = 생성된 링크 수', after.kpi.links >= 1);
check('3명 이상 모임이 전체 모임 수를 넘지 않음', after.kpi.roomsWith3Plus <= after.kpi.links);
check('퍼널이 단조 감소', after.funnel.every((f, i, a) => i === 0 || f.meetings <= a[i - 1].meetings),
  after.funnel.map((f) => f.meetings).join(' ≥ '));
check('이번 모임이 3명 이상으로 집계됨', after.kpi.roomsWith3Plus >= 1);

/* ================================================================= */
log(failures === 0 ? '\n✅ end-to-end 전 과정 통과' : `\n❌ 실패 ${failures}건`);
process.exit(failures === 0 ? 0 : 1);
