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
