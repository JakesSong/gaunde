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
  function showResult() {
    go(2);
    $('rtitle').textContent = '계산하는 중';
    $('rlede').textContent = '…';
    $('alts').hidden = true;
    $('acts').hidden = true;
    showErr('err2', '');

    api('/api/meetings/' + encodeURIComponent(state.token) + '/result')
      .then(function (d) {
        state.result = d;
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

  function renderSpot(spot) {
    var d = state.result;
    state.shownSpot = spot;
    var n = d.meeting.participants.length;

    $('rtitle').innerHTML = '가장 먼 사람도 <em>' + spot.maxMin + '분</em>';
    $('rlede').textContent = n + '명 평균 ' + spot.avgMin + '분 · 1인 ' + won(spot.fareAvg) +
      (d.selection && d.selection.fareApprox ? ' (요금은 근사치)' : '');

    /* 같은 역에서 출발하는 사람은 한 줄로 묶는다 — 위아래로 갈리면 같은 역이 두 번 나온다 */
    var groups = [];
    var byStation = {};
    spot.routes.forEach(function (r) {
      var k = r.originId;
      if (byStation[k] === undefined) {
        byStation[k] = groups.length;
        groups.push({ names: [r.name], origin: r.origin, min: r.min, fare: r.fare, legs: r.legs, transfers: r.transfers });
      } else {
        groups[byStation[k]].names.push(r.name);
      }
    });
    groups.sort(function (a, b) { return b.min - a.min; });

    /* 먼 사람이 바깥, 가까운 사람이 안쪽. 위아래로 번갈아 배치한다. */
    var top = [], bottom = [];
    groups.forEach(function (g, i) { (i % 2 === 0 ? top : bottom).push(g); });
    top.reverse();                       // 위쪽은 먼 사람이 맨 위로

    /* 세로 간격을 소요시간에 비례시킨다 — 멀수록 만날 역에서 멀리 그려진다 */
    var maxMin = Math.max.apply(null, groups.map(function (g) { return g.min; })) || 1;
    var pxPerMin = Math.max(1.2, Math.min(7, 96 / maxMin));
    function gapFor(cur, next) {          // next 는 만날 역 쪽으로 한 칸 안쪽
      var diff = Math.abs(cur - (next === undefined ? 0 : next));
      return Math.round(diff * pxPerMin);
    }

    var html = '<div class="rail"></div><div class="railfill"></div>';
    top.forEach(function (g, i) {
      var inner = top[i + 1] ? top[i + 1].min : 0;
      html += stopRow(g, { marginBottom: gapFor(g.min, inner) });
    });
    html += '<div class="stop hit"><div class="who">' + esc(spot.station.name) + '</div>' +
      '<div class="node"></div><div class="mins">여기서 만나기</div></div>';
    bottom.forEach(function (g, i) {
      var inner = i === 0 ? 0 : bottom[i - 1].min;
      html += stopRow(g, { marginTop: gapFor(g.min, inner) });
    });
    $('rmap').innerHTML = html;
    $('rmap').classList.add('on');

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

    var q = encodeURIComponent(spot.station.name);
    $('food').href = 'https://map.kakao.com/?q=' + q + '+맛집';
    $('cafe').href = 'https://map.kakao.com/?q=' + q + '+카페';
    $('acts').hidden = false;
  }

  function stopRow(g, style) {
    var names = g.legs.map(function (l) { return l.lineName; });
    var uniq = names.filter(function (v, i) { return names.indexOf(v) === i; }).join(' → ');
    var css = [];
    if (style.marginTop) css.push('margin-top:' + style.marginTop + 'px');
    if (style.marginBottom) css.push('margin-bottom:' + style.marginBottom + 'px');
    return '<div class="stop"' + (css.length ? ' style="' + css.join(';') + '"' : '') + '>' +
      '<div class="who">' + esc(g.names.join('·')) +
      '<small>' + esc(g.origin) + '</small></div><div class="node"></div>' +
      '<div class="mins">' + g.min + '분' + (uniq ? ' · ' + esc(uniq) : '') +
      (g.transfers ? ' · 환승' + g.transfers : '') +
      (g.fare ? '<br>' + won(g.fare) : '') + '</div></div>';
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
        refreshRoster().then(function () { showResult(); });
      });
    } else {
      enterMeeting(token);
    }
  } else {
    go(0);
  }
})();
