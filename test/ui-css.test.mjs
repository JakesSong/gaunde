/**
 * 화면 CSS 불변식.
 *
 * jsdom e2e 는 DOM 이 만들어졌는지만 보고 CSS 는 적용하지 않는다.
 * 그래서 "노드는 다 있는데 화면엔 안 보이는" 종류의 버그를 놓친다 —
 * 실제로 iOS 저전력 모드에서 결과 다이어그램이 통째로 비어 보이는 사고가 났다.
 * 원인은 .stop 이 opacity:0 으로 시작해 animation 이 켜 주기를 기다린 것이었고,
 * 브라우저가 애니메이션을 건너뛰자 영영 안 보였다.
 *
 * 여기서는 그 패턴이 다시 들어오지 못하게 CSS 를 정적으로 검사한다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];

/** @keyframes 블록을 걷어낸 나머지 (키프레임 안의 opacity:0 은 정상이다) */
function withoutKeyframes(text) {
  return text.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\}\s*)*\}/g, '');
}

/** 주석을 걷어낸다 (설명문에 든 예시 코드가 걸리지 않게) */
const body = withoutKeyframes(css).replace(/\/\*[\s\S]*?\*\//g, '');

describe('캐시버스팅', () => {
  test('스크립트 태그에 내용 해시 버전이 붙어 있다', () => {
    /* GitHub Pages + Safari 조합에서 강제 새로고침으로도 예전 app.js 를
       계속 쓰는 일이 있어, 파일이 바뀌면 URL 도 바뀌게 해 둔다. */
    const tags = [...html.matchAll(/<script\s+src="\.\/([\w.-]+\.js)(\?v=([0-9a-f]+))?"/g)];
    assert.ok(tags.length >= 2, `스크립트 태그가 너무 적다 (${tags.length})`);
    for (const [, file, , v] of tags) {
      assert.ok(v, `${file} 에 ?v= 버전이 없다 — npm run stamp 를 실행하세요`);
    }
  });

  test('버전이 실제 파일 내용과 일치한다 (stamp 를 빼먹지 않았는지)', async () => {
    const crypto = await import('node:crypto');
    const tags = [...html.matchAll(/<script\s+src="\.\/([\w.-]+\.js)\?v=([0-9a-f]+)"/g)];
    for (const [, file, v] of tags) {
      const buf = fs.readFileSync(path.join(ROOT, 'public', file));
      const want = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
      assert.equal(v, want, `${file} 의 버전이 내용과 다르다 — npm run stamp 필요`);
    }
  });
});

describe('CSS 가시성 불변식', () => {
  test('애니메이션이 안 돌아도 보이는 상태여야 한다 — opacity:0 을 기본값으로 두지 않는다', () => {
    /* @keyframes 밖에서 opacity:0 을 기본으로 두면,
       그걸 되돌리는 animation/transition 이 실행되지 않는 환경에서 영영 안 보인다.
       (iOS 저전력 모드, prefers-reduced-motion, 애니메이션 차단 확장 등) */
    const offenders = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(body))) {
      const selector = m[1].replace(/\s+/g, ' ').trim();
      const decls = m[2];
      if (/opacity\s*:\s*0\s*(;|$)/.test(decls)) offenders.push(selector);
    }
    assert.deepEqual(offenders, [],
      `기본 상태가 투명한 규칙: ${offenders.join(' / ')} — 애니메이션이 없으면 안 보인다`);
  });

  test('참여자 줄은 가로 배치를 .stopmain 에 맡긴다 (경로 펼침이 줄을 깨지 않게)', () => {
    /* .stop 이 직접 flex 면 아래에 붙는 경로 상세가 같은 줄로 밀려 들어간다.
       .node 의 offsetParent 는 .stop(position:relative) 이어야 레일 색칠 계산이 유효하다. */
    const stop = body.match(/(^|\})\s*\.stop\s*\{([^}]*)\}/);
    assert.ok(stop, '.stop 규칙을 찾지 못했다');
    assert.match(stop[2], /position:\s*relative/, '.stop 이 position:relative 가 아니다');
    assert.ok(!/display:\s*flex/.test(stop[2]), '.stop 이 아직 직접 flex 다');
    assert.match(body, /\.stopmain\s*\{[^}]*display:\s*flex/, '.stopmain 가로 배치 규칙이 없다');
  });

  test('.stop 은 animation-fill-mode:backwards 로 "들어오는 동안만" 숨긴다', () => {
    const rule = body.match(/(^|\})\s*\.stop\s*\{([^}]*)\}/);
    assert.ok(rule, '.stop 규칙을 찾지 못했다');
    const decls = rule[2];
    assert.match(decls, /animation\s*:[^;]*backwards/,
      '.stop 의 animation-fill-mode 가 backwards 가 아니다 (forwards 면 시작 상태가 화면에 남는다)');
    assert.ok(!/opacity/.test(decls), '.stop 기본값에 opacity 를 두지 않는다');
  });

  test('등장 애니메이션은 opacity 를 건드리지 않는다', () => {
    /* animation-fill-mode:backwards 는 지연 구간에 from 상태를 적용한다.
       from 에 opacity:0 이 있으면, 애니메이션이 진행되지 않는 환경에서
       그 상태로 굳어 영영 안 보인다 (배포본에서 실제로 발생).
       transform 만 쓰면 최악의 경우에도 살짝 밀린 채 보인다. */
    const kf = css.match(/@keyframes\s+pop\s*\{([\s\S]*?)\}\s*\n/);
    assert.ok(kf, 'pop 키프레임을 찾지 못했다');
    assert.match(kf[1], /from\s*\{/);
    assert.match(kf[1], /to\s*\{/);
    assert.ok(!/opacity/.test(kf[1]),
      `pop 키프레임이 opacity 를 애니메이션한다: ${kf[1].trim()}`);
  });

  test('fill-mode:backwards 를 쓰는 규칙의 키프레임에는 opacity 가 없어야 한다', () => {
    // 앞으로 다른 애니메이션이 추가돼도 같은 함정에 빠지지 않게 일반화한다
    const rules = [...body.matchAll(/([^{}]+)\{([^{}]*animation:[^;}]*backwards[^;}]*)[;}]/g)];
    for (const [, selector, decls] of rules) {
      const name = (decls.match(/animation:\s*([\w-]+)/) || [])[1];
      if (!name) continue;
      const kf = css.match(new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\}\\s*\\n'));
      if (!kf) continue;
      assert.ok(!/opacity/.test(kf[1]),
        `${selector.trim()} 이 backwards 로 쓰는 @keyframes ${name} 에 opacity 가 있다`);
    }
  });

  test('피드백 블록은 점선 박스다 (안 A)', () => {
    const rule = body.match(/(^|\})\s*\.fb\s*\{([^}]*)\}/);
    assert.ok(rule, '.fb 규칙을 찾지 못했다');
    const d = rule[2];
    assert.match(d, /border:\s*1px dashed/, '점선 테두리가 없다');
    assert.match(d, /border-radius:\s*12px/);
    assert.match(d, /padding:\s*12px/);
    assert.match(d, /background:\s*var\(--fb-bg\)/, '배경이 토큰으로 지정되지 않았다');
  });

  test('피드백 박스 안 글자가 배경 대비 4.5:1 을 넘는다', () => {
    /* 연초록 배경에 기존 회색(--sub)을 그대로 두면 3.56:1 로 미달이라
       박스를 넣을 때 글자색도 같이 올렸다. 되돌아가지 않게 못 박는다. */
    const tok = (name) => (css.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})')) || [])[1];
    const lum = (hex) => {
      const v = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const ratio = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const bg = tok('fb-bg');
    assert.ok(bg, '--fb-bg 토큰이 없다');
    for (const name of ['fb-ink', 'fb-ok']) {
      const fg = tok(name);
      assert.ok(fg, `--${name} 토큰이 없다`);
      const r = ratio(fg, bg);
      assert.ok(r >= 4.5, `--${name}(${fg}) 가 --fb-bg(${bg}) 위에서 ${r.toFixed(2)}:1 — 4.5 미만`);
    }
  });

  test('피드백 테두리는 앱 초록과 같은 값이다', () => {
    // 다른 초록(#12b869 등)을 쓰면 브랜드 마크·레일과 미묘하게 어긋난다
    const line = (css.match(/--line:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
    const fbLine = (css.match(/--fb-line:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
    assert.equal(fbLine.toUpperCase(), line.toUpperCase(),
      `--fb-line(${fbLine}) 이 앱 초록 --line(${line}) 과 다르다`);
  });

  test('hidden 속성이 display 규칙에 덮이지 않는다', () => {
    // .acts{display:flex} 같은 규칙이 있으면 hidden 속성만으로는 안 숨겨진다
    assert.match(body, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
      '[hidden]{display:none !important} 규칙이 없다');
  });

  test('reduced-motion 에서도 결과 노드가 보인다', () => {
    const mq = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\s*\}/);
    assert.ok(mq, 'prefers-reduced-motion 블록이 없다');
    assert.match(mq[1], /\.stop\s*\{[^}]*opacity:\s*1/, 'reduced-motion 에서 .stop 이 보이지 않는다');
  });
});

describe('다이어그램 읽기 보조', () => {
  test('노드는 애니메이션 없이도 색이 보이는 구조다', () => {
    /* 링을 border-color 대신 background 로 그린다 —
       환승역은 호선이 여러 개라 conic-gradient 가 필요하고,
       border-color 는 한 색밖에 못 받는다.
       가운데 흰 원은 ::after 로 뚫으므로 애니메이션과 무관하다. */
    const rule = body.match(/(^|\})\s*\.node\s*\{([^}]*)\}/);
    assert.ok(rule, '.node 규칙을 찾지 못했다');
    assert.match(rule[2], /background:/, '.node 에 background 링이 없다');
    assert.ok(!/border:\s*\dpx solid/.test(rule[2]),
      '.node 가 아직 border 로 링을 그린다 — 여러 호선 색을 못 준다');
    assert.match(body, /\.node::after\s*\{[^}]*background:#fff/, '가운데 흰 원(::after)이 없다');
  });

  test('범례가 노선도보다 위에 있다', () => {
    /* 그림을 다 읽은 뒤에 색 설명을 만나면 이미 잘못 읽은 뒤다.
       색의 뜻이 먼저 와야 한다. */
    const iLegend = html.indexOf('id="rlegend"');
    const iMap = html.indexOf('id="rmap"');
    assert.ok(iLegend > 0 && iMap > 0);
    assert.ok(iLegend < iMap, '범례(#rlegend)가 노선도(#rmap) 아래에 있다');
  });

  test('선정 근거는 접었다 펼치는 <details> 다', () => {
    // 첫 화면은 간결해야 한다는 피드백. 내용은 그대로 두고 기본만 접는다.
    const tag = html.match(/<details[^>]*id="rwhy"[^>]*>/);
    assert.ok(tag, '#rwhy 가 <details> 가 아니다');
    assert.ok(!/\bopen\b/.test(tag[0]), '#rwhy 가 기본 펼침이다');
    assert.match(html, /<summary>왜 이 역인가요\?<\/summary>/, '요약 제목(summary)이 없다');
    assert.match(html, /id="rwhybody"/, '근거 본문 컨테이너가 없다');
  });

  test('핵심 수치가 본문보다 크게 잡혀 있다', () => {
    const rule = body.match(/\.keys b\s*\{([^}]*)\}/);
    assert.ok(rule, '.keys b 규칙을 찾지 못했다');
    const size = Number((rule[1].match(/font-size:\s*([\d.]+)px/) || [])[1]);
    const lede = Number((body.match(/\.lede\s*\{[^}]*font-size:\s*([\d.]+)px/) || [])[1]);
    assert.ok(size >= lede + 5, `핵심 수치(${size}px)가 설명문(${lede}px)보다 충분히 크지 않다`);
  });

  test('시간축·범례·근거 블록이 기본 숨김으로 마크업돼 있다', () => {
    for (const id of ['raxis', 'rlegend', 'rwhy', 'rkeys', 'rbasis', 'rmarks', 'rstat']) {
      const tag = html.match(new RegExp('id="' + id + '"[^>]*>'));
      assert.ok(tag, `#${id} 마크업이 없다`);
      assert.match(tag[0], /hidden/, `#${id} 가 기본 숨김이 아니다 — 계산 전에 빈 상자가 보인다`);
    }
  });

  test('시간축·범례·근거는 공유 이미지(#shot) 안에 있다', () => {
    // html2canvas 는 #shot 만 뜬다. 밖에 두면 공유 이미지에서 설명이 빠진다.
    const shot = html.match(/id="shot"[\s\S]*?<!-- \/shot -->/);
    assert.ok(shot, '#shot 영역을 찾지 못했다');
    for (const id of ['raxis', 'rlegend', 'rwhy', 'rkeys', 'rbasis', 'rmarks']) {
      assert.ok(shot[0].includes('id="' + id + '"'), `#${id} 가 #shot 밖에 있다`);
    }
  });

  test('결과 화면에 중복 헤더가 없다 — 요약은 수치 타일 두 칸이 한다', () => {
    /* "정보가 너무 많다" 피드백. 큰 제목(가장 먼 사람도 N분)과 설명문(N명 · 평균 N분)이
       바로 아래 .keys 타일과 같은 숫자를 두 번 말하고 있었다. 되돌아오지 않게 못 박는다. */
    const shot = html.match(/id="shot"[\s\S]*?<!-- \/shot -->/)[0];
    assert.ok(!/<h2[^>]*id="rtitle"/.test(shot), '결과 헤더(h2#rtitle)가 다시 들어왔다');
    assert.ok(!/id="rlede"/.test(shot), '결과 설명문(#rlede)이 다시 들어왔다');
    const iStat = shot.indexOf('id="rstat"');
    const iKeys = shot.indexOf('id="rkeys"');
    assert.ok(iStat > 0, '상태 한 줄(#rstat)이 없다 — 계산 중·실패일 때 화면이 빈다');
    assert.ok(iStat < iKeys, '#rstat 이 수치 타일보다 아래에 있다');
    assert.match(body, /\.rstat\s*\{[^}]*font-size:/, '.rstat 스타일이 없다');
  });

  test('막차·방위 힌트 CSS 가 남아 있지 않다', () => {
    // 마크업을 지우고 CSS 만 남기면 다음 사람이 되살릴 근거로 쓴다
    assert.ok(!/\.compass\s*\{/.test(body), '.compass 규칙이 죽은 채 남아 있다');
    assert.ok(!/\.marks \.last\s*\{/.test(body), '.marks .last(막차) 규칙이 죽은 채 남아 있다');
    assert.ok(!/\.lgnote/.test(body), '.lgnote(범례 해설) 규칙이 죽은 채 남아 있다');
  });

  test('맛집·카페 버튼이 어디로 가는지 적혀 있다', () => {
    // 눌러보기 전에는 카카오맵이 열린다는 걸 알 수 없었다
    for (const id of ['food', 'cafe']) {
      const tag = html.match(new RegExp('id="' + id + '"[^>]*>([^<]*<small>[^<]*</small>)?'));
      assert.ok(tag, `#${id} 마크업이 없다`);
    }
    const acts = html.match(/<div class="acts"[\s\S]*?<\/div>/);
    assert.equal((acts[0].match(/카카오맵에서 보기/g) || []).length, 2,
      '맛집·카페 두 버튼 모두에 "카카오맵에서 보기" 가 있어야 한다');
  });

  test('개인정보 한 줄이 입력 화면과 결과 화면에 다 있다', () => {
    const priv = html.match(/<p class="priv">[\s\S]*?<\/p>/g) || [];
    assert.ok(priv.length >= 2, `개인정보 문구가 ${priv.length}곳뿐이다 (입력·결과 두 화면 필요)`);
    for (const p of priv) {
      assert.match(p, /이름과 출발역/, '무엇을 수집하는지 적혀 있지 않다');
      assert.match(p, /IP·쿠키/, '무엇을 수집하지 않는지 적혀 있지 않다');
      /* 기기 식별자는 실제로 localStorage 에 남는다. 안 남는다고 쓰면 거짓말이 된다. */
      assert.match(p, /식별자/, '브라우저에 남는 식별자를 밝히지 않았다');
    }
  });

  test('상단 진행 표시가 점 3개(⋯ 메뉴)로 보이지 않는다', () => {
    /* 우측 상단 동그란 점 3개가 "⋯ 메뉴" 로 읽혀 눌러도 아무 일이 없다는 피드백.
       납작한 막대로 두어 진행 표시로만 읽히게 한다. */
    const rule = body.match(/(^|\})\s*\.dot\s*\{([^}]*)\}/);
    assert.ok(rule, '.dot 규칙을 찾지 못했다');
    assert.ok(!/border-radius:\s*50%/.test(rule[2]), '.dot 이 아직 원형이다');
    const w = Number((rule[2].match(/width:\s*([\d.]+)px/) || [])[1]);
    const h = Number((rule[2].match(/height:\s*([\d.]+)px/) || [])[1]);
    assert.ok(w >= h * 2, `.dot 이 가로로 길지 않다 (${w}×${h})`);
  });

  test('카카오 앱키를 코드에 박지 않는다', () => {
    /* 시크릿은 아니지만 도메인이 묶인 키라 저장소에 박아두면 갈아끼우기 어렵다.
       app.js 는 window.KAKAO_KEY 만 읽어야 한다. */
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    assert.match(app, /window\.KAKAO_KEY/, 'app.js 가 주입된 키를 읽지 않는다');
    const cfg = fs.readFileSync(path.join(ROOT, 'public', 'config.js'), 'utf8');
    const assigned = cfg.match(/window\.KAKAO_KEY\s*=\s*window\.KAKAO_KEY\s*\|\|\s*'([^']*)'/);
    assert.ok(assigned, 'config.js 에 KAKAO_KEY 자리가 없다');
    assert.equal(assigned[1], '', '저장소에 실제 키가 커밋돼 있다');
  });

  test('범례 점 색은 인라인 --c 토큰으로 받는다', () => {
    // 색이 데이터(graph.json)에서 오므로 CSS 에 고정할 수 없다
    assert.match(body, /\.legend i::before\s*\{[^}]*background:var\(--c\)/);
  });
});
