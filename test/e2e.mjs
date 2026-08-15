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

/** 조건이 참이 될 때까지 기다린다.
 *  결과 계산은 ODsay 를 붙이면 수 초가 걸릴 수 있어 고정 대기로는 불안정하다. */
async function waitFor(fn, { timeout = 20000, step = 150 } = {}) {
  const until = Date.now() + timeout;
  for (;;) {
    try { if (fn()) return true; } catch { /* 아직 렌더 전 */ }
    if (Date.now() > until) return false;
    await sleep(step);
  }
}

/** 브라우저 한 개를 띄운다 (한 명의 참여자에 해당).
 *  localStorage 는 페이지마다 새로 만든다 = 참여자마다 다른 기기.
 *  같은 기기를 재현하려면 store 를 넘겨 공유한다 (실제 브라우저의 오리진 단위 저장소처럼). */
async function openPage(search = '', { store: sharedStore } = {}) {
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
      const store = sharedStore || new Map();
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
let lastStore = null;
for (const [name, query] of PEOPLE) {
  const store = new Map();
  const dom = await openPage('?m=' + token, { store });
  const win = dom.window;
  lastStore = store;
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
const rendered = await waitFor(() => /\d+분/.test(text(lastWin, 'rtitle')));
check('결과 렌더 완료', rendered, text(lastWin, 'rtitle'));
check('STEP 3 로 이동', visible(lastWin, 2), text(lastWin, 'eyebrow'));
const title = text(lastWin, 'rtitle');
check('제목에 최대 소요시간', /가장 먼 사람도 \d+분/.test(title), title);

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
log('\n■ 결과 화면 개편 확인');
check('문구가 "가장 먼 사람도 N분"', /가장 먼 사람도 \d+분/.test(title), title);
check('평균·요금 표기', /평균 \d+분 · 1인 [\d,]+원/.test(text(lastWin, 'rlede')), text(lastWin, 'rlede'));
const foodHref = decodeURIComponent(lastWin.document.getElementById('food').href);
const cafeHref = decodeURIComponent(lastWin.document.getElementById('cafe').href);
check('맛집·카페 버튼이 카카오맵으로', /map\.kakao\.com\/\?q=.+맛집$/.test(foodHref) && /카페$/.test(cafeHref),
  foodHref + ' / ' + cafeHref);
check('맛집 링크가 새 탭으로', lastWin.document.getElementById('food').target === '_blank');
check('세로 간격이 소요시간에 비례',
  [...lastWin.document.querySelectorAll('#rmap .stop:not(.hit)')].some((s) => /margin-(top|bottom):\s*\d+px/.test(s.getAttribute('style') || '')));

/* 먼 사람이 바깥, 가까운 사람이 만날 역 쪽에 와야 한다.
   예전엔 위쪽 그룹을 뒤집어서 가장 가까운 사람이 제일 멀리 그려졌다. */
{
  const all = [...lastWin.document.querySelectorAll('#rmap .stop')];
  const hitAt = all.findIndex((s) => s.classList.contains('hit'));
  const mins = (el) => Number((el.querySelector('.mins')?.textContent || '').match(/(\d+)분/)?.[1] ?? -1);
  const above = all.slice(0, hitAt).map(mins);
  const below = all.slice(hitAt + 1).map(mins);
  check('위쪽은 먼 사람 → 가까운 사람 순', above.every((v, i) => i === 0 || above[i - 1] >= v), above.join(' ≥ '));
  check('아래쪽은 가까운 사람 → 먼 사람 순', below.every((v, i) => i === 0 || below[i - 1] <= v), below.join(' ≤ '));
}

/* ================================================================= */
log('\n■ 다이어그램 읽는 법 — 시간축 · 호선색 · 환승 · 근거');
{
  const doc = lastWin.document;

  // 5. 세로축이 소요시간임을 밝힌다 (지도로 오해하지 않게)
  const axis = doc.getElementById('raxis');
  check('시간축 설명 노출', axis && !axis.hidden, axis && axis.textContent);
  check('세로 = 소요시간, 지도 아님', /소요시간/.test(axis.textContent) && /지도/.test(axis.textContent));

  // 6. 노드 색이 실제 호선 색 (jsdom 은 레이아웃이 없어 레일 그라데이션은 못 잰다 → 인라인 색으로 본다)
  const nodes = [...doc.querySelectorAll('#rmap .stop:not(.hit) .node')];
  const painted = nodes.filter((n) => /background/.test(n.getAttribute('style') || ''));
  check('참여자 노드에 호선색', painted.length === nodes.length, painted.length + '/' + nodes.length);
  const hubNode = doc.querySelector('#rmap .stop.hit .node');
  const hubStyle = hubNode.getAttribute('style') || '';
  check('만날 역 노드에도 호선색', /background/.test(hubStyle), hubStyle);
  check('환승역이면 여러 색을 두른다',
    doc.querySelector('#rmap .stop.hit .who').textContent.length > 0 &&
    (/conic-gradient/.test(hubStyle) || /background:#/.test(hubStyle.replace(/\s/g, ''))), hubStyle);
  const legend = doc.getElementById('rlegend');
  check('호선 색 범례 노출', legend && !legend.hidden && legend.querySelectorAll('i').length > 0,
    legend && legend.textContent);
  check('범례 색이 실제 hex', [...legend.querySelectorAll('i')]
    .every((i) => /--c:\s*#[0-9a-fA-F]{3,8}/.test(i.getAttribute('style') || '')));

  /* 2. 환승이 계산에 들어갔다는 것을 행마다 밝힌다.
     단 만날 역에 이미 있는 사람(0분)은 타는 구간 자체가 없다 —
     그 줄에 "직통" 을 적으면 오히려 거짓말이 되므로 빼고 본다. */
  const minsTexts = [...doc.querySelectorAll('#rmap .stop:not(.hit) .mins')].map((m) => m.textContent);
  const riding = minsTexts.filter((t) => !/^0분/.test(t.trim()));
  check('이동하는 행마다 환승 횟수/직통 표기',
    riding.length > 0 && riding.every((t) => /환승 \d+회|직통/.test(t)), riding[0]);
  check('0분(이미 그 역) 줄엔 환승 표기 없음',
    minsTexts.filter((t) => /^0분/.test(t.trim())).every((t) => !/환승|직통/.test(t)));
  check('환승 있는 사람은 횟수로 표기', minsTexts.some((t) => /환승 \d+회/.test(t)),
    minsTexts.find((t) => /환승/.test(t)));

  // 3. 왜 이 역인지
  const why = doc.getElementById('rwhy');
  check('선정 근거 노출', why && !why.hidden, why && why.textContent.replace(/\s+/g, ' ').slice(0, 90));
  const whyText = why.textContent.replace(/\s+/g, ' ');
  check('근거에 최소최대 기준선', /가장 먼 사람.*아무리 줄여도 \d+분이 최선/.test(whyText));
  check('근거에 허용 오차 밴드', /±\d+분/.test(whyText));
  check('근거에 합계로 골랐다는 2단계', /모두의 시간을 합쳐 가장 짧은/.test(whyText));
  check('근거에 환승시간 포함 문구', /환승 대기[·, ]?환승 도보 시간이 모두 들어/.test(whyText));

  /* 실제 선택 규칙은 "밴드 안에서 합이 최소" 다. 추천역의 최댓값이 곧 최솟값이라고
     쓰면 거짓이 된다 — 후보 목록에 최댓값이 더 작은 역이 보이는 경우가 실제로 있다.
     (예: 추천 사당 50분인데 대안 노량진이 48분) 그 문장이 돌아오면 여기서 잡는다. */
  check('추천역이 최댓값 최소라고 주장하지 않는다',
    !/가장 먼 사람의 시간이 가장 짧은 곳/.test(whyText), whyText.slice(0, 80));
  {
    const res = await fetch(`${BASE}/api/meetings/${token}/result`).then((r) => r.json());
    const floor = Math.round(res.selection.minMaxSec / 60);
    check('근거의 기준선이 응답의 minMaxSec 과 일치',
      new RegExp('줄여도 ' + floor + '분').test(whyText), `minMaxSec=${floor}분 / ${whyText.slice(0, 70)}`);
    const lowerMaxAlt = res.alternatives.find((a) => a.maxMin < res.best.maxMin);
    check('추천보다 최댓값이 작은 대안이 있어도 근거가 모순되지 않는다',
      !lowerMaxAlt || /합쳐 가장 짧은/.test(whyText),
      lowerMaxAlt ? `${lowerMaxAlt.station.name} ${lowerMaxAlt.maxMin}분 < 추천 ${res.best.maxMin}분` : '해당 없음');
  }
}

const altBtns = [...lastWin.document.querySelectorAll('#altrows .altrow')];
check('후보 목록이 버튼으로 렌더', altBtns.length >= 2, altBtns.length + '개');
// 4. 후보가 많다는 피드백 → 추천 1 + 대안 2 = 3개로 줄였다
check('후보를 3개만 보여준다', altBtns.length === 3, altBtns.length + '개');
check('첫 후보가 선택 상태', altBtns[0].classList.contains('on'));
const beforeHit = lastWin.document.querySelector('#rmap .stop.hit .who').textContent;
altBtns[1].dispatchEvent(new lastWin.MouseEvent('click', { bubbles: true }));
await sleep(200);
const afterHit = lastWin.document.querySelector('#rmap .stop.hit .who').textContent;
check('다른 후보 클릭 → 그 역 기준으로 재계산 표시', beforeHit !== afterHit, `${beforeHit} → ${afterHit}`);
check('선택 표시가 옮겨감', altBtns[1].classList.contains('on') && !altBtns[0].classList.contains('on'));
altBtns[0].dispatchEvent(new lastWin.MouseEvent('click', { bubbles: true }));
await sleep(150);

/* ================================================================= */
log('\n■ 같은 역 참여자 병합 + 수정/삭제');
{
  // 같은 역에서 출발하는 두 명을 추가로 넣어 한 줄로 묶이는지 본다
  for (const n of ['동현', '유진']) {
    await fetch(`${BASE}/api/meetings/${token}/participants`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: n, station: '사당', clientId: 'cid-' + n }),
    });
  }
  const page2 = await openPage('?m=' + token + '&r=1');
  const w = page2.window;
  await waitFor(() => w.document.querySelectorAll('#rmap .stop').length > 1);
  check('딥링크 ?r=1 → 결과 화면 바로', visible(w, 2), text(w, 'eyebrow'));

  const rows2 = [...w.document.querySelectorAll('#rmap .stop:not(.hit)')].map((s) => s.textContent.replace(/\s+/g, ' ').trim());
  rows2.forEach((s) => log('        · ' + s));
  const sadang = rows2.filter((r) => r.includes('사당'));
  check('사당 출발 3명이 한 줄로 병합', sadang.length === 1, sadang.join(' | '));
  check('병합된 줄에 이름이 함께 표기', /지현·동현·유진|동현|유진/.test(sadang[0] || ''), sadang[0]);
}
{
  const w = (await openPage('?m=' + token)).window;
  await sleep(400);
  const before = w.document.querySelectorAll('#rows .row').length;
  const delBtn = w.document.querySelector('#rows .row .tool[data-act="del"]');
  check('로스터에 수정/삭제 버튼', !!delBtn && !!w.document.querySelector('#rows .tool[data-act="edit"]'));
  w.confirm = () => true;
  delBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await sleep(500);
  const after = w.document.querySelectorAll('#rows .row').length;
  check('삭제가 반영됨', after === before - 1, `${before}명 → ${after}명`);
}

/* ================================================================= */
log('\n■ 결과 스냅샷 캐시');
{
  const health = () => fetch(`${BASE}/api/health`).then((r) => r.json());
  const get = () => fetch(`${BASE}/api/meetings/${token}/result`).then((r) => r.json());

  const h0 = await health();
  const t0 = Date.now(); const a = await get(); const ms1 = Date.now() - t0;
  const h1 = await health();
  const t1 = Date.now(); const b = await get(); const ms2 = Date.now() - t1;
  const h2 = await health();

  log(`        1차 ${ms1}ms (miss) → 2차 ${ms2}ms (hit)`);
  check('첫 호출은 캐시 미스', h1.resultCache.misses === h0.resultCache.misses + 1,
    `misses ${h0.resultCache.misses} → ${h1.resultCache.misses}`);
  check('두 번째 호출은 캐시 히트', h2.resultCache.hits === h1.resultCache.hits + 1
    && h2.resultCache.misses === h1.resultCache.misses,
    `hits ${h1.resultCache.hits} → ${h2.resultCache.hits}`);
  check('캐시 히트가 재계산보다 빠르다', ms2 <= ms1, `${ms1}ms → ${ms2}ms`);
  check('cached 플래그가 구분된다', a.selection.cached === false && b.selection.cached === true,
    `${a.selection.cached} → ${b.selection.cached}`);

  const strip = (x) => { const c = { ...x, selection: { ...x.selection } }; delete c.selection.cached; return JSON.stringify(c); };
  check('응답 내용이 동일하다', strip(a) === strip(b));

  // 구성이 바뀌면 다시 계산한다
  const pid = a.meeting.participants[0].id;
  await fetch(`${BASE}/api/meetings/${token}/participants/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station: '수원' }),
  });
  const h3 = await health();
  const c = await get();
  const h4 = await health();
  check('참여자 변경 후엔 재계산한다', h4.resultCache.misses === h3.resultCache.misses + 1,
    `misses ${h3.resultCache.misses} → ${h4.resultCache.misses}`);
  check('바뀐 출발역이 결과에 반영된다', c.best.routes.some((r) => r.origin === '수원'),
    c.best.routes.map((r) => r.origin).join(', '));

  // 되돌려서 이후 검사에 영향 없게
  await fetch(`${BASE}/api/meetings/${token}/participants/${pid}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ station: a.meeting.participants[0].station }),
  });
  await get();
}

/* ================================================================= */
/* 이 블록은 결과를 여러 번 부르므로 "첫 호출은 캐시 미스" 를 보는
   결과 스냅샷 캐시 블록보다 뒤에 있어야 한다. */
log('\n■ 로딩 문구 — 진입 경로에 따라 달라진다');
{
  /* 처음 계산하는 진입은 "계산하는 중", 이미 계산된 걸 다시 보는 진입은 "불러오는 중".
     응답이 오면 문구는 결과로 덮이므로, 누르는 즉시(응답 전) 무엇이 떠 있는지를 본다. */
  const fresh = (await openPage('?m=' + token)).window;
  await sleep(400);
  fresh.document.getElementById('toresult').dispatchEvent(new fresh.MouseEvent('click', { bubbles: true }));
  const firstText = text(fresh, 'rtitle');
  check('첫 계산은 "계산하는 중…"', /계산하는 중/.test(firstText), firstText);
  await waitFor(() => /\d+분/.test(text(fresh, 'rtitle')));

  // 딥링크 재진입 (다른 기기여도 결과 링크면 이미 계산된 것)
  const deep = (await openPage('?m=' + token + '&r=1')).window;
  const deepText = await waitFor(() => /불러오는 중/.test(text(deep, 'rtitle')) || /\d+분/.test(text(deep, 'rtitle')))
    ? text(deep, 'rtitle') : text(deep, 'rtitle');
  check('딥링크 재진입은 "결과 불러오는 중…"',
    /불러오는 중/.test(deepText) || /\d+분/.test(deepText), deepText);

  // 같은 기기에서 두 번째로 결과 보기 → 이미 본 모임이므로 불러오는 중
  const store = new Map();
  const again1 = (await openPage('?m=' + token, { store })).window;
  await sleep(400);
  again1.document.getElementById('toresult').dispatchEvent(new again1.MouseEvent('click', { bubbles: true }));
  await waitFor(() => /\d+분/.test(text(again1, 'rtitle')));

  const again2 = (await openPage('?m=' + token, { store })).window;
  await sleep(400);
  again2.document.getElementById('toresult').dispatchEvent(new again2.MouseEvent('click', { bubbles: true }));
  const againText = text(again2, 'rtitle');
  check('같은 기기 재조회도 "불러오는 중…"', /불러오는 중/.test(againText), againText);
}

/* ================================================================= */
log('\n■ 결과 피드백 (위치 A)');
{
  const doc = lastWin.document;
  // 위치: 요약카드 아래, 맛집/카페 위
  const order = [...doc.querySelectorAll('#s2 > *')].map((el) => el.id || el.className);
  const iShot = order.findIndex((c) => c === 'shot');
  const iFb = order.findIndex((c) => c === 'fb');
  const iActs = order.findIndex((c) => c === 'acts');
  check('피드백이 요약카드 아래·맛집 위에 있다', iShot < iFb && iFb < iActs, order.join(' → '));
  check('피드백 블록 노출', doc.getElementById('fb').hidden === false);

  const before = await fetch(`${BASE}/api/stats`).then((r) => r.json());

  // 불만족 → 이유 칩 → 감사
  doc.querySelector('#fbvote .fbbtn[data-v="bad"]').dispatchEvent(new lastWin.MouseEvent('click', { bubbles: true }));
  await sleep(250);
  check('불만족 누르면 이유를 묻는다', doc.getElementById('fbwhy').hidden === false, text(lastWin, 'fbq'));
  check('투표 버튼은 사라진다', doc.getElementById('fbvote').hidden === true);

  doc.querySelector('#fbwhy .fbchip[data-r="many_transfers"]').dispatchEvent(new lastWin.MouseEvent('click', { bubbles: true }));
  await sleep(400);
  check('이유 고르면 감사 인라인', /고마워요/.test(text(lastWin, 'fbq')), text(lastWin, 'fbq'));
  check('이유 칩도 사라진다', doc.getElementById('fbwhy').hidden === true);

  const after = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  check('result_feedback 집계됨', after.feedback.sample === before.feedback.sample + 1,
    `표본 ${before.feedback.sample} → ${after.feedback.sample}`);
  check('불만족 이유 분포 반영', (after.feedback.badReasons.many_transfers || 0) > (before.feedback.badReasons.many_transfers || 0),
    JSON.stringify(after.feedback.badReasons));
  check('만족도 필드 구성', typeof after.feedback.satisfactionPercent === 'number' || after.feedback.satisfactionPercent === null,
    JSON.stringify(after.feedback));

  /* 쓰기 실패는 사용자 요청을 막지 않으려고 삼킨다. 그래서 삼킨 흔적이 밖에서 보여야
     "안 쌓이고 있다" 를 사람이 집계를 세어보기 전에 알 수 있다. */
  const wf = after.writeFailures;
  check('/api/stats 에 쓰기실패 카운터 노출', wf && typeof wf.feedback === 'number' && typeof wf.events === 'number',
    JSON.stringify(wf));
  check('이번 흐름에서 쓰기 실패 0건', wf.events === 0 && wf.feedback === 0, JSON.stringify(wf));
  const hw = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check('/api/health 에도 같은 카운터', hw.writeFailures && typeof hw.writeFailures.feedback === 'number',
    JSON.stringify(hw.writeFailures));

  // 다시 열면 이미 남긴 상태로 (같은 기기 = localStorage 공유)
  const again = (await openPage('?m=' + token + '&r=1', { store: lastStore })).window;
  await waitFor(() => again.document.querySelectorAll('#rmap .stop').length > 1);
  await sleep(200);
  check('다시 열어도 감사 상태 유지(같은 기기)', /고마워요/.test(again.document.getElementById('fbq').textContent),
    again.document.getElementById('fbq').textContent);
}

log('\n■ 다이어그램 높이 압축');
{
  const stops = [...lastWin.document.querySelectorAll('#rmap .stop')];
  const margins = stops.map((s) => {
    const st = s.getAttribute('style') || '';
    return Number((st.match(/margin-(?:top|bottom):\s*(\d+)px/) || [0, 0])[1]);
  });
  const total = margins.reduce((a, b) => a + b, 0);
  log('        여백 합계 ' + total + 'px  (' + margins.join(', ') + ')');
  check('여백 합계가 상한 안에 있다', total <= 200, total + 'px');
  check('노드가 붙지 않는다(최소 여백)', margins.filter((m) => m > 0).every((m) => m >= 6), margins.join(','));
  check('요금이 같은 줄에 (행 높이 축소)',
    !/<br>/.test(lastWin.document.querySelector('#rmap .stop:not(.hit) .mins').innerHTML));
}

/* ================================================================= */
log('\n■ 측정 이벤트 — 공유 버튼');
const before = await fetch(`${BASE}/api/stats`).then((r) => r.json());
// jsdom 에는 canvas 가 없어 html2canvas 가 안 돈다 → 링크 복사 폴백 경로를 탄다.
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
