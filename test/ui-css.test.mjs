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

  test('pop 키프레임은 from/to 를 모두 갖는다', () => {
    // backwards 는 "from 상태" 를 지연 구간에 적용하므로 from 이 반드시 있어야 한다
    const kf = css.match(/@keyframes\s+pop\s*\{([\s\S]*?)\}\s*\n/);
    assert.ok(kf, 'pop 키프레임을 찾지 못했다');
    assert.match(kf[1], /from\s*\{/, 'from 이 없으면 backwards 가 쓸 상태가 없다');
    assert.match(kf[1], /to\s*\{/);
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
