/**
 * 서버의 공인 아웃바운드(egress) IP 조회.
 *
 * ODsay 처럼 호출자 IP 를 화이트리스트로 받는 서비스에 등록하려면
 * "이 서버가 밖으로 나갈 때 쓰는 IP" 를 알아야 한다.
 * 서버 자신은 그걸 모르므로 외부 에코 서비스에 물어본다.
 *
 * 캐시하지 않는다. Render 같은 환경은 인스턴스가 바뀌면 IP 도 바뀌므로
 * 부를 때마다 실제로 확인해야 로테이션을 감지할 수 있다.
 */

export const TIMEOUT_MS = 5000;

/** 앞에서부터 시도하고, 먼저 성공하는 쪽을 쓴다 */
export const PROVIDERS = [
  {
    name: 'ipify',
    url: 'https://api.ipify.org?format=json',
    async read(res) { return (await res.json())?.ip; },
  },
  {
    name: 'ifconfig.me',
    url: 'https://ifconfig.me/ip',
    async read(res) { return await res.text(); },
  },
];

/** IPv4/IPv6 형태인지 — 에코 서비스가 에러 페이지(HTML)를 주는 경우를 걸러낸다 */
export function isIp(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 45) return false;
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v)) {
    return v.split('.').every((o) => o.length <= 3 && Number(o) <= 255);
  }
  return /^[0-9a-fA-F:]+$/.test(v) && v.includes(':') && v.length >= 3;
}

/**
 * 지금 이 서버의 공인 IP.
 * @returns {Promise<{ok:true, ip:string, source:string, checkedAt:string}
 *                  | {ok:false, tried:string[]}>}
 */
export async function lookupEgressIp({ timeoutMs = TIMEOUT_MS } = {}) {
  const tried = [];

  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: '*/*' },
      });
      if (!res.ok) { tried.push(`${provider.name}: HTTP ${res.status}`); continue; }

      const ip = String((await provider.read(res)) ?? '').trim();
      if (!isIp(ip)) { tried.push(`${provider.name}: IP 형식이 아닌 응답`); continue; }

      return { ok: true, ip, source: provider.name, checkedAt: new Date().toISOString() };
    } catch (e) {
      const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? `timeout(${timeoutMs}ms)` : e.message;
      tried.push(`${provider.name}: ${why}`);
    }
  }

  return { ok: false, tried };
}
