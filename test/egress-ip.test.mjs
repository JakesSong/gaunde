/**
 * 아웃바운드 IP 조회 검증.
 * 실제 외부 호출은 하지 않는다 — fetch 를 목으로 갈아끼운다.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupEgressIp, isIp, PROVIDERS } from '../server/egress-ip.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

let calls;
function mockFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init, calls.length - 1);
  };
}
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const textRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => { throw new Error('not json'); },
  text: async () => body,
});

describe('IP 형식 판별', () => {
  test('정상 IP 는 통과', () => {
    for (const v of ['74.220.52.137', '1.2.3.4', '255.255.255.255', '2001:db8::1', '::1']) {
      assert.ok(isIp(v), v);
    }
  });
  test('IP 가 아닌 응답은 걸러낸다', () => {
    for (const v of ['', null, undefined, '256.1.1.1', '1.2.3', '1.2.3.4.5',
      '<!DOCTYPE html><html>...', 'error', '1.2.3.four', 'a'.repeat(60)]) {
      assert.equal(isIp(v), false, JSON.stringify(v));
    }
  });
});

describe('조회', () => {
  test('ipify 를 먼저 쓰고 결과를 그대로 돌려준다', async () => {
    mockFetch(() => jsonRes({ ip: '74.220.52.137' }));
    const r = await lookupEgressIp();
    assert.equal(r.ok, true);
    assert.equal(r.ip, '74.220.52.137');
    assert.equal(r.source, 'ipify');
    assert.match(r.checkedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(calls.length, 1, '첫 제공자가 성공하면 두 번째는 부르지 않는다');
    assert.match(calls[0], /api\.ipify\.org/);
  });

  test('ipify 가 죽으면 ifconfig.me 로 넘어간다', async () => {
    mockFetch((url) => (url.includes('ipify') ? jsonRes({}, 500) : textRes('74.220.60.21\n')));
    const r = await lookupEgressIp();
    assert.equal(r.ok, true);
    assert.equal(r.ip, '74.220.60.21', '개행이 붙어도 잘라내야 한다');
    assert.equal(r.source, 'ifconfig.me');
    assert.equal(calls.length, 2);
  });

  test('ipify 가 IP 아닌 걸 주면(HTML 등) 폴백한다', async () => {
    mockFetch((url) => (url.includes('ipify')
      ? textRes('<!DOCTYPE html><html>blocked</html>')
      : textRes('74.220.52.9')));
    const r = await lookupEgressIp();
    assert.equal(r.ip, '74.220.52.9');
    assert.equal(r.source, 'ifconfig.me');
  });

  test('둘 다 실패하면 실패 사유를 모아 돌려준다', async () => {
    mockFetch((url) => {
      if (url.includes('ipify')) throw new Error('ECONNREFUSED');
      return jsonRes({}, 503);
    });
    const r = await lookupEgressIp();
    assert.equal(r.ok, false);
    assert.equal(r.tried.length, PROVIDERS.length);
    assert.match(r.tried[0], /ipify: ECONNREFUSED/);
    assert.match(r.tried[1], /ifconfig\.me: HTTP 503/);
  });

  test('타임아웃도 사유에 남고 전체를 죽이지 않는다', async () => {
    mockFetch(() => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
    const r = await lookupEgressIp({ timeoutMs: 5000 });
    assert.equal(r.ok, false);
    assert.ok(r.tried.every((t) => /timeout\(5000ms\)/.test(t)), r.tried.join(' | '));
  });

  test('타임아웃 신호를 실제로 건다', async () => {
    let signal;
    mockFetch((_u, init) => { signal = init?.signal; return jsonRes({ ip: '1.2.3.4' }); });
    await lookupEgressIp({ timeoutMs: 5000 });
    assert.ok(signal, 'AbortSignal 이 전달되지 않았다');
    assert.equal(typeof signal.aborted, 'boolean');
  });

  test('캐시하지 않는다 — 부를 때마다 실제로 조회한다', async () => {
    let n = 0;
    mockFetch(() => jsonRes({ ip: `74.220.52.${++n}` }));
    const a = await lookupEgressIp();
    const b = await lookupEgressIp();
    assert.equal(a.ip, '74.220.52.1');
    assert.equal(b.ip, '74.220.52.2', 'IP 로테이션을 감지하려면 매번 새로 물어야 한다');
    assert.equal(calls.length, 2);
  });
});
