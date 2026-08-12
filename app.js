/* 가운데 — 프런트엔드
 *
 * 화면은 목업 그대로 3단계.
 *   ?m=<토큰> 이 있으면 STEP 2 로 바로 들어간다.
 *   내 이름은 localStorage 에 두어 같은 기기에서 다시 들어오면 이어서 쓴다.
 */
(function () {
  'use strict';

  var API = window.GAUNDE_API || '';
  var $ = function (id) { return document.getElementById(id); };

  var screens = [$('s0'), $('s1'), $('s2')];
  var dots = [].slice.call(document.querySelectorAll('.dot'));
  var labels = ['STEP 1 · 링크 만들기', 'STEP 2 · 출발역 등록', 'STEP 3 · 결과'];

  var state = {
    token: null,
    meeting: null,
    stations: [],
    lines: {},
    picked: null,      // 선택한 역 {id,name,lines}
    myName: localStorage.getItem('gaunde.name') || '',
    myId: null,
    poll: null,
  };

  /* ------------------------------------------------------------ 유틸 */
  function api(path, opts) {
    return fetch(API + path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts))
      .then(function (r) {
        if (r.status === 204) return null;
        return r.json().then(function (body) {
          if (!r.ok) throw Object.assign(new Error(body.error || '요청에 실패했습니다.'), { body: body, status: r.status });
          return body;
        });
      });
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function normalize(s) {
    return String(s || '').trim().replace(/\(.*?\)/g, '').replace(/[\s·.\-–]/g, '').replace(/역$/, '');
  }
  function showErr(el, msg) { $(el).textContent = msg || ''; }

  function go(i) {
    screens.forEach(function (s, n) { s.classList.toggle('on', n === i); });
    dots.forEach(function (d, n) { d.classList.toggle('on', n <= i); });
    $('eyebrow').textContent = labels[i];
    if (i !== 1) stopPolling();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ------------------------------------------------------------ 역 목록 */
  var stationsReady = api('/api/stations').then(function (d) {
    state.stations = d.stations.map(function (s) { return { id: s.id, name: s.name, lines: s.lines, key: normalize(s.name) }; });
    state.lines = d.lines;
    renderQuick();
  }).catch(function () { showErr('err1', '역 목록을 불러오지 못했습니다. 새로고침해 주세요.'); });

  api('/api/meta').then(function (m) {
    $('cov').textContent = '역 ' + m.counts.stations + '개 · 구간 ' + m.counts.edges +
      '개 중 실측 ' + Math.round(m.counts.measuredRatio * 100) + '%. ';
  }).catch(function () {});

  var QUICK = ['홍대입구', '잠실', '노원', '사당', '강남', '서울역'];
  function renderQuick() {
    $('quick').innerHTML = QUICK.map(function (n) {
      return '<button class="chip" type="button" data-s="' + esc(n) + '">' + esc(n) + '</button>';
    }).join('');
  }
  $('quick').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    var hit = state.stations.filter(function (s) { return s.key === normalize(b.dataset.s); })[0];
    if (hit) pick(hit);
  });

  /* ------------------------------------------------------------ 자동완성 */
  var acIndex = -1;
  function searchStations(q) {
    var k = normalize(q);
    if (!k) return [];
    var starts = [], contains = [];
    for (var i = 0; i < state.stations.length; i++) {
      var s = state.stations[i];
      if (s.key === k) starts.unshift(s);
      else if (s.key.indexOf(k) === 0) starts.push(s);
      else if (s.key.indexOf(k) >= 0) contains.push(s);
    }
    return starts.concat(contains).slice(0, 8);
  }
  function lineDots(lines) {
    return '<span class="lns">' + lines.map(function (l) {
      var c = (state.lines[l] || {}).color || '#ccc';
      return '<i class="ln" style="background:' + c + '"></i>';
    }).join('') + '</span>';
  }
  function renderAC(list) {
    var ac = $('ac');
    if (!list.length) { ac.classList.remove('on'); $('dep').setAttribute('aria-expanded', 'false'); return; }
    ac.innerHTML = list.map(function (s, i) {
      return '<b role="option" data-i="' + i + '"' + (i === acIndex ? ' class="sel"' : '') + '>' +
        esc(s.name) + lineDots(s.lines) + '</b>';
    }).join('');
    ac.classList.add('on');
    $('dep').setAttribute('aria-expanded', 'true');
    ac._list = list;
  }
  function closeAC() { $('ac').classList.remove('on'); acIndex = -1; $('dep').setAttribute('aria-expanded', 'false'); }

  function pick(s) {
    state.picked = s;
    $('dep').value = s.name;
    closeAC();
    checkSubmit();
  }

  $('dep').addEventListener('input', function () {
    state.picked = null;
    acIndex = -1;
    renderAC(searchStations(this.value));
    checkSubmit();
  });
  $('dep').addEventListener('keydown', function (e) {
    var list = $('ac')._list || [];
    if (!$('ac').classList.contains('on') || !list.length) return;
    if (e.key === 'ArrowDown') { acIndex = (acIndex + 1) % list.length; renderAC(list); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { acIndex = (acIndex - 1 + list.length) % list.length; renderAC(list); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(list[acIndex >= 0 ? acIndex : 0]); e.preventDefault(); }
    else if (e.key === 'Escape') closeAC();
  });
  $('ac').addEventListener('mousedown', function (e) {
    var b = e.target.closest('b[data-i]');
    if (b) { e.preventDefault(); pick(($('ac')._list || [])[+b.dataset.i]); }
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.ac-wrap')) closeAC();
  });

  $('pname').addEventListener('input', checkSubmit);
  function checkSubmit() {
    $('submit').disabled = !($('pname').value.trim() && state.picked);
  }

  /* ------------------------------------------------------------ STEP 1 만들기 */
  $('make').addEventListener('click', function () {
    var btn = this;
    showErr('err0', '');
    btn.disabled = true; btn.textContent = '만드는 중…';
    api('/api/meetings', { method: 'POST', body: JSON.stringify({ name: $('mname').value.trim() }) })
      .then(function (m) {
        state.token = m.token; state.meeting = m;
        var url = location.origin + location.pathname + '?m=' + m.token;
        $('linktext').textContent = url;
        $('made').hidden = false;
        $('goto1').hidden = false;
        btn.textContent = '링크 다시 만들기';
        history.replaceState(null, '', '?m=' + m.token);
      })
      .catch(function (e) { showErr('err0', e.message); btn.textContent = '링크 만들기'; })
      .finally(function () { btn.disabled = false; });
  });

  $('copy').addEventListener('click', function () {
    var btn = this, text = $('linktext').textContent;
    var done = function () { btn.textContent = '복사됨'; setTimeout(function () { btn.textContent = '복사'; }, 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else {
      var t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(t); done();
    }
  });

  $('mine').addEventListener('click', function () { enterMeeting(state.token); });

  /* ------------------------------------------------------------ STEP 2 참여 */
  function enterMeeting(token) {
    state.token = token;
    go(1);
    if (state.myName) $('pname').value = state.myName;
    stationsReady.then(function () { checkSubmit(); });
    refreshRoster();
    startPolling();
  }

  function refreshRoster() {
    return api('/api/meetings/' + encodeURIComponent(state.token))
      .then(function (m) {
        state.meeting = m;
        $('mtitle').textContent = m.name;
        document.title = m.name + ' — 가운데';
        renderRoster(m.participants);
        $('toresult').disabled = m.participants.length < 2;
        $('toresult').textContent = m.participants.length < 2
          ? '결과 보기 (2명 이상 필요)' : '결과 보기 (' + m.participants.length + '명)';
        showErr('err1', '');
      })
      .catch(function (e) {
        showErr('err1', e.status === 404 ? '없는 모임입니다. 링크를 다시 확인해 주세요.' : e.message);
        stopPolling();
      });
  }

  function renderRoster(list) {
    $('cnt').textContent = list.length + '명 등록';
    if (!list.length) {
      $('rows').innerHTML = '<div class="empty">아직 아무도 출발역을 고르지 않았습니다.</div>';
      return;
    }
    $('rows').innerHTML = list.map(function (p) {
      var me = state.myName && p.name === state.myName;
      return '<div class="row' + (me ? ' me' : '') + '">' +
        '<span class="avatar">' + esc(p.name.slice(0, 1)) + '</span>' +
        '<b>' + esc(p.name) + '</b>' +
        '<span class="st">' + esc(p.station) + (me ? ' · 나' : '') + '</span></div>';
    }).join('');
  }

  function startPolling() {
    stopPolling();
    state.poll = setInterval(function () {
      if (document.hidden) return;
      refreshRoster();
    }, 4000);
  }
  function stopPolling() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

  $('submit').addEventListener('click', function () {
    var btn = this;
    showErr('err1', '');
    btn.disabled = true; btn.textContent = '등록 중…';
    var name = $('pname').value.trim();
    api('/api/meetings/' + encodeURIComponent(state.token) + '/participants', {
      method: 'POST',
      body: JSON.stringify({ name: name, stationId: state.picked.id }),
    })
      .then(function (r) {
        state.myName = name; state.myId = r.participant.id;
        localStorage.setItem('gaunde.name', name);
        btn.textContent = '출발역 바꾸기';
        return refreshRoster();
      })
      .catch(function (e) { showErr('err1', e.message); btn.textContent = '출발역 등록하기'; })
      .finally(function () { btn.disabled = false; checkSubmit(); });
  });

  $('toresult').addEventListener('click', function () { showResult(); });

  /* ------------------------------------------------------------ STEP 3 결과 */
  function showResult() {
    go(2);
    $('rtitle').textContent = '계산하는 중';
    $('rlede').textContent = '…';
    $('alts').hidden = true;
    showErr('err2', '');

    api('/api/meetings/' + encodeURIComponent(state.token) + '/result')
      .then(function (d) {
        var b = d.best;
        $('rtitle').innerHTML = '다 같이 <em>' + b.maxMin + '분</em>';
        $('rlede').textContent = d.meeting.participants.length + '명 중 가장 오래 걸리는 사람이 제일 적게 걸리는 지점입니다.';

        /* 목업의 수렴선: 참여자들을 위/아래로 나누고 가운데에 만날 역을 놓는다 */
        var routes = b.routes.slice();
        var half = Math.ceil(routes.length / 2);
        var top = routes.slice(0, half), bottom = routes.slice(half).reverse();
        var html = '<div class="rail"></div><div class="railfill"></div>';
        html += top.map(stopRow).join('');
        html += '<div class="stop hit"><div class="who">' + esc(b.station.name) + '</div>' +
          '<div class="node"></div><div class="mins">여기서 만나기</div></div>';
        html += bottom.map(stopRow).join('');
        $('rmap').innerHTML = html;
        $('rmap').classList.add('on');

        var far = b.routes[0];
        var saved = d.worstIfSomeonesHomeMin - b.maxMin;
        $('verdict').innerHTML =
          '가장 멀리서 오는 <b>' + esc(far.name) + '</b> 기준으로 <b>' + far.min + '분</b>.<br>' +
          (saved > 0
            ? '각자 집 앞에서 만나자고 할 때보다 <b>' + saved + '분</b> 덜 억울합니다.'
            : '누구 집 앞에서 보든 비슷한 거리입니다.') +
          '<br><span style="color:#7C857A">' + esc(b.station.name) + ' · ' +
          b.station.lines.map(function (l) { return (state.lines[l] || {}).name || l; }).join(', ') + '</span>';

        if (d.alternatives.length) {
          $('altrows').innerHTML = d.alternatives.map(function (a) {
            return '<div class="altrow"><b>' + esc(a.station.name) + '</b>' +
              '<span>최대 ' + a.maxMin + '분 · 평균 ' + a.avgMin + '분</span></div>';
          }).join('');
          $('alts').hidden = false;
        }
      })
      .catch(function (e) {
        $('rtitle').textContent = '아직 계산할 수 없습니다';
        $('rlede').textContent = '';
        $('rmap').innerHTML = '<div class="rail"></div><div class="railfill"></div>';
        $('verdict').textContent = e.message;
      });
  }

  function stopRow(r) {
    var legs = r.legs.map(function (l) { return l.lineName; });
    var uniq = legs.filter(function (v, i) { return legs.indexOf(v) === i; }).join(' → ');
    return '<div class="stop"><div class="who">' + esc(r.name) +
      '<small>' + esc(r.origin) + '</small></div><div class="node"></div>' +
      '<div class="mins">' + r.min + '분' + (uniq ? ' · ' + esc(uniq) : '') +
      (r.transfers ? ' · 환승' + r.transfers : '') + '</div></div>';
  }

  $('share').addEventListener('click', function () {
    var btn = this;
    var url = location.origin + location.pathname + '?m=' + state.token;
    var text = (state.meeting ? state.meeting.name : '모임') + ' 중간지점 결과';
    if (navigator.share) {
      navigator.share({ title: '가운데', text: text, url: url }).catch(function () {});
      return;
    }
    var done = function () { btn.textContent = '링크 복사됨'; setTimeout(function () { btn.textContent = '결과 링크 공유하기'; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, done); else done();
  });

  $('again').addEventListener('click', function () { enterMeeting(state.token); });
  $('reset2').addEventListener('click', function () {
    stopPolling();
    history.replaceState(null, '', location.pathname);
    state.token = null; state.meeting = null; state.picked = null;
    $('made').hidden = true; $('goto1').hidden = true;
    $('make').textContent = '링크 만들기';
    $('dep').value = ''; checkSubmit();
    go(0);
  });

  /* ------------------------------------------------------------ 진입 */
  var token = new URLSearchParams(location.search).get('m');
  if (token) enterMeeting(token); else go(0);
})();
