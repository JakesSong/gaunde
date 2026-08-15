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

  /** 이 기기의 참여자 식별자.
   *  예전에는 이름으로 사람을 구분해서, 이름이 겹치면 뒤에 온 사람이 앞사람을 덮어썼다.
   *  이름은 표시용이고 신원은 이걸로 가린다. */
  var clientId = localStorage.getItem('gaunde.cid');
  if (!clientId) {
    clientId = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('gaunde.cid', clientId);
  }

  var state = {
    token: null,
    meeting: null,
    stations: [],
    lines: {},
    picked: null,      // 선택한 역 {id,name,lines}
    myName: localStorage.getItem('gaunde.name') || '',
    myId: null,        // 내 참여자 row id
    editingId: null,   // 수정 중인 참여자 row id
    poll: null,
    result: null,      // 마지막 결과 응답
    shownSpot: null,   // 지금 보고 있는 후보 (best 또는 alternatives[i])
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
  /** 측정 이벤트. 실패해도 UX 를 막지 않는다 — 보내고 잊는다. */
  function track(event) {
    try {
      var body = JSON.stringify({ event: event, token: state.token });
      // 공유 직후 페이지를 떠나도 전송되도록 sendBeacon 을 먼저 시도한다.
      if (navigator.sendBeacon && navigator.sendBeacon(API + '/api/track', new Blob([body], { type: 'application/json' }))) return;
      fetch(API + '/api/track', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: body, keepalive: true,
      }).catch(function () {});
    } catch (e) { /* 측정은 기능보다 뒤다 */ }
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
    state.myId = state.myId || localStorage.getItem('gaunde.pid.' + token);
    go(1);
    if (state.myName) $('pname').value = state.myName;
    $('submit').textContent = state.myId ? '출발역 바꾸기' : '출발역 등록하기';
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
      var me = p.id === state.myId;
      return '<div class="row' + (me ? ' me' : '') + '" data-id="' + esc(p.id) + '">' +
        '<span class="avatar">' + esc(p.name.slice(0, 1)) + '</span>' +
        '<b>' + esc(p.name) + '</b>' +
        '<span class="st">' + esc(p.station) + (me ? ' · 나' : '') + '</span>' +
        '<span class="tools">' +
          '<button class="tool" data-act="edit" type="button">수정</button>' +
          '<button class="tool" data-act="del" type="button">삭제</button>' +
        '</span></div>';
    }).join('');
  }

  /* 참여자 수정·삭제 — 링크를 아는 사람이면 누구나 할 수 있다(단톡방 도구라 그게 맞다) */
  $('rows').addEventListener('click', function (e) {
    var btn = e.target.closest('.tool');
    if (!btn) return;
    var row = btn.closest('.row');
    var id = row.dataset.id;
    var p = (state.meeting.participants || []).filter(function (x) { return x.id === id; })[0];
    if (!p) return;

    if (btn.dataset.act === 'edit') {
      state.editingId = id;
      $('pname').value = p.name;
      $('dep').value = p.station;
      state.picked = state.stations.filter(function (s) { return s.id === p.stationId; })[0]
        || state.stations.filter(function (s) { return s.key === normalize(p.station); })[0] || null;
      $('submit').textContent = esc(p.name) + ' 수정하기';
      checkSubmit();
      $('dep').focus();
      return;
    }

    if (!window.confirm(p.name + '님을 목록에서 지울까요?')) return;
    api('/api/meetings/' + encodeURIComponent(state.token) + '/participants/' + encodeURIComponent(id),
      { method: 'DELETE' })
      .then(function () {
        if (state.myId === id) { state.myId = null; localStorage.removeItem('gaunde.pid.' + state.token); }
        if (state.editingId === id) resetForm();
        return refreshRoster();
      })
      .catch(function (err) { showErr('err1', err.message); });
  });

  function resetForm() {
    state.editingId = null;
    state.picked = null;
    $('dep').value = '';
    $('submit').textContent = state.myId ? '출발역 바꾸기' : '출발역 등록하기';
    checkSubmit();
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
    var prev = btn.textContent;
    showErr('err1', '');
    btn.disabled = true; btn.textContent = '등록 중…';
    var name = $('pname').value.trim();
    var editing = state.editingId;

    var req = editing
      ? api('/api/meetings/' + encodeURIComponent(state.token) + '/participants/' + encodeURIComponent(editing),
          { method: 'PATCH', body: JSON.stringify({ name: name, stationId: state.picked.id }) })
      : api('/api/meetings/' + encodeURIComponent(state.token) + '/participants',
          { method: 'POST', body: JSON.stringify({ name: name, stationId: state.picked.id, clientId: clientId }) });

    req.then(function (r) {
      if (!editing) {
        state.myName = name;
        state.myId = r.participant.id;
        localStorage.setItem('gaunde.name', name);
        localStorage.setItem('gaunde.pid.' + state.token, r.participant.id);
      }
      state.editingId = null;
      btn.textContent = '출발역 바꾸기';
      return refreshRoster();
    })
      .catch(function (e) { showErr('err1', e.message); btn.textContent = prev; })
      .finally(function () { btn.disabled = false; checkSubmit(); });
  });

  $('toresult').addEventListener('click', function () { showResult(); });

  /* ------------------------------------------------------------ STEP 3 결과 */
  /** 이 브라우저에서 이 모임의 결과를 이미 본 적 있는가.
   *  있으면 서버에도 스냅샷이 남아 있어 다시 계산하지 않는다. */
  function seenKey() { return 'gaunde.seen.' + state.token; }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.expectCached] 계산이 이미 끝나 있는 게 확실한 진입인지.
   *   결과 링크로 다시 들어온 경우(?r=1)나 이 기기에서 한 번 본 모임이면 참.
   *   "계산하는 중" 이라고 띄워놓고 곧바로 결과가 뜨면 사람을 헷갈리게 한다.
   */
  function showResult(opts) {
    var expectCached = (opts && opts.expectCached) || !!localStorage.getItem(seenKey());
    go(2);
    if (expectCached) {
      $('rtitle').textContent = '결과 불러오는 중…';
      $('rlede').textContent = '';
    } else {
      $('rtitle').textContent = '계산하는 중…';
      $('rlede').textContent = '잠시만요, 후보 역을 하나씩 비교하고 있어요';
    }
    $('alts').hidden = true;
    $('acts').hidden = true;
    $('fb').hidden = true;
    $('raxis').hidden = true;
    $('rlegend').hidden = true;
    $('rwhy').hidden = true;
    showErr('err2', '');

    api('/api/meetings/' + encodeURIComponent(state.token) + '/result')
      .then(function (d) {
        state.result = d;
        try { localStorage.setItem(seenKey(), '1'); } catch (e) { /* 사파리 프라이빗 등 */ }
        renderSpot(d.best);

        var spots = [d.best].concat(d.alternatives);
        $('altrows').innerHTML = spots.map(function (a, i) {
          return '<button class="altrow' + (i === 0 ? ' on' : '') + '" type="button" data-i="' + i + '">' +
            '<b>' + esc(a.station.name) + '</b>' +
            '<span>가장 먼 사람 ' + a.maxMin + '분 · 평균 ' + a.avgMin + '분 · ' + won(a.fareAvg) + '</span>' +
            '</button>';
        }).join('');
        $('alts').hidden = spots.length < 2;
      })
      .catch(function (e) {
        $('rtitle').textContent = '아직 계산할 수 없습니다';
        $('rlede').textContent = '';
        $('rmap').innerHTML = '<div class="rail"></div><div class="railfill"></div>';
        $('raxis').hidden = true; $('rlegend').hidden = true; $('rwhy').hidden = true;
        $('verdict').textContent = e.message;
      });
  }

  /** 후보를 눌러 그 역 기준 결과로 갈아끼운다 (서버가 이미 경로까지 다 내려줬다) */
  $('altrows').addEventListener('click', function (e) {
    var btn = e.target.closest('.altrow');
    if (!btn || !state.result) return;
    var spots = [state.result.best].concat(state.result.alternatives);
    var spot = spots[+btn.dataset.i];
    if (!spot) return;
    [].slice.call($('altrows').children).forEach(function (el) { el.classList.toggle('on', el === btn); });
    renderSpot(spot);
  });

  function won(v) { return v ? v.toLocaleString('ko-KR') + '원' : '0원'; }

  /* ---------------------------------------------------------- 호선 색
   * graph.json 이 노선별 실제 색(#RRGGBB)을 들고 있다. 그대로 쓰되,
   * style 속성에 넣기 전에 모양을 확인한다 — 데이터가 곧 스타일이 되는 자리다. */
  var HEX = /^#[0-9a-fA-F]{3,8}$/;
  function safeColor(c) { return c && HEX.test(c) ? c : null; }
  function lineColor(id) { return safeColor((state.lines[id] || {}).color); }
  function lineName(id) { return (state.lines[id] || {}).name || id; }

  /** 노드 링 색. 환승역처럼 호선이 여럿이면 원을 n등분해 다 보여준다. */
  function ringStyle(colors) {
    var cs = colors.filter(Boolean);
    if (!cs.length) return '';
    if (cs.length === 1) return 'background:' + cs[0];
    var step = 100 / cs.length, parts = [];
    cs.forEach(function (c, i) {
      parts.push(c + ' ' + (step * i).toFixed(2) + '% ' + (step * (i + 1)).toFixed(2) + '%');
    });
    return 'background:conic-gradient(' + parts.join(',') + ')';
  }

  /**
   * 레일을 실제 호선 색으로 칠한다.
   *
   * 각 사람의 구간을 그 사람이 갈아탄 호선들로 다시 나눈다 —
   * 색이 바뀌는 지점이 곧 환승 지점이라, 환승이 그림에서 바로 보인다.
   * 경계는 렌더 뒤 실제 노드 위치를 재서 잡는다. 여백이 소요시간에 따라
   * 매번 달라지므로 미리 계산할 수 없다.
   *
   * plan[i] 는 i 번째 .stop 에 대응한다. 만날 역은 null (폭 0).
   */
  function paintRail(mapEl, plan) {
    var fill = mapEl.querySelector('.railfill');
    if (!fill) return false;
    var rows = [].slice.call(mapEl.querySelectorAll('.stop'));
    var h = mapEl.offsetHeight;
    if (!h || rows.length !== plan.length) return false;

    var centers = rows.map(function (row) {
      var n = row.querySelector('.node');
      return row.offsetTop + n.offsetTop + n.offsetHeight / 2;
    });
    if (centers[centers.length - 1] <= 0) return false;   // 화면에 안 붙어 있으면 잴 수 없다

    var hub = -1;
    plan.forEach(function (p, i) { if (!p) hub = i; });
    function edge(i) {                                    // i 와 i+1 사이 경계
      if (i === hub || i + 1 === hub) return centers[hub];
      return (centers[i] + centers[i + 1]) / 2;
    }

    var segs = [];                                        // [{from,to,color}] px 기준
    plan.forEach(function (p, i) {
      if (!p) return;
      var a = i === 0 ? 0 : edge(i - 1);
      var b = i === plan.length - 1 ? h : edge(i);
      if (b <= a) return;
      /* 다리(leg)를 정차역 수에 비례해 나눈다. 위쪽 사람은 아래로 내려오고
         아래쪽 사람은 위로 올라오므로, 아래쪽은 순서를 뒤집어 깔아야
         "출발지 쪽이 첫 호선" 이 된다. */
      var legs = p.legs.length ? p.legs : [{ color: null, stops: 1 }];
      if (p.toward === 'up') legs = legs.slice().reverse();
      var total = legs.reduce(function (n, l) { return n + Math.max(1, l.stops || 1); }, 0);
      var at = a;
      legs.forEach(function (l, k) {
        var w = (b - a) * (Math.max(1, l.stops || 1) / total);
        var end = k === legs.length - 1 ? b : at + w;
        segs.push({ from: at, to: end, color: safeColor(l.color) || '#00A84D' });
        at = end;
      });
    });
    if (!segs.length) return false;

    var parts = segs.map(function (g) {
      return g.color + ' ' + (g.from / h * 100).toFixed(2) + '% ' + (g.to / h * 100).toFixed(2) + '%';
    });
    fill.style.background = 'linear-gradient(' + parts.join(',') + ')';
    return true;
  }

  function renderSpot(spot) {
    var d = state.result;
    state.shownSpot = spot;
    var n = d.meeting.participants.length;

    $('rtitle').innerHTML = '가장 먼 사람도 <em>' + spot.maxMin + '분</em>';
    var sel = d.selection || {};
    var basis = sel.fareSource === 'odsay' ? ' (실시간 대중교통 기준)'
      : sel.fareSource === 'mixed' ? ' (일부 실시간 기준)'
      : (sel.fareApprox ? ' (지하철 기준, 요금은 근사치)' : '');
    $('rlede').textContent = n + '명 평균 ' + spot.avgMin + '분 · 1인 ' + won(spot.fareAvg) + basis;

    /* 같은 역에서 출발하는 사람은 한 줄로 묶는다 — 위아래로 갈리면 같은 역이 두 번 나온다 */
    var groups = [];
    var byStation = {};
    spot.routes.forEach(function (r) {
      var k = r.originId;
      if (byStation[k] === undefined) {
        byStation[k] = groups.length;
        groups.push({ names: [r.name], origin: r.origin, min: r.min, fare: r.fare,
        legs: r.legs, transfers: r.transfers, timeSource: r.timeSource });
      } else {
        groups[byStation[k]].names.push(r.name);
      }
    });
    groups.sort(function (a, b) { return b.min - a.min; });

    /* 먼 사람이 바깥, 가까운 사람이 만날 역 쪽. 위아래로 번갈아 배치한다.
       groups 는 소요시간 내림차순이므로
         위쪽(위 → 아래로 그림)  : 그대로. 먼 사람이 맨 위, 가까운 사람이 만날 역 바로 위.
         아래쪽(만날 역 → 아래로): 뒤집어야 가까운 사람이 만날 역 바로 아래로 온다.
       예전에는 반대로 위쪽만 뒤집어서, 양쪽 다 가까운 사람이 제일 멀리 그려졌다. */
    var top = [], bottom = [];
    groups.forEach(function (g, i) { (i % 2 === 0 ? top : bottom).push(g); });
    bottom.reverse();

    /* 세로 간격을 소요시간에 비례시키되 전체 높이를 눌러 담는다.
       순수 비례로 두면 시간차가 큰 모임에서 레일이 화면 몇 개 분량으로 늘어났다.
       - 허브에서의 거리 = MAX_ARM * (t/tmax)^CURVE 로 완만하게 눌러
         순서와 상대 비례는 유지하되 극단값이 전체를 늘리지 못하게 한다.
       - 인접 노드는 최소 MIN_GAP 만 벌려 붙어 보이지 않게 한다.
       결과적으로 다이어그램 높이가 참여자 수와 무관하게 한 화면에 들어온다. */
    var MAX_ARM = 84;    // 허브에서 가장 먼 노드까지의 최대 여백(px)
    var MIN_GAP = 6;     // 인접 노드 사이 최소 여백(px)
    var CURVE = 0.62;    // 1 이면 순수 비례, 낮을수록 큰 값이 더 눌린다
    var mins = groups.map(function (g) { return g.min; });
    var maxMin = Math.max.apply(null, mins) || 1;
    var minMin = Math.min.apply(null, mins);
    var spread = maxMin - minMin;

    /* 눈금은 "0분부터" 가 아니라 "가장 가까운 사람부터" 잡는다.
       18~26분처럼 다들 비슷하게 먼 모임에서 0분 기준으로 그리면
       허브 둘레가 통째로 빈 공간이 된다.
       대신 차이가 작을수록 눈금도 좁혀서, 1~2분 차이가 화면에서
       큰 차이처럼 과장되지 않게 한다. */
    var spanFactor = maxMin > 0 ? Math.min(1, spread / maxMin) : 0;
    var span = (MAX_ARM - MIN_GAP) * spanFactor;

    function arm(t) {                     // 허브에서 t분 떨어진 사람의 거리(px)
      if (t <= 0) return 0;
      if (spread <= 0) return MIN_GAP;    // 다 같은 시간이면 나란히
      return MIN_GAP + span * Math.pow((t - minMin) / spread, CURVE);
    }
    function gapFor(cur, next) {          // next 가 undefined 면 바로 안쪽이 만날 역
      var d = arm(cur) - (next === undefined ? 0 : arm(next));
      return Math.round(Math.max(MIN_GAP, d));
    }

    /* 만날 역 노드는 그 역이 지나는 호선 색을 다 두른다 */
    var hubColors = spot.station.lines.map(lineColor);
    var hubRing = ringStyle(hubColors);

    /* 사람 노드는 그가 처음 타는 호선 색. 바로 옆 레일 구간과 같은 색이 된다. */
    function boardColor(g) {
      return (g.legs.length ? safeColor(g.legs[0].color) : null) || hubColors.filter(Boolean)[0] || null;
    }

    var html = '<div class="rail"></div><div class="railfill"></div>';
    var plan = [];
    top.forEach(function (g, i) {
      var inner = top[i + 1] ? top[i + 1].min : 0;
      html += stopRow(g, { marginBottom: gapFor(g.min, inner) }, ringStyle([boardColor(g)]));
      plan.push({ legs: g.legs, toward: 'down' });
    });
    html += '<div class="stop hit"><div class="who">' + esc(spot.station.name) + '</div>' +
      '<div class="node"' + (hubRing ? ' style="' + hubRing + '"' : '') + '></div>' +
      '<div class="mins">여기서 만나기</div></div>';
    plan.push(null);
    bottom.forEach(function (g, i) {
      var inner = i === 0 ? 0 : bottom[i - 1].min;
      html += stopRow(g, { marginTop: gapFor(g.min, inner) }, ringStyle([boardColor(g)]));
      plan.push({ legs: g.legs, toward: 'up' });
    });
    $('rmap').innerHTML = html;
    $('rmap').classList.add('on');

    /* 레일 색칠은 실제 노드 위치를 재야 해서 렌더 뒤에 한다.
       결과 화면이 막 켜진 직후엔 아직 레이아웃 전일 수 있어 한 프레임 뒤 한 번 더 본다. */
    if (!paintRail($('rmap'), plan)) {
      requestAnimationFrame(function () { paintRail($('rmap'), plan); });
    }

    /* 세로축이 소요시간이라는 것과, 어떤 색이 무슨 호선인지 밝힌다 */
    $('raxis').innerHTML = '세로 간격은 <b>소요시간</b>이에요 · 지도 위 거리·방향과는 무관합니다';
    $('raxis').hidden = false;

    var seenLines = [];
    groups.forEach(function (g) {
      g.legs.forEach(function (l) { if (seenLines.indexOf(l.line) < 0) seenLines.push(l.line); });
    });
    spot.station.lines.forEach(function (l) { if (seenLines.indexOf(l) < 0) seenLines.push(l); });
    var chips = seenLines.map(function (l) {
      var c = lineColor(l);
      return c ? '<i style="--c:' + c + '">' + esc(lineName(l)) + '</i>' : '';
    }).filter(Boolean);
    $('rlegend').innerHTML = chips.join('');
    $('rlegend').hidden = !chips.length;

    var far = groups[0];
    var saved = d.worstIfSomeonesHomeMin - spot.maxMin;
    var surcharge = [];
    spot.routes.forEach(function (r) {
      (r.surcharges || []).forEach(function (s) {
        if (surcharge.indexOf(s.name) < 0) surcharge.push(s.name);
      });
    });
    $('verdict').innerHTML =
      '가장 멀리서 오는 <b>' + esc(far.names.join('·')) + '</b> 기준으로 <b>' + far.min + '분</b>.<br>' +
      (saved > 0
        ? '각자 집 앞에서 만나자고 할 때보다 <b>' + saved + '분</b> 덜 억울합니다.'
        : '누구 집 앞에서 보든 비슷한 거리입니다.') +
      '<br><span style="color:#7C857A">' + esc(spot.station.name) + ' · ' +
      spot.station.lines.map(function (l) { return (state.lines[l] || {}).name || l; }).join(', ') +
      (surcharge.length ? ' · ' + esc(surcharge.join('/')) + ' 별도운임 포함' : '') + '</span>';

    /* 왜 하필 이 역인지 — 규칙을 그대로 문장으로 옮긴다 (항목 3).
       두 단계다: ① 후보 전체에서 "가장 먼 사람의 시간" 의 최솟값을 기준선으로 잡고,
       ② 그 기준선 ±톨러런스 안에 든 후보 중 모두의 시간 합이 가장 짧은 곳을 고른다.
       (graph.mjs: band 를 sumSec 으로 정렬한다)

       ①의 기준선을 낸 역과 최종 선택이 다를 수 있다는 걸 숨기면 안 된다 —
       후보 목록에 "가장 먼 사람" 이 더 짧은 역이 버젓이 보이는데 여기서
       "가장 짧은 곳을 골랐다" 고 하면 그 자리에서 들통나고, 납득은 더 떨어진다. */
    var pool = sel.candidateCount || sel.shortlist || 0;
    var tol = sel.toleranceMin || 4;
    var band = sel.bandSize || 1;
    var floor = Number.isFinite(sel.minMaxSec) ? Math.round(sel.minMaxSec / 60) : null;
    var why = [];
    if (spot === d.best) {
      why.push('환승 되는 역 <b>' + pool + '곳</b>을 다 따져보니, ' +
        '<b>가장 먼 사람</b>의 시간은 아무리 줄여도 ' +
        (floor === null ? '이 정도' : '<b>' + floor + '분</b>') + '이 최선이었어요.');
      why.push(band > 1
        ? '거기서 <b>±' + tol + '분</b> 안에 든 후보 <b>' + band + '곳</b> 중, ' +
          '<b>모두의 시간을 합쳐 가장 짧은</b> 곳이 여기예요 ' +
          '(가장 먼 사람 <b>' + spot.maxMin + '분</b> · 평균 <b>' + spot.avgMin + '분</b>).'
        : '±' + tol + '분 안에 견줄 만한 다른 후보는 없어서 여기로 정했어요.');
    } else {
      why.push('추천은 <b>' + esc(d.best.station.name) + '</b>이고, 지금은 직접 고른 후보를 보고 있어요.');
      why.push('가장 먼 사람 기준으로 ' +
        '<b>' + (spot.maxMin - d.best.maxMin > 0 ? '+' : '') + (spot.maxMin - d.best.maxMin) + '분</b> 차이예요.');
    }
    why.push('<span style="color:#7C857A">소요시간에는 <b>환승 대기·환승 도보 시간</b>이 모두 들어 있어요.</span>');
    $('rwhy').innerHTML = '<h4>왜 이 역인가요?</h4>' + why.join(' ');
    $('rwhy').hidden = false;

    var q = encodeURIComponent(spot.station.name);
    $('food').href = 'https://map.kakao.com/?q=' + q + '+맛집';
    $('cafe').href = 'https://map.kakao.com/?q=' + q + '+카페';
    $('acts').hidden = false;
    renderFeedback();
  }

  /* ------------------------------------------------------------ 결과 피드백 */
  function fbKey() { return 'gaunde.fb.' + state.token; }

  function renderFeedback() {
    var saved = localStorage.getItem(fbKey());
    $('fb').hidden = false;
    if (saved) return fbThanks();
    $('fbq').textContent = '이 추천, 도움이 됐어요?';
    $('fbvote').hidden = false;
    $('fbwhy').hidden = true;
  }

  function fbThanks(msg) {
    $('fbvote').hidden = true;
    $('fbwhy').hidden = true;
    $('fbq').innerHTML = '<span class="fbthanks">' + (msg || '고마워요! 의견이 반영돼요') + '</span>';
  }

  /** 서버로 보낸다. 실패해도 UX 를 막지 않는다 (기존 track 과 같은 방식). */
  function sendFeedback(value, reason) {
    var station = state.shownSpot ? state.shownSpot.station.name : null;
    localStorage.setItem(fbKey(), value + (reason ? ':' + reason : ''));
    try {
      var body = JSON.stringify({
        event: 'result_feedback', token: state.token,
        value: value, reason: reason || undefined, station: station, clientId: clientId,
      });
      if (navigator.sendBeacon && navigator.sendBeacon(API + '/api/track', new Blob([body], { type: 'application/json' }))) return;
      fetch(API + '/api/track', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: body, keepalive: true,
      }).catch(function () {});
    } catch (e) { /* 측정은 기능보다 뒤다 */ }
  }

  $('fbvote').addEventListener('click', function (e) {
    var b = e.target.closest('.fbbtn');
    if (!b) return;
    if (b.dataset.v === 'good') {
      sendFeedback('good');
      fbThanks();
      return;
    }
    /* 불만족은 이유를 한 번 더 묻는다. 이유 없이 닫아도 'bad' 는 이미 집계된다. */
    sendFeedback('bad');
    $('fbvote').hidden = true;
    $('fbq').textContent = '어떤 점이 아쉬웠나요?';
    $('fbwhy').hidden = false;
  });

  $('fbwhy').addEventListener('click', function (e) {
    var b = e.target.closest('.fbchip');
    if (!b) return;
    sendFeedback('bad', b.dataset.r);
    fbThanks('고마워요! 더 나은 추천에 쓸게요');
  });

  function stopRow(g, style, nodeStyle) {
    var names = g.legs.map(function (l) { return l.lineName; });
    var uniq = names.filter(function (v, i) { return names.indexOf(v) === i; }).join(' → ');
    var css = [];
    if (style.marginTop) css.push('margin-top:' + style.marginTop + 'px');
    if (style.marginBottom) css.push('margin-bottom:' + style.marginBottom + 'px');
    /* ODsay 시간은 버스가 섞였을 수 있어 지하철 노선명을 붙이지 않는다.
       기준은 상단 문구(실시간 대중교통 기준)가 이미 밝히고 있고,
       한 줄로 줄이면 행 높이가 줄어 다이어그램도 짧아진다. */
    var via = g.timeSource === 'odsay' ? '' : (uniq ? ' · ' + esc(uniq) : '');
    /* 환승을 0회일 때도 적는다. "환승 시간은 따진 거냐" 는 질문이 반복됐는데,
       아무 표기가 없으니 안 따진 것처럼 보인 탓이었다. */
    var hop = g.min === 0 ? '' : ' · ' + (g.transfers ? '환승 ' + g.transfers + '회' : '직통');
    var parts = [g.min + '분' + via + hop];
    if (g.fare) parts.push(won(g.fare));
    return '<div class="stop"' + (css.length ? ' style="' + css.join(';') + '"' : '') + '>' +
      '<div class="who">' + esc(g.names.join('·')) +
      '<small>' + esc(g.origin) + '</small></div>' +
      '<div class="node"' + (nodeStyle ? ' style="' + nodeStyle + '"' : '') + '></div>' +
      '<div class="mins">' + parts.join(' · ') + '</div></div>';
  }

  /* 결과 카드를 이미지로 떠서 공유한다.
   * 카카오 SDK·키는 쓰지 않는다. Web Share Level 2(files) 가 되면 공유 시트로,
   * 안 되면(대부분의 PC) 이미지를 내려받고 링크를 복사한다. */
  $('share').addEventListener('click', function () {
    var btn = this;
    track('share_clicked');
    var label = btn.textContent;
    var url = location.origin + location.pathname + '?m=' + state.token + '&r=1';
    var title = (state.meeting ? state.meeting.name : '모임') + ' — 가운데';

    var finish = function (msg) {
      btn.textContent = msg;
      setTimeout(function () { btn.textContent = label; }, 2000);
    };
    var copyLink = function () {
      if (navigator.clipboard) return navigator.clipboard.writeText(url).catch(function () {});
      return Promise.resolve();
    };

    if (typeof html2canvas !== 'function') {          // 스크립트 로드 실패 시 링크만
      copyLink().then(function () { finish('링크 복사됨'); });
      return;
    }

    btn.disabled = true; btn.textContent = '이미지 만드는 중…';
    captureShot()
      .then(function (blob) {
        if (!blob) throw new Error('capture failed');
        var file = new File([blob], '가운데-결과.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file], title: title, text: title })
            .then(function () { finish('공유했습니다'); })
            .catch(function () { finish(label); });   // 사용자가 취소한 경우
        }
        // 폴백: 이미지 다운로드 + 링크 복사
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '가운데-결과.png';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
        return copyLink().then(function () { finish('이미지 저장 · 링크 복사됨'); });
      })
      .catch(function () { copyLink().then(function () { finish('링크 복사됨'); }); })
      .finally(function () { btn.disabled = false; });
  });

  function captureShot() {
    var el = $('shot');
    el.classList.add('capturing');
    return html2canvas(el, {
      backgroundColor: '#FFFFFF',
      scale: Math.min(2, window.devicePixelRatio || 1),
      logging: false,
      useCORS: false,
    }).then(function (canvas) {
      el.classList.remove('capturing');
      return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    }, function (e) {
      el.classList.remove('capturing');
      throw e;
    });
  }

  $('again').addEventListener('click', function () { enterMeeting(state.token); });
  $('reset2').addEventListener('click', function () {
    stopPolling();
    history.replaceState(null, '', location.pathname);
    state.token = null; state.meeting = null; state.picked = null;
    state.result = null; state.shownSpot = null; state.editingId = null; state.myId = null;
    $('made').hidden = true; $('goto1').hidden = true;
    $('make').textContent = '링크 만들기';
    $('dep').value = ''; checkSubmit();
    go(0);
  });

  /* ------------------------------------------------------------ 진입
   * ?m=<토큰>        → 참여 화면
   * ?m=<토큰>&r=1    → 결과 화면으로 바로 (공유받은 사람이 한 번에 결과를 본다) */
  var params = new URLSearchParams(location.search);
  var token = params.get('m');
  if (token) {
    state.token = token;
    state.myId = localStorage.getItem('gaunde.pid.' + token);
    if (params.get('r')) {
      stationsReady.then(function () {
        // 결과 링크로 들어온 것 = 이미 누군가 계산을 끝냈다는 뜻
        refreshRoster().then(function () { showResult({ expectCached: true }); });
      });
    } else {
      enterMeeting(token);
    }
  } else {
    go(0);
  }
})();
