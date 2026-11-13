// Sheep: the browser side. It holds no game rules: it sends actions to the
// Supabase functions and draws whatever state the database reports.
(function () {
  'use strict';

  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  var QR_CDN = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm';
  var CFG = window.SHEEP_CONFIG || {};
  var REVEAL_SECONDS = 12;      // how long the server holds the reveal
  var SUSPENSE_MS = 4000;       // first part of the reveal, before the leader's answer drops
  // Question packs the host can switch on and off. An empty list in the
  // room's settings means every pack is on.
  var PACKS = [
    ['general', 'Classics'], ['uk', 'UK culture'], ['pop', 'TV, film and music'],
    ['memes', 'Internet and memes'], ['geography', 'Around the world'],
    ['science', 'Science and nature'], ['numbers', 'Numbers and chance'],
    ['drinking', 'Drinking (18+)']
  ];
  var ALL_PACKS = PACKS.map(function (p) { return p[0]; });

  var sb = null;
  var S = {
    screen: 'boot',          // boot | setup | home | room
    bootError: null,
    urlCode: null,           // room code from the invite link
    roomId: null, me: null,
    room: null, players: [], game: null, gps: [], rounds: [], answers: [],
    questions: {},           // question id -> question with its options
    pick: null,              // option chosen but not yet locked in
    busy: false,
    showSettings: false,
    qr: null,                // { link, svg } once the QR code has been drawn
    stage: ''                // which beat of the reveal is on screen
  };

  var el = {
    top: document.getElementById('top'),
    main: document.getElementById('main'),
    foot: document.getElementById('foot'),
    toast: document.getElementById('toast')
  };
  var lastHtml = { top: null, main: null, foot: null };
  var channel = null, pollTimer = null, toastTimer = null;
  var refreshing = false, refreshAgain = false, lastAdvance = 0;
  var skew = 0;              // server clock minus this device's clock, in ms

  // ---------- small helpers ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* storage unavailable: carry on without it */ }
    return null;
  }

  function now() { return Date.now() + skew; }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3500);
  }

  function setRegion(name, html) {
    if (lastHtml[name] === html) return;
    lastHtml[name] = html;
    el[name].innerHTML = html;
  }

  function playerName(id) {
    var p = S.players.find(function (x) { return x.id === id; });
    return p ? p.nickname : 'Someone';
  }

  function myGp() { return S.gps.find(function (g) { return g.player_id === S.me; }) || null; }
  function leaderId() { return S.game ? S.game.leader_player_id : null; }
  function isHost() { return S.room && S.room.host_player_id === S.me; }
  function totalRounds() { return (S.game && S.game.total_rounds) || 5; }
  function pts(n) { return n + (n === 1 ? ' pt' : ' pts'); }

  function currentRound() {
    if (!S.game) return null;
    return S.rounds.find(function (r) { return r.round_number === S.game.current_round; }) || null;
  }

  function currentQuestion() {
    var round = currentRound();
    return round ? S.questions[round.question_id] : null;
  }

  function optionLabel(questionId, optionId) {
    var q = S.questions[questionId];
    if (!q) return '';
    var o = q.question_options.find(function (x) { return x.id === optionId; });
    return o ? o.label : '';
  }

  function answerOf(roundId, playerId) {
    return S.answers.find(function (a) { return a.round_id === roundId && a.player_id === playerId; }) || null;
  }

  function settings() {
    var s = (S.room && S.room.settings) || {};
    return {
      rounds: s.rounds === 3 ? 3 : 5,
      answer_seconds: s.answer_seconds || 30,
      tight: !!s.tight,
      themes: Array.isArray(s.themes) ? s.themes : []
    };
  }

  function packsOn() {
    var t = settings().themes.filter(function (k) { return ALL_PACKS.indexOf(k) !== -1; });
    return t.length ? t : ALL_PACKS.slice();
  }

  // What an answer says on screen: a listed option's label, or the typed text.
  function said(q, a) {
    if (!a) return '';
    return a.option_id ? optionLabel(q.id, a.option_id) : (a.custom_text || '');
  }

  // Two answers match when their keys match (the server works these out).
  function answerKey(a) { return a.option_id ? String(a.option_id) : 'c:' + a.custom_key; }
  function leaderKey(round) { return round.leader_key || String(round.leader_option_id); }
  function leaderSaid(q, round) { return round.leader_text || optionLabel(q.id, round.leader_option_id); }

  // ---------- sound and vibration ----------

  var audio = null;
  var muted = store('sheep:mute') === '1';
  var played = {};

  function wakeAudio() {
    try {
      if (!audio) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audio = new Ctx();
      }
      if (audio && audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }

  function tone(freq, start, length, type, volume, slideTo) {
    if (!audio || muted) return;
    try {
      var t = audio.currentTime + start;
      var osc = audio.createOscillator(), gain = audio.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length);
      gain.gain.setValueAtTime(volume || 0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + length);
      osc.connect(gain); gain.connect(audio.destination);
      osc.start(t); osc.stop(t + length + 0.02);
    } catch (e) { /* sound is a nice-to-have */ }
  }

  function buzz(pattern) {
    if (muted) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not supported */ }
  }

  var sounds = {
    tick: function () { tone(880, 0, 0.07, 'square', 0.06); },
    lock: function () { tone(520, 0, 0.08, 'sine', 0.12); tone(780, 0.07, 0.12, 'sine', 0.12); },
    start: function () { tone(392, 0, 0.14); tone(523, 0.14, 0.14); tone(659, 0.28, 0.25); },
    drop: function () { tone(220, 0, 0.3, 'triangle', 0.2, 440); },
    out: function () { tone(300, 0, 0.6, 'sawtooth', 0.14, 70); buzz([220, 90, 220]); },
    safe: function () { tone(660, 0, 0.12); tone(990, 0.11, 0.22); },
    win: function () { tone(523, 0, 0.14); tone(659, 0.13, 0.14); tone(784, 0.26, 0.14); tone(1047, 0.39, 0.35); }
  };

  // Plays a sound once per key, so re-drawing the screen never repeats it.
  function playOnce(key, name) {
    if (played[key]) return;
    played[key] = true;
    sounds[name]();
  }

  // ---------- talking to Supabase ----------

  async function rpc(name, args) {
    var res = await sb.rpc(name, args);
    if (res.error) throw new Error(res.error.message || 'Something went wrong');
    return res.data;
  }

  async function act(fn) {
    if (S.busy) return;
    S.busy = true;
    try { await fn(); }
    catch (e) { toast(e.message); }
    finally { S.busy = false; }
  }

  // Line this device's countdown up with the server's clock.
  async function syncClock() {
    try {
      var sent = Date.now();
      var res = await sb.rpc('server_now');
      var got = Date.now();
      if (res.error || !res.data) return;
      var server = new Date(res.data).getTime();
      if (!isNaN(server) && got - sent < 3000) skew = server - (sent + got) / 2;
    } catch (e) { /* keep using the device clock */ }
  }

  async function refresh() {
    if (!S.roomId) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      var roomId = S.roomId;
      var both = await Promise.all([
        sb.from('rooms').select('*').eq('id', roomId).maybeSingle(),
        sb.from('players').select('*').eq('room_id', roomId).order('joined_at')
      ]);
      if (both[0].error || both[1].error) throw new Error('Lost contact with the game. Retrying.');
      var room = both[0].data, players = both[1].data || [];
      if (!room) throw new Error('This room is no longer available.');

      var mine = players.find(function (p) { return p.id === S.me; });
      if (mine && mine.is_banned) {
        goHome(false);
        toast('The host removed you from this room');
        return;
      }

      var game = null, gps = [], rounds = [], answers = [];
      if (room.current_game_id) {
        var gid = room.current_game_id;
        var three = await Promise.all([
          sb.from('games').select('*').eq('id', gid).maybeSingle(),
          sb.from('game_players').select('*').eq('game_id', gid),
          sb.from('rounds').select('*').eq('game_id', gid).order('round_number')
        ]);
        game = three[0].data || null;
        gps = three[1].data || [];
        rounds = three[2].data || [];

        if (rounds.length) {
          var ans = await sb.from('answers').select('*')
            .in('round_id', rounds.map(function (r) { return r.id; }));
          answers = ans.data || [];

          var missing = rounds.map(function (r) { return r.question_id; })
            .filter(function (id) { return !S.questions[id]; });
          if (missing.length) {
            var qs = await sb.from('questions').select('*, question_options(*)').in('id', missing);
            (qs.data || []).forEach(function (q) {
              q.question_options.sort(function (x, y) { return (x.position || 0) - (y.position || 0); });
              S.questions[q.id] = q;
            });
          }
        }
      }

      if (S.roomId !== roomId) return; // left the room while loading
      var before = S.game ? S.game.id + ':' + S.game.current_round + ':' + S.game.state : '';
      S.room = room; S.players = players; S.game = game;
      S.gps = gps; S.rounds = rounds; S.answers = answers;
      var after = game ? game.id + ':' + game.current_round + ':' + game.state : '';
      if (before !== after) S.pick = null;
      render();
    } catch (e) {
      toast(e.message);
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    }
  }

  var kickTimer = null;
  function kick() {
    clearTimeout(kickTimer);
    kickTimer = setTimeout(refresh, 80);
  }

  function subscribe(roomId) {
    unsubscribe();
    var on = function (table, filter) {
      var spec = { event: '*', schema: 'public', table: table };
      if (filter) spec.filter = filter;
      channel.on('postgres_changes', spec, kick);
    };
    channel = sb.channel('room-' + roomId);
    on('rooms', 'id=eq.' + roomId);
    on('players', 'room_id=eq.' + roomId);
    on('games', 'room_id=eq.' + roomId);
    on('game_players'); on('rounds'); on('answers');
    channel.subscribe();
    // Safety net in case a live update is missed.
    pollTimer = setInterval(refresh, 2500);
  }

  function unsubscribe() {
    if (channel) { try { sb.removeChannel(channel); } catch (e) { /* ignore */ } channel = null; }
    clearInterval(pollTimer); pollTimer = null;
  }

  async function enterRoom(result) {
    S.roomId = result.room_id; S.me = result.player_id;
    S.urlCode = result.code;
    store('sheep:in', result.code);
    try { history.replaceState(null, '', location.pathname + '?room=' + result.code); } catch (e) { /* file:// */ }
    S.screen = 'room';
    subscribe(S.roomId);
    syncClock();
    await refresh();
  }

  function goHome(keepCode) {
    unsubscribe();
    store('sheep:in', null);
    S.roomId = null; S.me = null; S.room = null; S.game = null;
    S.players = []; S.gps = []; S.rounds = []; S.answers = []; S.pick = null;
    S.showSettings = false; S.qr = null;
    if (!keepCode) {
      S.urlCode = null;
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// */ }
    }
    S.screen = 'home';
    render();
  }

  function inviteLink() { return location.origin + location.pathname + '?room=' + S.room.code; }

  // Draws the invite link as a QR code. If the drawing library cannot be
  // loaded the lobby simply shows the code and link without it.
  async function loadQr() {
    var link = inviteLink();
    if (S.qr && S.qr.link === link) return;
    S.qr = { link: link, svg: '' };
    try {
      var lib = window.__qrLib;
      if (!lib) { var mod = await import(QR_CDN); lib = mod.default || mod.qrcode || mod; }
      var qr = lib(0, 'M');
      qr.addData(link);
      qr.make();
      var n = qr.getModuleCount(), path = '';
      for (var r = 0; r < n; r++) {
        for (var c = 0; c < n; c++) {
          if (qr.isDark(r, c)) path += 'M' + (c + 2) + ' ' + (r + 2) + 'h1v1h-1z';
        }
      }
      var size = n + 4;
      S.qr.svg = '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="QR code to join this room">' +
        '<rect width="' + size + '" height="' + size + '" rx="1.5" fill="#FFF8E7"/>' +
        '<path d="' + path + '" fill="#171936"/></svg>';
      render();
    } catch (e) { /* no QR code this time */ }
  }

  // ---------- actions ----------

  function readNickname() {
    var input = document.getElementById('nick');
    var nick = (input ? input.value : '').trim().replace(/\s+/g, ' ');
    if (!nick) { toast('Type a name first'); if (input) input.focus(); return null; }
    store('sheep:nick', nick);
    return nick;
  }

  var actions = {
    create: function () {
      var nick = readNickname(); if (!nick) return;
      act(async function () { await enterRoom(await rpc('create_room', { p_nickname: nick })); });
    },
    join: function () {
      var nick = readNickname(); if (!nick) return;
      var codeInput = document.getElementById('code');
      var code = (S.urlCode || (codeInput ? codeInput.value : '')).trim().toUpperCase();
      if (code.length !== 4) { toast('Room codes are 4 letters'); return; }
      act(async function () { await enterRoom(await rpc('join_room', { p_code: code, p_nickname: nick })); });
    },
    forget: function () { goHome(false); },
    copy: function () {
      var link = inviteLink();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(
          function () { toast('Invite link copied'); },
          function () { toast(link); });
      } else { toast(link); }
    },
    mute: function () {
      muted = !muted;
      store('sheep:mute', muted ? '1' : null);
      if (!muted) sounds.lock();
      render();
    },
    toggleSettings: function () { S.showSettings = !S.showSettings; render(); },
    set: function (btn) {
      var s = settings();
      var key = btn.getAttribute('data-key'), val = btn.getAttribute('data-val');
      if (key === 'rounds') s.rounds = Number(val);
      else if (key === 'answer_seconds') s.answer_seconds = Number(val);
      else if (key === 'tight') s.tight = val === 'true';
      else if (key === 'pack') {
        var on = packsOn();
        on = on.indexOf(val) === -1 ? on.concat(val) : on.filter(function (t) { return t !== val; });
        if (!on.length) { toast('Keep at least one pack switched on'); return; }
        s.themes = on.length === ALL_PACKS.length ? [] : on;
      }
      act(async function () {
        await rpc('update_settings', { p_room_id: S.roomId, p_settings: s });
        await refresh();
      });
    },
    kick: function (btn) {
      var id = btn.getAttribute('data-id');
      act(async function () {
        await rpc('kick_player', { p_room_id: S.roomId, p_player_id: id });
        toast('Removed ' + playerName(id));
        await refresh();
      });
    },
    start: function () {
      act(async function () { await rpc('start_game', { p_room_id: S.roomId }); await refresh(); });
    },
    again: function () {
      act(async function () { await rpc('play_again', { p_room_id: S.roomId }); await refresh(); });
    },
    leave: function () {
      act(async function () {
        try { await rpc('leave_room', { p_room_id: S.roomId }); } finally { goHome(false); }
      });
    },
    pick: function (btn) {
      S.pick = btn.getAttribute('data-id');
      var search = document.getElementById('search');
      if (search) {
        // typed entry: the chosen match fills the box and the suggestions go away
        search.value = btn.textContent;
        search.classList.add('chosen');
        document.getElementById('suggest').innerHTML = '';
        document.getElementById('hint').textContent = 'Change it by typing again';
      } else {
        el.main.querySelectorAll('.options button').forEach(function (b) {
          b.classList.toggle('picked', b === btn);
        });
      }
      var lock = document.getElementById('lock');
      if (lock) { lock.disabled = false; lock.textContent = 'Lock in ' + btn.textContent; }
    },
    lock: function () {
      if (!S.game) return;
      var option = S.pick;
      var box = document.getElementById('search');
      var q = currentQuestion();
      var typed = box && q && q.allow_custom ? box.value.trim() : '';
      if (!option && plain(typed).length < 2) return;
      act(async function () {
        if (option) await rpc('submit_answer', { p_game_id: S.game.id, p_option_id: option });
        else await rpc('submit_custom_answer', { p_game_id: S.game.id, p_text: typed });
        sounds.lock();
        await refresh();
      });
    }
  };

  document.addEventListener('click', function (e) {
    wakeAudio();
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    var fn = actions[btn.getAttribute('data-act')];
    if (fn) fn(btn);
  });

  // ---------- typed answers ----------

  // Plain lower-case text with accents and punctuation removed, for matching.
  function plain(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Number of single-letter edits between two strings, giving up past `max`.
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      var best = cur[0];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  // Up to six answers that match what has been typed so far. Nothing is
  // suggested until two characters are in, unless the text is an exact answer.
  // Small spelling slips are forgiven once four letters have been typed.
  function suggest(q, text) {
    var term = plain(text);
    if (!term) return [];
    var allow = /^[0-9 ]+$/.test(term) ? 0 : term.length >= 8 ? 2 : term.length >= 4 ? 1 : 0;
    var found = [];
    q.question_options.forEach(function (o) {
      var best = 9;
      [o.label].concat(o.aliases || []).forEach(function (name) {
        var n = plain(name), score = 9;
        if (n === term) score = 0;
        else if (term.length >= 2 && n.indexOf(term) === 0) score = 1;
        else if (term.length >= 2 && (' ' + n).indexOf(' ' + term) !== -1) score = 2;
        else if (term.length >= 3 && n.indexOf(term) !== -1) score = 3;
        else if (allow && (editDistance(term, n, allow) <= allow ||
                           editDistance(term, n.slice(0, term.length), allow) <= allow)) score = 4;
        if (score < best) best = score;
      });
      if (best < 9) found.push({ o: o, score: best });
    });
    found.sort(function (a, b) {
      return a.score - b.score || a.o.label.length - b.o.label.length || a.o.label.localeCompare(b.o.label);
    });
    return found.slice(0, 6).map(function (f) { return f.o; });
  }

  document.addEventListener('input', function (e) {
    if (e.target.id !== 'search') return;
    var q = currentQuestion(); if (!q) return;
    var box = document.getElementById('suggest');
    var hint = document.getElementById('hint');
    var lock = document.getElementById('lock');
    // typing again cancels an earlier choice
    S.pick = null;
    e.target.classList.remove('chosen');
    if (lock) { lock.disabled = true; lock.textContent = 'Lock in'; }
    var matches = suggest(q, e.target.value);
    box.innerHTML = matches.map(function (o) {
      return '<button data-act="pick" data-id="' + esc(o.id) + '">' + esc(o.label) + '</button>';
    }).join('');
    var len = plain(e.target.value).length;
    var open = !!q.allow_custom && len >= 2;
    // open-ended questions take whatever is typed, listed or not
    if (open && lock) {
      lock.disabled = false;
      lock.textContent = 'Lock in "' + e.target.value.trim() + '"';
    }
    hint.textContent = matches.length ? (open ? 'Pick a match, or lock in what you typed' : 'Pick a match')
      : len === 0 ? 'Start typing and pick a match'
      : len < 2 ? 'Keep typing'
      : open ? 'Not on our list, but you can lock it in'
      : 'No match yet. Try another spelling or another answer.';
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'nick' || e.target.id === 'code') {
      var codeBox = document.getElementById('code');
      if (S.urlCode || (codeBox && codeBox.value.trim())) actions.join(); else actions.create();
    } else if (e.target.id === 'search') {
      if (S.pick) { actions.lock(); return; }
      var first = document.querySelector('#suggest button');
      var only = document.querySelectorAll('#suggest button').length === 1;
      var q = currentQuestion();
      var exact = first && q && plain(first.textContent) === plain(e.target.value);
      if (first && (only || exact)) actions.pick(first);
    }
  });

  // ---------- screens ----------

  function muteButton() {
    return '<button class="quiet" data-act="mute">Sound is ' + (muted ? 'off' : 'on') + '</button>';
  }

  function homeView() {
    var nick = store('sheep:nick') || '';
    var joinPart = S.urlCode
      ? '<button class="primary" data-act="join">Join room ' + esc(S.urlCode) + '</button>' +
        '<button class="quiet" data-act="forget">Create a new room instead</button>'
      : '<button class="primary" data-act="create">Create a room</button>' +
        '<p class="divider">or join a friend\'s room</p>' +
        '<div class="row"><input type="text" id="code" maxlength="4" placeholder="Code" ' +
        'autocomplete="off" autocapitalize="characters" aria-label="Room code">' +
        '<button data-act="join">Join</button></div>';
    return {
      top: '',
      main:
        '<div class="hero"><h1 class="logo">Sheep</h1>' +
        '<p class="tagline">Think like the leader and you are out.</p></div>' +
        '<ol class="rules">' +
        '<li>One player is the leader. Everyone answers the same question in secret.</li>' +
        '<li>Give the same answer as the leader and you are out.</li>' +
        '<li>Survive every round to win. The choices shrink each round.</li>' +
        '</ol>' +
        '<label class="field">Your name' +
        '<input type="text" id="nick" maxlength="16" autocomplete="nickname" value="' + esc(nick) + '"></label>' +
        joinPart,
      foot: ''
    };
  }

  function seg(key, val, label, on) {
    return '<button class="' + (on ? 'on' : '') + '" data-act="set" data-key="' + key + '" data-val="' + val +
      '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>';
  }

  function settingsSummary() {
    var s = settings();
    var on = packsOn();
    var themes = on.length === ALL_PACKS.length ? 'all packs'
      : on.length + (on.length === 1 ? ' pack' : ' packs') + ' on';
    return s.rounds + ' rounds, ' + s.answer_seconds + ' seconds to answer, ' +
      (s.tight ? 'tight early rounds, ' : '') + themes;
  }

  function settingsPanel() {
    var s = settings();
    return '<div class="settings">' +
      '<p>Rounds</p><div class="seg">' + seg('rounds', 3, '3', s.rounds === 3) + seg('rounds', 5, '5', s.rounds === 5) + '</div>' +
      '<p>Seconds to answer</p><div class="seg">' +
        [20, 30, 45, 60].map(function (n) { return seg('answer_seconds', n, String(n), s.answer_seconds === n); }).join('') + '</div>' +
      '<p>Early rounds</p><div class="seg">' +
        seg('tight', 'false', 'Wide open', !s.tight) + seg('tight', 'true', 'Tight', s.tight) + '</div>' +
      '<p class="note small">' + (s.tight
        ? 'Tight: smaller answer lists early on, so matches come sooner.'
        : 'Wide open: huge answer lists early on, so the first rounds are safer.') + '</p>' +
      '<p>Question packs</p><div class="seg wrap">' +
        PACKS.map(function (t) { return seg('pack', t[0], t[1], packsOn().indexOf(t[0]) !== -1); }).join('') + '</div>' +
      '<p class="note small">Tap a pack to switch it on or off.</p>' +
      '</div>';
  }

  function lobbyView() {
    var here = S.players.filter(function (p) { return p.is_connected && !p.is_banned; });
    var host = S.room.host_player_id;
    var anyScore = here.some(function (p) { return p.score > 0; });
    var ranked = anyScore ? here.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }) : here;
    var list = ranked.map(function (p) {
      var tags = [];
      if (p.id === host) tags.push('host');
      if (p.id === S.me) tags.push('you');
      if (anyScore) tags.push(pts(p.score || 0));
      return '<li><span class="name">' + esc(p.nickname) + '</span>' +
        '<span class="tag">' + tags.join(', ') + '</span>' +
        (isHost() && p.id !== S.me
          ? '<button class="mini" data-act="kick" data-id="' + esc(p.id) + '" aria-label="Remove ' + esc(p.nickname) + '">Remove</button>'
          : '') + '</li>';
    }).join('');
    var tiles = String(S.room.code).split('').map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('');
    var action;
    if (isHost()) {
      action =
        '<button data-act="toggleSettings" aria-expanded="' + (S.showSettings ? 'true' : 'false') + '">' +
        (S.showSettings ? 'Hide game settings' : 'Game settings') + '</button>' +
        (S.showSettings ? settingsPanel() : '<p class="note center small">' + esc(settingsSummary()) + '</p>') +
        '<button class="primary" data-act="start"' + (here.length < 3 ? ' disabled' : '') + '>Start game</button>' +
        (here.length < 3
          ? '<p class="note center">You need at least 3 players. ' + here.length + ' so far.</p>'
          : '<p class="note center">' + here.length + ' players are in.</p>');
    } else {
      action = '<p class="note center small">' + esc(settingsSummary()) + '</p>' +
        '<p class="banner info">Waiting for ' + esc(playerName(host)) + ' to start the game</p>';
    }
    var qr = S.qr && S.qr.svg ? '<div class="qr">' + S.qr.svg + '</div>' : '';
    return {
      top: '',
      main:
        '<p class="note center">Scan or share this code to invite friends</p>' +
        '<div class="code" aria-label="Room code ' + esc(S.room.code) + '">' + tiles + '</div>' +
        qr +
        '<button data-act="copy">Copy invite link</button>' +
        '<ul class="people">' + list + '</ul>' +
        action +
        '<div class="row center-row"><button class="quiet" data-act="leave">Leave room</button>' + muteButton() + '</div>',
      foot: ''
    };
  }

  function topBar(label) {
    return '<div class="topbar"><span>' + esc(label) + '</span><span class="clock" id="clock"></span></div>' +
      '<div class="bar"><i id="bar"></i></div>';
  }

  function roundLabel() { return 'Round ' + S.game.current_round + ' of ' + totalRounds(); }

  function watcherBanner() {
    return myGp() ? '' : '<p class="banner info">This game started before you joined. You are in the next one.</p>';
  }

  function chipsFoot() {
    var round = S.game.current_round;
    var chips = S.gps.slice().sort(function (a, b) {
      return (a.role === 'LEADER' ? 0 : 1) - (b.role === 'LEADER' ? 0 : 1);
    }).map(function (g) {
      var cls = [];
      if (g.role === 'LEADER') cls.push('lead');
      if (g.status === 'ELIMINATED') cls.push('out');
      else if (g.last_answered_round >= round) cls.push('done');
      return '<li class="' + cls.join(' ') + '">' + esc(playerName(g.player_id)) +
        (g.role === 'LEADER' ? ' (leader)' : '') + '</li>';
    }).join('');
    return '<ul class="chips" aria-label="Who has answered">' + chips + '</ul>';
  }

  function leaderRevealView() {
    var mine = leaderId() === S.me;
    playOnce('start:' + S.game.id, 'start');
    return {
      top: topBar('Get ready'),
      main: watcherBanner() +
        '<div class="stage">' +
        '<p class="note">' + (mine ? 'This game' : 'The leader is') + '</p>' +
        '<p class="big glow pop">' + (mine ? 'You are the leader' : esc(playerName(leaderId()))) + '</p>' +
        '<p>' + (mine
          ? 'Answer like the flock. Anyone who matches you is out. Catch them all to win.'
          : 'Never give the same answer as the leader. Last ' + totalRounds() + ' rounds to win.') + '</p>' +
        '</div>',
      foot: ''
    };
  }

  function answeringView() {
    var round = currentRound();
    var q = round ? S.questions[round.question_id] : null;
    if (!round || !q) return { top: topBar(roundLabel()), main: '<p class="note">Loading the question</p>', foot: '' };

    var gp = myGp();
    var mine = answerOf(round.id, S.me);
    var amLeader = leaderId() === S.me;
    var ghost = gp && gp.status === 'ELIMINATED';
    var body;

    if (!gp) {
      body = watcherBanner();
    } else if (mine || gp.last_answered_round >= S.game.current_round) {
      body = '<div class="stage"><p class="note">' + (ghost ? 'Your guess' : 'Locked in') + '</p>' +
        '<p class="big">' + esc(said(q, mine)) + '</p>' +
        '<p>Waiting for the others</p></div>';
    } else {
      var typed = q.input_type === 'SEARCH';
      var entry;
      if (typed) {
        // Big lists are never shown. Players type, and only close matches appear.
        entry = '<div class="typed">' +
          '<input type="text" id="search" maxlength="40" placeholder="Type your answer" autocomplete="off" ' +
          'autocorrect="off" spellcheck="false" aria-label="Your answer">' +
          '<p class="hint" id="hint">Start typing and pick a match</p>' +
          '<div class="options suggest" id="suggest"></div></div>';
      } else {
        entry = '<div class="' + (q.question_options.length <= 4 ? 'options wide' : 'options') + '">' +
          q.question_options.map(function (o) {
            return '<button data-act="pick" data-id="' + esc(o.id) + '">' + esc(o.label) + '</button>';
          }).join('') + '</div>';
      }
      body =
        (ghost
          ? '<p class="banner info">You are out, but still in the scores. Guess what ' +
            esc(playerName(leaderId())) + ' will say for a bonus point.</p>'
          : '<p class="note">' + (amLeader
            ? 'You are the leader. Answer what the flock will answer.'
            : 'Do not match ' + esc(playerName(leaderId())) + '.') + '</p>') +
        entry +
        '<button class="primary" id="lock" data-act="lock" disabled>' +
        (typed ? 'Lock in' : 'Choose an answer') + '</button>';
    }

    return {
      top: topBar(roundLabel()),
      main: '<h1>' + esc(q.prompt) + '</h1>' + body,
      foot: chipsFoot()
    };
  }

  // The reveal plays in two beats: first everyone's answers with the leader's
  // hidden, then the leader's answer drops and the eliminations show.
  function revealBeat() {
    if (!S.game || S.game.state !== 'REVEAL' || !S.game.state_deadline) return 'drop';
    var left = new Date(S.game.state_deadline).getTime() - now();
    return left > REVEAL_SECONDS * 1000 - SUSPENSE_MS ? 'suspense' : 'drop';
  }

  function revealView() {
    var round = currentRound();
    var q = round ? S.questions[round.question_id] : null;
    if (!round || !q) return { top: topBar(roundLabel()), main: '<p class="note">Loading</p>', foot: '' };

    var n = S.game.current_round;
    var gp = myGp();
    var beat = revealBeat();
    var drop = beat === 'drop';
    var key = S.game.id + ':' + n;

    var banner = watcherBanner();
    if (drop) {
      playOnce('drop:' + key, 'drop');
      if (gp && gp.role === 'FLOCK') {
        if (gp.eliminated_round === n) {
          playOnce('fate:' + key, 'out');
          banner = '<p class="banner bad pop">' + (gp.eliminated_reason === 'NO_ANSWER'
            ? 'You ran out of time. You are out.'
            : 'You matched the leader. You are out.') + '</p>';
        } else if (gp.status === 'ALIVE') {
          playOnce('fate:' + key, 'safe');
          banner = '<p class="banner good pop">You are safe</p>';
        } else {
          var guess = answerOf(round.id, S.me);
          if (guess && answerKey(guess) === leaderKey(round)) {
            playOnce('fate:' + key, 'safe');
            banner = '<p class="banner good pop">Good guess. Bonus point.</p>';
          }
        }
      }
    } else if (gp) {
      banner = '<p class="banner info">Did anyone match the leader?</p>';
    }

    var rows = S.gps.filter(function (g) {
      return g.role === 'FLOCK' && (g.status === 'ALIVE' || g.eliminated_round === n);
    }).map(function (g) {
      var a = answerOf(round.id, g.player_id);
      var hit = g.eliminated_round === n;
      var text = a ? said(q, a) : 'No answer';
      var cls = drop ? (hit ? 'hit' : 'safe') : '';
      return '<li class="' + cls + '"><span class="name">' + esc(playerName(g.player_id)) +
        '</span><span class="tag">' + esc(text) + (drop && hit ? ', out' : '') + '</span></li>';
    }).join('');

    var ghosts = '';
    if (drop) {
      ghosts = S.gps.filter(function (g) {
        return g.role === 'FLOCK' && g.status === 'ELIMINATED' && g.eliminated_round < n && answerOf(round.id, g.player_id);
      }).map(function (g) {
        var a = answerOf(round.id, g.player_id);
        var right = answerKey(a) === leaderKey(round);
        return '<li class="' + (right ? 'safe' : 'out') + '"><span class="name">' + esc(playerName(g.player_id)) +
          '</span><span class="tag">' + esc(said(q, a)) + (right ? ', +1' : '') + '</span></li>';
      }).join('');
      if (ghosts) ghosts = '<h2>Guesses from players already out</h2><ul class="people">' + ghosts + '</ul>';
    }

    return {
      top: topBar(roundLabel()),
      main:
        '<p class="note center">' + esc(q.prompt) + '</p>' +
        '<div class="center"><p class="note">' + esc(playerName(leaderId())) + ' the leader said</p>' +
        (drop
          ? '<p class="big glow pop">' + esc(leaderSaid(q, round)) + '</p>'
          : '<p class="big glow wait">?</p>') + '</div>' +
        banner +
        '<ul class="people">' + rows + '</ul>' + ghosts,
      foot: ''
    };
  }

  function gameOverView() {
    var leaderWon = S.game.winner_side === 'LEADER';
    var gp = myGp();
    var flock = S.gps.filter(function (g) { return g.role === 'FLOCK'; });
    var survivors = flock.filter(function (g) { return g.status === 'ALIVE'; });

    var personal = '';
    if (gp) {
      var won = gp.role === 'LEADER' ? leaderWon : gp.status === 'ALIVE';
      if (won) playOnce('win:' + S.game.id, 'win');
      personal = '<p class="banner ' + (won ? 'good' : 'bad') + '">' + (won ? 'You won' : 'You lost') + '</p>';
    }

    var scoreOf = function (id) {
      var p = S.players.find(function (x) { return x.id === id; });
      return p ? (p.score || 0) : 0;
    };
    var rows = S.gps.slice().sort(function (a, b) {
      return scoreOf(b.player_id) - scoreOf(a.player_id) || (b.points || 0) - (a.points || 0);
    }).map(function (g) {
      var what = g.role === 'LEADER' ? 'leader'
        : g.status === 'ALIVE' ? 'survived' : 'out in round ' + g.eliminated_round;
      var cls = g.role === 'LEADER' ? 'lead' : g.status === 'ALIVE' ? 'safe' : '';
      return '<li class="' + cls + '"><span class="name">' + esc(playerName(g.player_id)) +
        '<small>' + what + ', +' + (g.points || 0) + ' this game</small></span>' +
        '<span class="tag total">' + pts(scoreOf(g.player_id)) + '</span></li>';
    }).join('');

    var history = S.rounds.filter(function (r) { return r.revealed_at; }).map(function (r) {
      var q = S.questions[r.question_id];
      return '<li><span class="name">' + esc(q ? q.prompt : 'Round ' + r.round_number) + '</span>' +
        '<span class="tag">' + esc(q ? leaderSaid(q, r) : '') + '</span></li>';
    }).join('');

    var action = isHost()
      ? '<button class="primary" data-act="again">Play again</button>'
      : '<p class="banner info">Waiting for ' + esc(playerName(S.room.host_player_id)) + ' to start another game</p>';

    return {
      top: '',
      main:
        '<div class="center"><p class="note">Game over</p>' +
        '<p class="big glow pop">' + (leaderWon
          ? esc(playerName(leaderId())) + ' wins'
          : 'The flock wins') + '</p>' +
        '<p>' + (leaderWon
          ? 'The leader caught every player.'
          : survivors.length + (survivors.length === 1 ? ' player' : ' players') + ' never matched the leader.') + '</p></div>' +
        personal +
        '<h2>Scores</h2>' +
        '<ul class="people">' + rows + '</ul>' +
        '<h2>What ' + esc(playerName(leaderId())) + ' the leader said</h2>' +
        '<ul class="people">' + history + '</ul>' +
        action +
        '<div class="row center-row"><button class="quiet" data-act="leave">Leave room</button>' + muteButton() + '</div>',
      foot: ''
    };
  }

  function view() {
    if (S.screen === 'boot') return { top: '', main: '<p class="note">Loading</p>', foot: '' };
    if (S.screen === 'setup') {
      return {
        top: '',
        main: '<div class="hero"><h1 class="logo">Sheep</h1></div><p class="banner bad">' + esc(S.bootError) + '</p>',
        foot: ''
      };
    }
    if (S.screen === 'home') return homeView();
    if (!S.room) return { top: '', main: '<p class="note">Joining the room</p>', foot: '' };
    if (S.room.status === 'CLOSED') {
      return { top: '', main: '<p class="banner info">This room has closed.</p>' +
        '<button class="primary" data-act="forget">Back to start</button>', foot: '' };
    }
    if (S.room.status === 'LOBBY' || !S.room.current_game_id) { loadQr(); return lobbyView(); }
    if (!S.game) return { top: '', main: '<p class="note">Loading the game</p>', foot: '' };
    if (S.game.state === 'LEADER_REVEAL') return leaderRevealView();
    if (S.game.state === 'ANSWERING') return answeringView();
    if (S.game.state === 'REVEAL') return revealView();
    return gameOverView();
  }

  function render() {
    S.stage = revealBeat();
    var v = view();
    setRegion('top', v.top);
    setRegion('main', v.main);
    setRegion('foot', v.foot);
    tick();
  }

  // ---------- countdown and moving the game on ----------

  var lastTickSecond = -1;

  function tick() {
    var g = S.screen === 'room' ? S.game : null;
    if (!g || !g.state_deadline || g.state === 'GAME_OVER') return;
    var left = new Date(g.state_deadline).getTime() - now();
    var secs = Math.max(0, Math.ceil(left / 1000));
    var clock = document.getElementById('clock');
    var bar = document.getElementById('bar');
    if (clock) {
      clock.textContent = secs;
      clock.classList.toggle('low', secs <= 5 && g.state === 'ANSWERING');
    }
    if (bar) {
      var total = (g.state === 'ANSWERING' ? (g.answer_seconds || 30)
        : g.state === 'REVEAL' ? REVEAL_SECONDS : 5) * 1000;
      bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    }
    // a tick for each of the last five seconds, while this player still has to answer
    if (g.state === 'ANSWERING' && secs !== lastTickSecond) {
      lastTickSecond = secs;
      if (secs >= 1 && secs <= 5 && document.getElementById('lock')) sounds.tick();
    }
    // the reveal moves from suspense to the drop part-way through
    if (g.state === 'REVEAL' && revealBeat() !== S.stage) { render(); return; }
    // When time is up, ask the server to move on. Every player's device does
    // this; the server ignores all but the first.
    if (left < -250 && Date.now() - lastAdvance > 1500) {
      lastAdvance = Date.now();
      sb.rpc('advance_game', { p_game_id: g.id }).then(function () { refresh(); });
    }
  }

  // ---------- start up ----------

  async function boot() {
    render();
    try {
      if (window.__sheepClient) {
        sb = window.__sheepClient;
      } else {
        if (!CFG.url || !CFG.key || /YOUR_/.test(CFG.url + CFG.key)) {
          throw new Error('Setup needed: add your Supabase URL and key to config.js.');
        }
        var lib = await import(CDN);
        sb = lib.createClient(CFG.url, CFG.key);
      }

      var got = await sb.auth.getSession();
      var session = got.data ? got.data.session : null;
      if (!session) {
        var made = await sb.auth.signInAnonymously();
        if (made.error) {
          throw new Error('Could not sign in. Check that anonymous sign-ins are turned on in Supabase. (' +
            made.error.message + ')');
        }
      }
    } catch (e) {
      S.screen = 'setup';
      S.bootError = e.message;
      render();
      return;
    }

    var code = (new URLSearchParams(location.search).get('room') || '').toUpperCase().slice(0, 4);
    S.urlCode = /^[A-Z]{4}$/.test(code) ? code : null;
    S.screen = 'home';

    // Coming back to a room this device was already in: rejoin silently.
    var nick = store('sheep:nick');
    if (S.urlCode && nick && store('sheep:in') === S.urlCode) {
      try {
        await enterRoom(await rpc('join_room', { p_code: S.urlCode, p_nickname: nick }));
      } catch (e) {
        store('sheep:in', null);
      }
    }
    render();
    setInterval(tick, 250);
    setInterval(syncClock, 120000);
  }

  boot();
})();
