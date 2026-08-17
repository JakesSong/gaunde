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
    mode: 'time',      // 고르는 기준 (time | fare | transfers). 기본은 언제나 시간.
    shownSpot: null,   // 지금 보고 있는 후보 (best 또는 alternatives[i])
    groups: [],        // 지금 그려진 다이어그램의 줄 (같은 역 출발자끼리 묶은 것)
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

  /* 결과 화면을 실제로 본 사람(기기) 을 센다.
   *
   * 서버의 result_viewed 는 결과 API 가 불릴 때마다 쌓이는 모임 단위 조회수라
   * 사람 수를 못 센다. 이건 화면이 실제로 그려진 시점에 기기·모임당 한 번만 보낸다.
   * 가드는 피드백(fbKey)과 같은 방식이고, localStorage 가 막힌 브라우저에서 뚫려도
   * 서버가 client_key 로 다시 걸러낸다. */
  function rvKey() { return 'gaunde.rv.' + state.token; }

  function trackResultView() {
    if (!state.token) return;
    try {
      if (localStorage.getItem(rvKey())) return;
      localStorage.setItem(rvKey(), '1');
    } catch (e) { /* 사파리 프라이빗 등 — 서버 쪽 중복 제거에 맡긴다 */ }
    try {
      var body = JSON.stringify({ event: 'result_view', token: state.token, clientId: clientId });
      if (navigator.sendBeacon && navigator.sendBeacon(API + '/api/track', new Blob([body], { type: 'application/json' }))) return;
      fetch(API + '/api/track', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: body, keepalive: true,
      }).catch(function () {});
    } catch (e) { /* 측정은 기능보다 뒤다 */ }
  }

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.expectCached] 계산이 이미 끝나 있는 게 확실한 진입인지.
   *   결과 링크로 다시 들어온 경우(?r=1)나 이 기기에서 한 번 본 모임이면 참.
   *   "계산하는 중" 이라고 띄워놓고 곧바로 결과가 뜨면 사람을 헷갈리게 한다.
   */
  function showResult(opts) {
    var expectCached = (opts && opts.expectCached) || !!localStorage.getItem(seenKey());
    go(2);
    /* 결과 화면에 헤더는 없다 — 요약은 아래 수치 타일 두 칸이 한다.
       그래서 "아직 결과가 없다" 는 사실만 이 한 줄로 세워 둔다. */
    $('rstat').textContent = expectCached
      ? '결과 불러오는 중…'
      : '계산하는 중… 후보 역을 하나씩 비교하고 있어요';
    $('rstat').hidden = false;
    $('alts').hidden = true;
    $('modes').hidden = true;
    $('acts').hidden = true;
    $('fb').hidden = true;
    $('raxis').hidden = true;
    $('rlegend').hidden = true;
    $('rwhy').hidden = true;
    $('rkeys').hidden = true;
    $('rbasis').hidden = true;
    $('rhops').hidden = true;
    $('rmarks').hidden = true;
    $('rlink').hidden = true;
    showErr('err2', '');

    api('/api/meetings/' + encodeURIComponent(state.token) + '/result')
      .then(function (d) {
        state.result = d;
        /* 새 결과는 늘 기본 기준부터 보여준다. 앞 모임에서 요금으로 보고 나갔다고
           다음 모임이 요금 기준으로 열리면, 기본값이 뭔지 알 수 없게 된다. */
        state.mode = 'time';
        try { localStorage.setItem(seenKey(), '1'); } catch (e) { /* 사파리 프라이빗 등 */ }
        renderModes();
        renderAlts();
        renderSpot(modeBlock().best);
        trackResultView();

        /* 공유 링크는 결과 직행(?m=…&r=1)이 기본이다 — 받은 사람이 한 번 더
           "결과 보기" 를 눌러야 하면 대부분 거기서 끊긴다. */
        $('rlinktext').textContent = resultUrl();
        $('rlink').hidden = false;
        showKakao();
      })
      .catch(function (e) {
        $('rstat').textContent = '아직 계산할 수 없습니다';
        $('rstat').hidden = false;
        $('rmap').innerHTML = '<div class="rail"></div><div class="railfill"></div>';
        $('raxis').hidden = true; $('rlegend').hidden = true; $('rwhy').hidden = true;
        $('rkeys').hidden = true; $('rbasis').hidden = true; $('rhops').hidden = true;
        $('rmarks').hidden = true;
        $('modes').hidden = true;
        $('verdict').textContent = e.message;
      });
  }

  /* ---------------------------------------------------------- 고르는 기준
   * 서버가 기준별 결과를 통째로 내려준다. 토글은 이미 받은 값을 갈아끼울 뿐
   * 다시 계산하지 않는다 — 누를 때마다 계산하면 ODsay 쿼터가 세 배로 나간다.
   *
   * modes 가 없는 응답(예전 서버, 예전 캐시)에서는 최상위 값이 곧 시간 기준이다.
   * 그때는 토글을 아예 감춰서 화면이 지금까지와 똑같이 돈다. */
  var MODE_LABEL = { time: '시간', fare: '요금', transfers: '환승' };

  function modeBlock(mode) {
    var d = state.result;
    if (!d) return null;
    var m = d.modes && d.modes[mode || state.mode];
    return m || { best: d.best, alternatives: d.alternatives || [], selection: d.selection || {} };
  }

  function renderModes() {
    var d = state.result;
    var has = !!(d && d.modes && Object.keys(d.modes).length > 1);
    $('modes').hidden = !has;
    if (!has) return;
    [].slice.call($('moderow').children).forEach(function (b) {
      var on = b.dataset.m === state.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.hidden = !d.modes[b.dataset.m];
    });
    /* 기준을 바꾸면 무엇이 달라지는지 한 줄. 시간 기준일 때만 "기본" 이라고 알린다. */
    var sel = modeBlock().selection || {};
    $('modenote').textContent = state.mode === 'time'
      ? '기본은 시간'
      : '시간은 최대 ' + (sel.modeSlackMin || 10) + '분까지만 양보';
  }

  function renderAlts() {
    var blk = modeBlock();
    if (!blk) return;
    var spots = [blk.best].concat(blk.alternatives || []);
    $('altrows').innerHTML = spots.map(function (a, i) {
      return '<button class="altrow' + (i === 0 ? ' on' : '') + '" type="button" data-i="' + i + '">' +
        '<span class="atop"><b>' + esc(a.station.name) + '</b>' +
        '<em' + (i === 0 ? ' class="rec"' : '') + '>' + altWhy(a, blk.best) + '</em></span>' +
        '<span class="abot">' + altFacts(a) + '</span>' +
        '</button>';
    }).join('');
    $('alts').hidden = spots.length < 2;
  }

  $('moderow').addEventListener('click', function (e) {
    var btn = e.target.closest('.modebtn');
    if (!btn || !state.result || !state.result.modes) return;
    var m = btn.dataset.m;
    if (!m || m === state.mode || !state.result.modes[m]) return;
    state.mode = m;
    renderModes();
    renderAlts();
    renderSpot(modeBlock().best);
    /* 이 토글을 쓰기는 하는지 알아야 한다. 기본(시간)으로 되돌아오는 건 세지 않는다. */
    if (m === 'fare' || m === 'transfers') track('mode_' + m);
  });

  /** 후보를 눌러 그 역 기준 결과로 갈아끼운다 (서버가 이미 경로까지 다 내려줬다) */
  $('altrows').addEventListener('click', function (e) {
    var btn = e.target.closest('.altrow');
    if (!btn || !state.result) return;
    var blk = modeBlock();
    var spots = [blk.best].concat(blk.alternatives || []);
    var spot = spots[+btn.dataset.i];
    if (!spot) return;
    [].slice.call($('altrows').children).forEach(function (el) { el.classList.toggle('on', el === btn); });
    renderSpot(spot);
  });

  function won(v) { return v ? v.toLocaleString('ko-KR') + '원' : '0원'; }

  /* 긴 역 이름은 글자 크기를 한 단계씩 줄여 한 줄에 담는다.
     만날 역 칸은 노드를 레일 한가운데 두려고 폭이 50% 로 고정돼 있어 늘릴 수 없다.
     그래서 '동대문역사문화공원'(9자)이 '…공/원' 으로 갈려 깨졌다.
     여기서는 등급만 정하고 실제 크기는 CSS(.who.n6 ~ .n11)가 들고 있다. */
  function nameFit(name) {
    var n = String(name || '').length;
    if (n <= 5) return '';
    return ' n' + Math.min(11, n);
  }

  /* '다른 후보' 줄에 왜 이게 후보인지 한 줄. 새로 계산하지 않고 이미 받은 값의 차이만 적는다.
     절대값(가장 먼 사람 26분 · 평균 …)은 아랫줄에 그대로 있으니, 윗줄은 추천과 뭐가
     다른지만 말하면 된다 — 그게 없으면 세 줄이 그냥 비슷한 숫자 세 벌로 보인다. */
  function diff(v, unit) {
    if (v === 0) return '동일';
    return (v > 0 ? '+' : '-') + Math.abs(v).toLocaleString('ko-KR') + unit;
  }
  /* 환승 기준이 실제로 줄 세우는 값은 "참여자 환승 횟수 합" 이다(최대가 아니다).
     최대로 견주면 합이 더 큰 후보가 "환승 -1회" 로 보이면서 추천보다 나아 보이는 줄이
     생긴다 — 규칙상 맞는 순서인데 화면에서만 뒤집혀 읽힌다. 그래서 이 기준의 숫자는
     화면 어디서나 합으로 통일하고, 라벨에도 '합' 을 적는다. */
  function hops(a) { return a.transfersTotal === undefined ? null : a.transfersTotal; }

  /* 요금 눈금 한 칸(100원) 안쪽 차이는 사실상 같은 값이다.
     1인 평균 요금은 합을 사람 수로 나눈 값이라 '+37원' 같은 수가 나오는데,
     그렇게 적으면 그 37원 때문에 순위가 밀린 것처럼 읽힌다. 실제로 순위를 가른 건
     대개 그다음 기준(시간)이다. */
  var FARE_TIE_WON = 100;

  /* 지금 기준이 보는 값을 먼저 적는다. 요금 기준인데 시간 차이부터 나오면
     무엇을 보고 이 순서가 됐는지가 줄에서 안 읽힌다. */
  function altWhy(a, best) {
    if (a === best) return '추천';
    var out = [];
    if (state.mode === 'fare') {
      var dFare = a.fareAvg - best.fareAvg;
      out.push(Math.abs(dFare) > 0 && Math.abs(dFare) <= FARE_TIE_WON
        ? '요금 거의 같음'
        : '요금 ' + diff(dFare, '원'));
      out.push('가장 먼 사람 ' + diff(a.maxMin - best.maxMin, '분'));
    } else if (state.mode === 'transfers' && hops(a) !== null && hops(best) !== null) {
      out.push('환승 합 ' + diff(hops(a) - hops(best), '회'));
      out.push('가장 먼 사람 ' + diff(a.maxMin - best.maxMin, '분'));
    } else {
      out.push('가장 먼 사람 ' + diff(a.maxMin - best.maxMin, '분'));
      /* 두 번째 값은 실제로 갈리는 쪽을 고른다. 평균이 같으면 요금이 그 역의 유일한 차이다. */
      if (a.avgMin !== best.avgMin) out.push('평균 ' + diff(a.avgMin - best.avgMin, '분'));
      else if (a.fareAvg !== best.fareAvg) out.push('요금 ' + diff(a.fareAvg - best.fareAvg, '원'));
    }
    return out.join(' · ');
  }

  /* 아랫줄의 절대값도 기준에 맞춰 앞자리를 바꾼다 (값 자체는 늘 같은 세 가지다) */
  function altFacts(a) {
    var time = '가장 먼 사람 ' + a.maxMin + '분 · 평균 ' + a.avgMin + '분';
    if (state.mode === 'fare') return '1인 평균 ' + won(a.fareAvg) + ' · ' + time;
    if (state.mode === 'transfers' && hops(a) !== null) {
      return '환승 합 ' + hops(a) + '회 · ' + time;
    }
    return time + ' · ' + won(a.fareAvg);
  }

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

  /* 아무의 경로도 아닌 레일 구간(가장 먼 사람 바깥쪽, 그리고 이동이 없는 사람 자리)에
     쓰는 중립색. 여기에 누군가의 호선색이 닿으면 "저 사람이 저 노선을 탄다" 는 거짓말이 된다. */
  var RAIL_NEUTRAL = '#D8DCD6';

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
    if (hub < 0) return false;

    /* 각자의 색은 "자기 노드에서 만날 역 쪽" 으로만 칠한다.
       예전에는 이웃 노드와의 중간점을 경계로 삼아서, 한 사람의 호선색이 자기 노드보다
       바깥(만날 역 반대편)까지 새어 나갔다. 그러면 직통으로 오는 사람 옆에도 남의
       호선색이 붙어 환승하는 것처럼 보인다 — 실제로 그렇게 읽혔다는 피드백이 왔다.
         위쪽 사람 i : [자기 노드, 한 칸 안쪽 노드]   (아래로 내려온다)
         아래쪽 사람 i: [한 칸 안쪽 노드, 자기 노드]  (위로 올라온다)
       i±1 이 만날 역이면 그게 곧 안쪽 끝이다. 양쪽 바깥 끝은 아무도 지나지 않으므로
       중립색으로 남긴다 — 그래야 레일이 위아래로 대칭이 되기도 한다. */
    var segs = [];                                        // [{from,to,color}] px 기준, 위→아래 순
    if (centers[0] > 0) segs.push({ from: 0, to: centers[0], color: RAIL_NEUTRAL });
    plan.forEach(function (p, i) {
      if (!p) return;
      var a = i < hub ? centers[i] : centers[i - 1];
      var b = i < hub ? centers[i + 1] : centers[i];
      if (!(b > a)) return;
      /* 이동이 없는 사람(이미 그 역에 있음)은 탄 노선이 없다. 초록으로 칠하면
         타지도 않은 노선을 탄 것처럼 보이므로 중립색으로 둔다. */
      if (!p.legs.length) {
        segs.push({ from: a, to: b, color: RAIL_NEUTRAL });
        return;
      }
      /* 환승 색분할은 자기 arm 안에서만 한다 — "어디서 갈아타는지 보인다" 는 그대로다.
         다리(leg)를 정차역 수에 비례해 나눈다. 아래쪽 사람은 위로 올라오므로
         순서를 뒤집어 깔아야 "출발지 쪽이 첫 호선" 이 된다. */
      var legs = p.toward === 'up' ? p.legs.slice().reverse() : p.legs;
      var total = legs.reduce(function (n, l) { return n + Math.max(1, l.stops || 1); }, 0);
      var at = a;
      legs.forEach(function (l, k) {
        var w = (b - a) * (Math.max(1, l.stops || 1) / total);
        var end = k === legs.length - 1 ? b : at + w;
        segs.push({ from: at, to: end, color: safeColor(l.color) || '#00A84D' });
        at = end;
      });
    });
    var tail = centers[centers.length - 1];
    if (h > tail) segs.push({ from: tail, to: h, color: RAIL_NEUTRAL });
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
    var blk = modeBlock() || { best: d.best, alternatives: d.alternatives || [], selection: d.selection || {} };
    var sel = blk.selection || {};

    /* 상단은 수치 타일이 전부다 — 큰 제목과 설명문은 타일과 같은 숫자를 두 번 말하는
       중복이라 뺐다. 대신 평균은 타일로 되돌린다: "가장 먼 사람" 한 값만 있으면
       한 사람 때문에 고른 것처럼 보이는데, 실제 2단계 선택은 전체 합으로 정해진다.
       셋째 타일만 기준을 따라간다 — 환승으로 골랐는데 환승 수가 화면에 없으면
       무엇을 보고 고른 건지 확인할 길이 없다. */
    /* 타일 셋은 세 지표로 고정한다. 예전에는 셋째 칸이 기준을 따라 요금↔환승으로
       갈아끼워져서, 기본(시간) 기준에서는 환승 수가 화면 어디에도 없었다 —
       무엇을 보고 골랐는지 확인하려면 기준을 바꿔봐야 알 수 있는 화면이었다.
       ('1인 요금' 이라고 적었더니 그 값을 내는 사람이 실제로 없다는 지적도 있었다.
        이건 참여자별 요금의 평균이라 라벨에 '평균' 을 적어야 거짓말이 아니다.) */
    $('rstat').hidden = true;
    $('rkeys').innerHTML =
      '<div class="hi"><b>' + spot.maxMin + '분</b><span>가장 먼 사람</span></div>' +
      '<div><b>' + spot.avgMin + '분</b><span>평균</span></div>' +
      '<div><b>' + won(spot.fareAvg) + '</b><span>1인 평균 요금' +
        (sel.fareApprox ? ' (근사치)' : '') + '</span></div>';
    $('rkeys').hidden = false;

    renderBasis(spot);

    /* 환승은 기준과 무관하게 늘 붙는다 — 타일에서 밀려난 자리를 여기가 받는다. */
    var hopN = hops(spot);
    $('rhops').innerHTML = hopN === null ? '' : '환승 합 <b>' + hopN + '회</b>' +
      (spot.transfersMax === undefined ? '' : ' · 한 사람 최대 <b>' + spot.transfersMax + '회</b>');
    $('rhops').hidden = hopN === null;

    /* 공유 이미지에는 기준 토글이 없다. 이미지만 받은 사람도 무슨 기준으로 고른
       결과인지 알 수 있게 캡쳐 전용 한 줄을 채워 둔다 (화면에서는 안 보인다). */
    $('shotmode').textContent = (MODE_LABEL[state.mode] || '시간') + '을 아끼는 기준으로 고른 결과예요';

    /* 같은 역에서 출발하는 사람은 한 줄로 묶는다 — 위아래로 갈리면 같은 역이 두 번 나온다 */
    var groups = [];
    var byStation = {};
    spot.routes.forEach(function (r) {
      var k = r.originId;
      if (byStation[k] === undefined) {
        byStation[k] = groups.length;
        /* 시간을 잰 그 경로를 그린다. ODsay 실제 경로가 오면 그걸 쓰고(버스 포함),
           없을 때만 지하철 그래프의 최단 경로로 되돌아간다. 이래야 요약의
           "환승 N회" 와 펼친 경로의 환승 수가 같은 경로에서 나온다. */
        var live = r.odsayLegs && r.odsayLegs.length ? r.odsayLegs : null;
        groups.push({ names: [r.name], origin: r.origin, min: r.min, fare: r.fare,
          legs: live || r.legs || [], legsLive: !!live,
          transfers: r.transfers, timeSource: r.timeSource, route: r });
      } else {
        groups[byStation[k]].names.push(r.name);
      }
    });
    groups.sort(function (a, b) { return b.min - a.min; });
    /* 줄을 눌러 경로를 펼칠 때 이 배열에서 찾는다 (data-g 인덱스) */
    state.groups = groups;

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

    /* 가장 오래 걸리는 사람. 이 값이 곧 추천의 기준(maxMin)인데, 27분 vs 26분처럼
       1분 차이로 갈리면 다이어그램 양 끝 중 누가 최장인지 눈으로 못 고른다.
       동률이면 둘 다 표시한다 — 한쪽만 고르면 그게 더 거짓말이다. */
    var farMin = groups.length ? groups[0].min : 0;
    function isFar(g) { return farMin > 0 && g.min === farMin; }

    var html = '<div class="rail"></div><div class="railfill"></div>';
    var plan = [];
    top.forEach(function (g, i) {
      var inner = top[i + 1] ? top[i + 1].min : 0;
      html += stopRow(g, { marginBottom: gapFor(g.min, inner) }, ringStyle([boardColor(g)]), groups.indexOf(g), isFar(g));
      plan.push({ legs: g.legs, toward: 'down' });
    });
    html += '<div class="stop hit"><div class="stopmain">' +
      '<div class="who' + nameFit(spot.station.name) + '">' + esc(spot.station.name) + '</div>' +
      '<div class="node"' + (hubRing ? ' style="' + hubRing + '"' : '') + '></div>' +
      '<div class="mins">여기서 만나기</div></div></div>';
    plan.push(null);
    bottom.forEach(function (g, i) {
      var inner = i === 0 ? 0 : bottom[i - 1].min;
      html += stopRow(g, { marginTop: gapFor(g.min, inner) }, ringStyle([boardColor(g)]), groups.indexOf(g), isFar(g));
      plan.push({ legs: g.legs, toward: 'up' });
    });
    $('rmap').innerHTML = html;
    $('rmap').classList.add('on');

    /* 레일 색칠은 실제 노드 위치를 재야 해서 렌더 뒤에 한다.
       결과 화면이 막 켜진 직후엔 아직 레이아웃 전일 수 있어 한 프레임 뒤 한 번 더 본다.
       줄을 펼쳐 높이가 바뀌면 다시 칠해야 하므로 계획을 들고 있는다. */
    state.railPlan = plan;
    if (!paintRail($('rmap'), plan)) {
      requestAnimationFrame(function () { paintRail($('rmap'), plan); });
    }

    /* 세로축이 소요시간이라는 것을 밝힌다. 참여자가 위아래로 갈리면 "아래쪽이 더 가깝다" 는
       지도식 오해가 생기는데, 실제로는 양쪽 다 바깥으로 갈수록 오래 걸린다.
       굵게는 '소요시간' 하나만 — 한 줄 캡션에 강조가 여럿이면 어디가 요점인지 사라진다.
       (축의 중심이 어디인지는 그림 쪽에서 만날 역 줄의 옅은 띠가 이미 말한다.) */
    $('raxis').innerHTML = '세로 간격 = <b>소요시간</b>이에요 · 바깥쪽일수록 오래 걸려요 · ' +
      '지도 위 거리·방향과는 무관합니다';
    $('raxis').hidden = false;

    /* 범례는 노선도에 있는 호선만 담는다. ODsay 실제 경로에는 버스 구간이 섞이는데,
       버스에는 우리 노선 키가 없어서 여기 넣으면 빈 칩이 하나 생긴다. */
    var seenLines = [];
    groups.forEach(function (g) {
      g.legs.forEach(function (l) {
        if (l.line && state.lines[l.line] && seenLines.indexOf(l.line) < 0) seenLines.push(l.line);
      });
    });
    spot.station.lines.forEach(function (l) { if (seenLines.indexOf(l) < 0) seenLines.push(l); });
    var chips = seenLines.map(function (l) {
      var c = lineColor(l);
      return c ? '<i style="--c:' + c + '">' + esc(lineName(l)) + '</i>' : '';
    }).filter(Boolean);
    /* 색칩만 남긴다. 무슨 색이 무슨 호선인지는 레일을 해독하려면 필요하지만,
       "동그라미 색 = 출발역에서 처음 타는 호선" 같은 긴 해설은 화면을 무겁게만 했다. */
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
    /* "덜 억울합니다" 는 무엇과 견준 값인지가 문장에 없었다. 견주는 상대는
       "누군가의 집 앞에서 보자고 했을 때 가장 불리한 사람" 이고, 그 수를 같이 적어야
       N분이 어디서 나온 차이인지 읽힌다. 억울함의 크기가 아니라 시간 차이를 말한다. */
    $('verdict').innerHTML =
      '가장 멀리서 오는 <b>' + esc(far.names.join('·')) + '</b> 기준으로 <b>' + far.min + '분</b>.<br>' +
      (saved > 0
        ? '누군가의 집 앞에서 봤다면 가장 먼 사람이 <b>' + d.worstIfSomeonesHomeMin + '분</b>, ' +
          '여기로 모이면 <b>' + saved + '분</b> 짧아져요.'
        : '누구 집 앞에서 봐도 가장 먼 사람 시간은 비슷해요.') +
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
    /* 여기 나오는 "후보" 는 세 종류인데 이름이 다 똑같아서, 첫 줄의 큰 수(수백 곳)와
       아래 목록의 세 줄이 서로 안 맞는 것처럼 읽혔다. 부르는 이름을 갈라 놓는다.
         평가한 후보  = 계산을 돌린 역 전체            (pool)
         비슷한 후보  = 기준선 ±톨러런스 안에 든 역     (band)
         보여주는 후보 = 아래 '다른 후보' 목록의 줄 수  (shown)
       셋은 원래 다른 수다. 다르다는 것까지 적어야 불일치로 안 읽힌다. */
    var pool = sel.candidateCount || sel.shortlist || 0;
    var shown = 1 + (blk.alternatives || []).length;
    var srcs = sel.candidateSources || {};
    var addedOrigins = srcs.originsNotHub || 0;
    var tol = sel.toleranceMin || 4;
    var band = sel.bandSize || 1;
    var slack = sel.modeSlackMin || 10;
    var floor = Number.isFinite(sel.minMaxSec) ? Math.round(sel.minMaxSec / 60) : null;
    /* 추천보다 "가장 먼 사람" 이 짧은 후보가 목록에 버젓이 보이는 경우(27분 vs 26분).
       규칙상 맞는 결과지만, 근거를 접어둔 채로는 계산이 틀린 것처럼 보인다. */
    var beaten = (blk.alternatives || []).filter(function (a) { return a.maxMin < blk.best.maxMin; });
    /* 고른 역이 참여자 중 누군가의 출발역인가. 요금 기준에서는 자주 그렇게 되는데
       (안 움직이는 사람은 0원이다), 그 사실을 안 적으면 계산이 이상한 것처럼 보인다. */
    var atHome = spot.routes.filter(function (r) { return r.originId === spot.station.id; });

    var why = [];
    if (spot === blk.best && state.mode !== 'time') {
      /* 부가 기준의 근거. 시간 기준과 규칙 자체가 달라서 문장도 갈라 놓는다.
         "그냥 제일 싼 곳" 이 아니라 "시간을 조금만 양보한 것 중 제일 싼 곳" 이다. */
      var isFare = state.mode === 'fare';
      why.push('지금은 <b>' + MODE_LABEL[state.mode] + '</b> 기준으로 보고 있어요. ' +
        '<b>평가한 후보 ' + pool + '곳</b>에서 고른 건 시간 기준과 같아요.');
      why.push('다만 ' + (isFare ? '요금' : '환승') + '만 줄이면 답이 무너져요 — ' +
        (isFare
          ? '누구 한 사람 집 앞이 늘 이깁니다(그 사람 요금이 0원이 되니까요).'
          : '외곽의 직통역이 늘 이깁니다(한 사람만 편해지고요).') +
        ' 그래서 <b>가장 먼 사람의 시간</b>이 최선값' +
        (floor === null ? '' : '(<b>' + floor + '분</b>)') +
        ' <b>+' + slack + '분</b> 안에 드는 후보 <b>' + band + '곳</b> 안에서만 골라요.');
      why.push('그중 ' + (isFare
        ? '<b>모두가 내는 요금 합이 가장 적은</b> 곳이 여기예요 (1인 평균 <b>' + won(spot.fareAvg) + '</b>'
        : '<b>환승 횟수 합이 가장 적은</b> 곳이 여기예요 (모두 합쳐 <b>' +
          (hops(spot) === null ? '?' : hops(spot)) + '회</b>' +
          (spot.transfersMax === undefined ? '' : ', 가장 많은 사람 <b>' + spot.transfersMax + '회</b>')) +
        ' · 가장 먼 사람 <b>' + spot.maxMin + '분</b>).');
      if (atHome.length) {
        why.push('여기는 <b>' + esc(atHome.map(function (r) { return r.name; }).join('·')) +
          '</b>님의 출발역이에요 — 그래서 ' + (isFare ? '요금이' : '환승이') + ' 적게 나왔어요.');
      }
      why.push('<span style="color:#7C857A">시간이 가장 중요하면 <b>시간</b> 버튼으로 되돌리면 돼요.</span>');
    } else if (spot === blk.best) {
      /* 후보에 출발역도 들어간다는 걸 밝힌다. 환승역만 본다고 오해하면
         "우리 동네가 답인데 왜 안 나오냐" 로 이어진다. */
      why.push('<b>평가한 후보는 ' + pool + '곳</b>이에요 — 환승 되는 역 전체' +
        (addedOrigins > 0
          ? '에, 환승역이 아닌 <b>참여자 출발역 ' + addedOrigins + '곳</b>까지 더한 수예요 ' +
            '(이미 다 같은 동네면 그 동네가 답이 되도록요).'
          : '이에요.'));
      why.push('그 ' + pool + '곳을 다 따져보니 <b>가장 먼 사람</b>의 시간은 아무리 줄여도 ' +
        (floor === null ? '이 정도' : '<b>' + floor + '분</b>') + '이 최선이었어요.');
      why.push(band > 1
        ? '거기서 <b>±' + tol + '분</b> 안에 든 후보 <b>' + band + '곳</b> 중, ' +
          '<b>모두의 시간을 합쳐 가장 짧은</b> 곳이 여기예요 ' +
          '(가장 먼 사람 <b>' + spot.maxMin + '분</b> · 평균 <b>' + spot.avgMin + '분</b>).'
        : '±' + tol + '분 안에 견줄 만한 다른 후보는 없어서 여기로 정했어요.');
      if (beaten.length) {
        why.push('아래 목록에는 <b>' + esc(beaten[0].station.name) + '</b>처럼 가장 먼 사람이 ' +
          '<b>' + beaten[0].maxMin + '분</b>으로 더 짧은 곳도 있어요. ' +
          '그런데도 여기를 고른 건, 그 역은 나머지 사람들이 더 걸려서 <b>합계가 밀렸기</b> 때문이에요.');
      }
      why.push('<span style="color:#7C857A">아래 <b>다른 후보</b>에는 이 중 성적이 좋은 순으로 ' +
        '<b>' + shown + '곳</b>만 추려 보여줘요 — ' + pool + '곳을 다 늘어놓지는 않아요.</span>');
    } else {
      why.push('추천은 <b>' + esc(blk.best.station.name) + '</b>' +
        (state.mode === 'time' ? '' : '(' + MODE_LABEL[state.mode] + ' 기준)') +
        '이고, 지금은 직접 고른 후보를 보고 있어요.');
      why.push('가장 먼 사람 기준으로 ' +
        '<b>' + (spot.maxMin - blk.best.maxMin > 0 ? '+' : '') + (spot.maxMin - blk.best.maxMin) + '분</b> 차이예요.');
    }
    why.push('<span style="color:#7C857A">소요시간에는 <b>환승 대기·환승 도보 시간</b>이 모두 들어 있어요.</span>');
    $('rwhybody').innerHTML = why.join(' ');
    $('rwhy').hidden = false;
    /* 평소엔 접어둔다(정보량). 다만 최댓값 역전이 눈에 보이는 판에서는 펼쳐서 먼저 답한다.
       기준을 바꿔 본 판에서도 펼친다 — 왜 다른 역이 나왔는지가 그 자리의 첫 질문이다. */
    $('rwhy').open = spot === blk.best && (beaten.length > 0 || state.mode !== 'time');

    renderMarks(spot);

    var q = encodeURIComponent(spot.station.name);
    $('food').href = 'https://map.kakao.com/?q=' + q + '+맛집';
    $('cafe').href = 'https://map.kakao.com/?q=' + q + '+카페';
    $('acts').hidden = false;
    renderFeedback();
  }

  /* ---------------------------------------------------------- 계산 기준 배지
   * "요금은 근사치" 라고만 써 있고 시간은 확정처럼 보인다는 피드백이 있었다.
   * 시간이 실시간 API 에서 온 값인지 자체 그래프 근사인지 같은 자리에서 구분한다. */
  function renderBasis(spot) {
    var el = $('rbasis');
    var basis = spot.timeBasis || 'graph';
    var margin = spot.marginMin || 0;
    var text;
    if (basis === 'odsay') {
      text = '실시간 대중교통 기준 · 환승 시간 포함';
    } else if (basis === 'mixed') {
      text = '일부는 실시간 기준 · 나머지는 각역정차 근사(대략 ±' + margin + '분)';
    } else if (basis === 'none') {
      text = '모두 같은 역에서 출발해 이동이 없어요';
    } else {
      text = '각역정차 근사 · 대략 ±' + margin + '분 (환승 시간 포함)';
    }
    el.className = 'basis' + (basis === 'odsay' ? ' live' : '');
    el.textContent = text;
    el.hidden = false;
  }

  /* ---------------------------------------------------------- 시간 외 표식
   * 상권 데이터로 후보를 정렬하는 건 다음 라운드다. 지금은 손으로 고른
   * 번화가 목록으로 칩 하나만 단다. 그래서 대개 아무것도 안 뜬다.
   *
   * 막차(대략) 블록은 뺐다 — 화면이 너무 빽빽하다는 피드백에서 가장 먼저 지목된 덩어리였고,
   * 애초에 계산이 아니라 노선 등급별 통상 범위라 정확도도 값어치도 낮았다.
   * 서버는 여전히 best.lastTrain 을 내려주지만 화면에서는 쓰지 않는다.
   *
   * 환승/단일 노선 태그도 뺐다 — 바로 위 색칩 범례가 이미 그 역을 지나는 노선을
   * 하나하나 이름으로 보여주고 있어서, 그 개수를 다시 세어 주는 칩이었다. */
  function renderMarks(spot) {
    var el = $('rmarks');
    var t = spot.tags || {};
    var parts = [];
    if (t.busyArea) parts.push('<span class="tag"><b>번화가</b></span>');

    el.innerHTML = parts.join('');
    el.hidden = !parts.length;
  }

  /* ------------------------------------------------------------ 결과 피드백 */
  function fbKey() { return 'gaunde.fb.' + state.token; }

  /**
   * 저장값은 'good' | 'bad' | 'bad:사유' 세 꼴이다. 'bad' 인데 사유가 없다는 건
   * 사유를 묻는 화면에서 그냥 떠났다는 뜻이므로, 다시 들어오면 사유부터 묻는다.
   * 예전에는 저장값이 있기만 하면 곧장 감사 문구로 넘어가서, 정작 가장 듣고 싶은
   * "왜 별로였는지" 를 그 기기에서는 영영 못 받았다.
   */
  function renderFeedback() {
    var saved = localStorage.getItem(fbKey()) || '';
    var v = saved.split(':');
    $('fb').hidden = false;
    $('fb').classList.remove('done');
    if (v[0] === 'bad' && !v[1]) return fbAskWhy();
    if (saved) return fbThanks(v[0]);
    $('fbq').textContent = '이 추천, 도움이 됐어요?';
    $('fbvote').hidden = false;
    $('fbwhy').hidden = true;
    $('fbredo').hidden = true;
  }

  function fbAskWhy() {
    $('fb').classList.remove('done');
    $('fbq').textContent = '어떤 점이 아쉬웠나요?';
    $('fbvote').hidden = true;
    $('fbwhy').hidden = false;
    $('fbredo').hidden = false;
  }

  /** kind: 'good' | 'bad' — 무엇에 대한 감사인지에 따라 문구가 다르다. */
  function fbThanks(kind) {
    $('fbvote').hidden = true;
    $('fbwhy').hidden = true;
    /* 답을 받은 뒤에는 한 줄로 줄인다(.done). 다 끝난 위젯이 96px 를 계속 차지하면
       그 아래 값어치 있는 것들이 밀릴 뿐이다. 문구도 한 줄에 들어가게 짧게 줄인다. */
    var line = kind === 'bad'
      ? ['알려줘서 고마워요 🙏', '추천 기준을 손볼게요']
      : ['고마워요 🙌', '역 추천을 다듬는 데 씁니다'];
    $('fbq').innerHTML = '<span class="fbthanks"><b>' + line[0] + '</b><i>' + line[1] + '</i></span>';
    $('fb').classList.add('done');
    $('fbredo').hidden = false;
  }

  /* 한 번 누르면 끝이라 오누름을 되돌릴 수 없었다. 저장은 그대로 두되(중복 집계 방지),
     다시 고를 길은 남긴다. */
  $('fbredo').addEventListener('click', function () {
    try { localStorage.removeItem(fbKey()); } catch (e) { /* 사파리 프라이빗 등 */ }
    renderFeedback();
  });

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
      fbThanks('good');
      return;
    }
    /* 불만족은 이유를 한 번 더 묻는다. 이유 없이 닫아도 'bad' 는 이미 집계되고,
       다음에 다시 들어오면 renderFeedback 이 사유부터 다시 묻는다. */
    sendFeedback('bad');
    fbAskWhy();
  });

  $('fbwhy').addEventListener('click', function (e) {
    var b = e.target.closest('.fbchip');
    if (!b) return;
    sendFeedback('bad', b.dataset.r);
    fbThanks('bad');
  });

  function stopRow(g, style, nodeStyle, gi, far) {
    var names = g.legs.map(function (l) { return l.lineName; });
    var uniq = names.filter(function (v, i) { return names.indexOf(v) === i; }).join(' → ');
    var css = [];
    if (style.marginTop) css.push('margin-top:' + style.marginTop + 'px');
    if (style.marginBottom) css.push('margin-bottom:' + style.marginBottom + 'px');
    /* 실시간 경로에는 버스 노선까지 들어 있어 한 줄에 다 적으면 행이 접혀 다이어그램이
       길어진다. 노선 목록은 줄을 펼치면 그대로 나오므로 여기서는 접어 둔다.
       기준은 상단 문구(실시간 대중교통 기준)가 이미 밝히고 있다. */
    var via = g.timeSource === 'odsay' ? '' : (uniq ? ' · ' + esc(uniq) : '');
    /* 환승을 0회일 때도 적는다. "환승 시간은 따진 거냐" 는 질문이 반복됐는데,
       아무 표기가 없으니 안 따진 것처럼 보인 탓이었다. */
    var hop = g.min === 0 ? '' : ' · ' + (g.transfers ? '환승 ' + g.transfers + '회' : '직통');
    var parts = [g.min + '분' + via + hop];
    if (g.fare) parts.push(won(g.fare));
    /* 이 사람 시간이 실시간 길찾기에서 온 값인지 그래프 추정인지 — 사람마다 다르다.
       32분과 33분으로 순위가 갈리는 판에서 근거의 질이 다르면 그 자리에서 보여야 한다.
       상단 배지(.basis)는 "일부는 실시간" 까지만 말할 수 있어 누가 어느 쪽인지는 못 준다. */
    var src = (g.min === 0 || g.timeSource === 'same-station') ? ''
      : g.timeSource === 'odsay'
        ? '<span class="src live">실시간</span>'
        : '<span class="src">추정</span>';
    /* 각자 경로는 눌렀을 때 만든다.
       미리 그려두면 접혀 있어도 이름·역 이름이 DOM 에 남아 다이어그램 한 줄이
       실제보다 길어 보이고, 안 볼 사람 몫까지 매번 만들게 된다. */
    var can = g.legs.length > 0;
    /* 접힌 상태에서도 무엇이 열리는지 한 조각 미리 보여준다. "경로 보기" 만 있으면
       무슨 화면이 뜨는지 몰라 안 누른다. 환승이 있으면 첫 환승역이 가장 궁금한 값이고,
       직통이면 이미 옆 칸에 "직통" 이 있으니 대신 지나는 역 수를 준다.
       .more 는 펼칠 때 "접기" 로 바뀌므로, 미리보기는 지울 수 있게 따로 둔다. */
    var peek = '';
    if (can) {
      peek = g.transfers && g.legs.length > 1
        ? ' · ' + esc(g.legs[0].to) + ' 환승'
        /* 단위는 'N개 역' 하나로 통일한다. 예전에는 버스만 'N정거장' 이라 같은 화면에
           두 단위가 섞였고, 그게 서로 다른 값을 세는 것처럼 읽혔다. */
        : ' · ' + (g.legs[0].stops || 1) + '개 역';
    }
    return '<div class="stop' + (can ? ' can' : '') + (far ? ' far' : '') + '" data-g="' + gi + '"' +
      (can ? ' tabindex="0" role="button" aria-expanded="false"' : '') +
      (css.length ? ' style="' + css.join(';') + '"' : '') + '>' +
      '<div class="stopmain">' +
      '<div class="who">' + esc(g.names.join('·')) +
      (far ? '<span class="mx">최장</span>' : '') +
      '<small>' + esc(g.origin) +
      (can ? ' <span class="more">경로 보기</span><span class="peek">' + peek + '</span>' : '') +
      '</small></div>' +
      '<div class="node"' + (nodeStyle ? ' style="' + nodeStyle + '"' : '') + '></div>' +
      '<div class="mins">' + parts.join(' · ') + src + '</div></div></div>';
  }

  /* 한 사람의 실제 경로 — 어디서 갈아타는지, 몇 개 역을 지나는지.
   * 이미 응답에 다 들어 있던 값이라 새로 계산하지 않는다. 보여주기만 한다. */
  function legsHtml(g) {
    var r = g.route || {};
    var legs = g.legs || [];
    if (!legs.length) return '';
    var rows = legs.map(function (l, i) {
      var prev = legs[i - 1];
      var tf = '';
      if (prev) {
        /* 환승 지점. 실제 경로에서는 내린 곳과 다음에 타는 곳이 다를 수 있다
           (지하철에서 내려 조금 걸어가 버스를 타는 식). 다르면 둘 다 적는다. */
        tf = prev.to && l.from && prev.to !== l.from
          ? '<div class="tf">↕ ' + esc(prev.to) + ' → ' + esc(l.from) + ' 환승</div>'
          : '<div class="tf">↕ ' + esc(prev.to || l.from) + ' 에서 환승</div>';
      }
      var bus = l.mode === 'bus';
      var c = safeColor(l.color) || (bus ? '#3D5BAB' : '#B9C1B5');
      /* 버스는 노선 이름만으로는 지하철과 구분이 안 된다(“470” 처럼 숫자만 오기도 한다).
         칩 모양(네모)과 '버스' 접두어로 눈에 띄게 갈라 둔다. */
      var label = bus ? '버스 ' + esc(l.lineName) : esc(l.lineName);
      return tf + '<div class="leg' + (bus ? ' bus' : '') + '"><i style="--c:' + c + '"></i>' +
        '<div><b>' + label + '</b> · ' + esc(l.from) + ' → ' + esc(l.to) +
        ' · ' + (l.stops || 1) + '개 역' +
        (l.estimated ? ' <span style="color:#7C857A">(추정 구간)</span>' : '') + '</div></div>';
    });
    /* 무엇을 그린 건지 밝힌다.
       ODsay 실제 경로면 시간·환승·그림이 모두 같은 경로에서 나온 값이다.
       예전 캐시처럼 시간만 실시간이고 경로는 그래프인 경우가 아직 남아 있어 문구를 나눈다. */
    var cap = g.legsLive
      ? '실시간 대중교통 길찾기가 찾은 실제 경로예요 (환승 대기·도보 시간도 소요시간에 들어 있어요).'
      : r.timeSource === 'odsay'
        ? '시간은 실시간 대중교통 기준이고, 아래 경로는 지하철 기준 최단 경로예요 (버스 구간은 표시하지 않아요).'
        : '각역정차 기준 · 대략 ±' + (r.marginMin || 0) + '분' +
          (r.estimated ? ' · 추정 구간이 섞여 있어요' : '');
    return '<div class="legs">' + rows.join('') + '<span class="cap">' + cap + '</span></div>';
  }

  /** 참여자 줄을 눌러 그 사람의 경로를 펼친다 (다시 누르면 접힌다) */
  function toggleStop(row) {
    var g = state.groups[+row.dataset.g];
    if (!g) return;
    var open = row.classList.toggle('open');
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
    var more = row.querySelector('.more');
    if (more) more.textContent = open ? '접기' : '경로 보기';
    var box = row.querySelector('.legs');
    if (open) {
      if (!box) row.insertAdjacentHTML('beforeend', legsHtml(g));
      else box.hidden = false;
    } else if (box) {
      box.hidden = true;
    }
    // 줄 높이가 바뀌었으니 레일 색 경계를 다시 잰다
    if (state.railPlan) requestAnimationFrame(function () { paintRail($('rmap'), state.railPlan); });
  }

  $('rmap').addEventListener('click', function (e) {
    var row = e.target.closest('.stop.can');
    if (row) toggleStop(row);
  });
  $('rmap').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest && e.target.closest('.stop.can');
    if (row) { e.preventDefault(); toggleStop(row); }
  });

  /** 공유하는 링크는 항상 결과 직행이다 (?m=토큰&r=1). */
  function resultUrl() {
    return location.origin + location.pathname + '?m=' + state.token + '&r=1';
  }
  function shareTitle() {
    return (state.meeting ? state.meeting.name : '모임') + ' — 가운데';
  }

  $('rcopy').addEventListener('click', function () {
    var btn = this, text = $('rlinktext').textContent;
    var done = function () { btn.textContent = '복사됨'; setTimeout(function () { btn.textContent = '복사'; }, 1600); };
    track('share_clicked');
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else done();
  });

  /* ---------------------------------------------------------- 카카오톡 공유
   * 카카오 JavaScript 앱키(window.KAKAO_KEY)가 있을 때만 SDK 를 불러온다.
   * 키는 코드에 박지 않는다 — config.js 나 다른 스크립트가 넣어준다.
   * 키가 없으면 버튼 자체가 안 보이고 기존 이미지+링크 공유만 남는다. */
  var kakaoReady = false;
  function showKakao() {
    var on = kakaoReady && !!state.token;
    $('kshare').hidden = !on;
    $('kgap').hidden = !on;
  }
  (function initKakao() {
    var key = window.KAKAO_KEY;
    if (!key) return;
    var s = document.createElement('script');
    s.src = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.2/kakao.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function () {
      try {
        if (window.Kakao && !window.Kakao.isInitialized()) window.Kakao.init(key);
        kakaoReady = !!(window.Kakao && window.Kakao.Share);
      } catch (e) { kakaoReady = false; }
      if (state.result) showKakao();
    };
    s.onerror = function () { kakaoReady = false; };
    document.head.appendChild(s);
  })();

  $('kshare').addEventListener('click', function () {
    if (!kakaoReady) return;
    var btn = this, label = btn.textContent;
    var spot = state.shownSpot;
    var url = resultUrl();
    track('share_kakao');
    try {
      window.Kakao.Share.sendDefault({
        objectType: 'text',
        text: shareTitle() + '\n' +
          (spot ? spot.station.name + '에서 만나요 · 가장 먼 사람 ' + spot.maxMin + '분' : '결과 보기'),
        link: { mobileWebUrl: url, webUrl: url },
      });
    } catch (e) {
      btn.textContent = '카카오톡을 열지 못했어요';
      setTimeout(function () { btn.textContent = label; }, 2000);
    }
  });

  /* 결과 카드를 이미지로 떠서 공유한다.
   * Web Share Level 2(files) 가 되면 공유 시트로,
   * 안 되면(대부분의 PC) 이미지를 내려받고 링크를 복사한다. */
  $('share').addEventListener('click', function () {
    var btn = this;
    track('share_clicked');
    var label = btn.textContent;
    var url = resultUrl();
    var title = shareTitle();

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
    /* 이미지와 링크 화면은 같은 것을 보여줘야 한다.
       예전에는 '왜 이 역' 근거를 캡쳐하는 동안만 강제로 펼쳐서, 링크로 들어온 사람이
       보는 화면(접혀 있음)과 이미지가 서로 달랐다 — 같은 결과를 두 벌로 만든 셈이다.
       그래서 근거는 화면 상태 그대로 두고, 대신 '다른 후보' 목록을 이미지 안으로
       들여온다. 이미지를 받은 사람이 가장 궁금해하는 건 "여기 말고 어디" 다.
       (기준이 무엇이었는지는 캡쳐 전용 한 줄 #shotmode 이 말한다.) */
    var alts = $('alts');
    var altsParent = alts.parentNode;
    var altsNext = alts.nextSibling;
    var movedAlts = !alts.hidden;
    if (movedAlts) el.appendChild(alts);
    el.classList.add('capturing');
    var restore = function () {
      el.classList.remove('capturing');
      if (movedAlts) altsParent.insertBefore(alts, altsNext);
    };
    return html2canvas(el, {
      backgroundColor: '#FFFFFF',
      scale: Math.min(2, window.devicePixelRatio || 1),
      logging: false,
      useCORS: false,
    }).then(function (canvas) {
      restore();
      return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    }, function (e) {
      restore();
      throw e;
    });
  }

  $('again').addEventListener('click', function () { enterMeeting(state.token); });
  $('reset2').addEventListener('click', function () {
    stopPolling();
    history.replaceState(null, '', location.pathname);
    state.token = null; state.meeting = null; state.picked = null;
    state.result = null; state.shownSpot = null; state.editingId = null; state.myId = null;
    state.mode = 'time';
    state.groups = []; state.railPlan = null;
    $('rlink').hidden = true; $('kshare').hidden = true; $('kgap').hidden = true;
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
