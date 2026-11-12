// Sheep: the browser side. It holds no game rules: it sends actions to the
// Supabase functions and draws whatever state the database reports.
(function () {
  'use strict';

  var CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  var CFG = window.SHEEP_CONFIG || {};
  var SECONDS = { LEADER_REVEAL: 5, ANSWERING: 30, REVEAL: 8 };

  var sb = null;
  var S = {
    screen: 'boot',          // boot | setup | home | room
    bootError: null,
    urlCode: null,           // room code from the invite link
    roomId: null, me: null,
    room: null, players: [], game: null, gps: [], rounds: [], answers: [],
    questions: {},           // question id -> question with its options
    pick: null,              // option chosen but not yet locked in
    busy: false
  };

  var el = {
    top: document.getElementById('top'),
    main: document.getElementById('main'),
    foot: document.getElementById('foot'),
    toast: document.getElementById('toast')
  };
  var lastHtml = { top: null, main: null, foot: null };
  var channel = null, pollTimer = null, tickTimer = null, toastTimer = null;
  var refreshing = false, refreshAgain = false, lastAdvance = 0;

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

  function currentRound() {
    if (!S.game) return null;
    return S.rounds.find(function (r) { return r.round_number === S.game.current_round; }) || null;
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
            (qs.data || []).forEach(function (q) { S.questions[q.id] = q; });
          }
        }
      }

      if (S.roomId !== roomId) return; // left the room while loading
      var roundBefore = S.game ? S.game.id + ':' + S.game.current_round + ':' + S.game.state : '';
      S.room = room; S.players = players; S.game = game;
      S.gps = gps; S.rounds = rounds; S.answers = answers;
      var roundAfter = game ? game.id + ':' + game.current_round + ':' + game.state : '';
      if (roundBefore !== roundAfter) S.pick = null;
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
    await refresh();
  }

  function goHome(keepCode) {
    unsubscribe();
    store('sheep:in', null);
    S.roomId = null; S.me = null; S.room = null; S.game = null;
    S.players = []; S.gps = []; S.rounds = []; S.answers = []; S.pick = null;
    if (!keepCode) {
      S.urlCode = null;
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* file:// */ }
    }
    S.screen = 'home';
    render();
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
      var link = location.origin + location.pathname + '?room=' + S.room.code;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(
          function () { toast('Invite link copied'); },
          function () { toast(link); });
      } else { toast(link); }
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
      el.main.querySelectorAll('.options button').forEach(function (b) {
        b.classList.toggle('picked', b === btn);
      });
      var lock = document.getElementById('lock');
      if (lock) { lock.disabled = false; lock.textContent = 'Lock in ' + btn.textContent; }
    },
    lock: function () {
      if (!S.pick || !S.game) return;
      var option = S.pick;
      act(async function () {
        await rpc('submit_answer', { p_game_id: S.game.id, p_option_id: option });
        await refresh();
      });
    }
  };

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    var fn = actions[btn.getAttribute('data-act')];
    if (fn) fn(btn);
  });

  document.addEventListener('input', function (e) {
    if (e.target.id !== 'search') return;
    var term = e.target.value.trim().toLowerCase();
    el.main.querySelectorAll('.options button').forEach(function (b) {
      b.hidden = term !== '' && b.getAttribute('data-find').indexOf(term) === -1;
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'nick' || e.target.id === 'code') {
      (S.urlCode || (document.getElementById('code') || {}).value) ? actions.join() : actions.create();
    }
  });

  // ---------- screens ----------

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
        '<h1 class="logo">Sheep</h1>' +
        '<ol class="rules">' +
        '<li>One player is the leader. Everyone answers the same question in secret.</li>' +
        '<li>Give the same answer as the leader and you are out.</li>' +
        '<li>Survive five rounds to win. The choices shrink every round.</li>' +
        '</ol>' +
        '<label class="field">Your name' +
        '<input type="text" id="nick" maxlength="16" autocomplete="nickname" value="' + esc(nick) + '"></label>' +
        joinPart,
      foot: ''
    };
  }

  function lobbyView() {
    var here = S.players.filter(function (p) { return p.is_connected; });
    var host = S.room.host_player_id;
    var list = here.map(function (p) {
      var tags = [];
      if (p.id === host) tags.push('host');
      if (p.id === S.me) tags.push('you');
      return '<li><span class="name">' + esc(p.nickname) + '</span>' +
        '<span class="tag">' + tags.join(', ') + '</span></li>';
    }).join('');
    var tiles = String(S.room.code).split('').map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('');
    var action;
    if (isHost()) {
      action = '<button class="primary" data-act="start"' + (here.length < 3 ? ' disabled' : '') + '>Start game</button>' +
        (here.length < 3
          ? '<p class="note center">You need at least 3 players. ' + here.length + ' so far.</p>'
          : '<p class="note center">' + here.length + ' players are in.</p>');
    } else {
      action = '<p class="banner info">Waiting for ' + esc(playerName(host)) + ' to start the game</p>';
    }
    return {
      top: '',
      main:
        '<p class="note center">Share this code to invite friends</p>' +
        '<div class="code" aria-label="Room code ' + esc(S.room.code) + '">' + tiles + '</div>' +
        '<button data-act="copy">Copy invite link</button>' +
        '<ul class="people">' + list + '</ul>' +
        action +
        '<button class="quiet" data-act="leave">Leave room</button>',
      foot: ''
    };
  }

  function topBar(label) {
    return '<div class="topbar"><span>' + esc(label) + '</span><span class="clock" id="clock"></span></div>' +
      '<div class="bar"><i id="bar"></i></div>';
  }

  function roundLabel() { return 'Round ' + S.game.current_round + ' of 5'; }

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
    return {
      top: topBar('Get ready'),
      main: watcherBanner() +
        '<div class="stage">' +
        '<p class="note">' + (mine ? 'This game' : 'The leader is') + '</p>' +
        '<p class="big">' + (mine ? 'You are the leader' : esc(playerName(leaderId()))) + '</p>' +
        '<p>' + (mine
          ? 'Answer like the flock. Anyone who matches you is out. Catch them all to win.'
          : 'Never give the same answer as the leader. Last five rounds to win.') + '</p>' +
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
    var body;

    if (!gp) {
      body = watcherBanner();
    } else if (gp.status === 'ELIMINATED') {
      body = '<p class="banner bad">You are out. Watch how the rest get on.</p>';
    } else if (mine || gp.last_answered_round >= S.game.current_round) {
      body = '<div class="stage"><p class="note">Locked in</p>' +
        '<p class="big">' + esc(mine ? optionLabel(q.id, mine.option_id) : '') + '</p>' +
        '<p>Waiting for the others</p></div>';
    } else {
      var search = q.input_type === 'SEARCH';
      var opts = q.question_options.map(function (o) {
        var find = (o.label + ' ' + (o.aliases || []).join(' ')).toLowerCase();
        return '<button data-act="pick" data-id="' + esc(o.id) + '" data-find="' + esc(find) + '">' +
          esc(o.label) + '</button>';
      }).join('');
      var cls = search ? 'options list' : (q.question_options.length <= 4 ? 'options wide' : 'options');
      body =
        '<p class="note">' + (amLeader
          ? 'You are the leader. Pick what the flock will pick.'
          : 'Do not match ' + esc(playerName(leaderId())) + '.') + '</p>' +
        (search ? '<input type="text" id="search" placeholder="Type to search" autocomplete="off" aria-label="Search answers">' : '') +
        '<div class="' + cls + '">' + opts + '</div>' +
        '<button class="primary" id="lock" data-act="lock" disabled>Choose an answer</button>';
    }

    return {
      top: topBar(roundLabel()),
      main: '<h1>' + esc(q.prompt) + '</h1>' + body,
      foot: chipsFoot()
    };
  }

  function revealView() {
    var round = currentRound();
    var q = round ? S.questions[round.question_id] : null;
    if (!round || !q) return { top: topBar(roundLabel()), main: '<p class="note">Loading</p>', foot: '' };

    var n = S.game.current_round;
    var gp = myGp();
    var banner = watcherBanner();
    if (gp && gp.role === 'FLOCK') {
      if (gp.eliminated_round === n) {
        banner = '<p class="banner bad">' + (gp.eliminated_reason === 'NO_ANSWER'
          ? 'You ran out of time. You are out.'
          : 'You matched the leader. You are out.') + '</p>';
      } else if (gp.status === 'ALIVE') {
        banner = '<p class="banner good">You are safe</p>';
      }
    }

    var rows = S.gps.filter(function (g) {
      return g.role === 'FLOCK' && (g.status === 'ALIVE' || g.eliminated_round === n);
    }).map(function (g) {
      var a = answerOf(round.id, g.player_id);
      var hit = g.eliminated_round === n;
      var said = a ? optionLabel(q.id, a.option_id) : 'No answer';
      return '<li class="' + (hit ? 'hit' : 'safe') + '"><span class="name">' + esc(playerName(g.player_id)) +
        '</span><span class="tag">' + esc(said) + (hit ? ', out' : '') + '</span></li>';
    }).join('');

    return {
      top: topBar(roundLabel()),
      main:
        '<p class="note center">' + esc(q.prompt) + '</p>' +
        '<div class="center"><p class="note">' + esc(playerName(leaderId())) + ' the leader said</p>' +
        '<p class="big">' + esc(optionLabel(q.id, round.leader_option_id)) + '</p></div>' +
        banner +
        '<ul class="people">' + rows + '</ul>',
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
      personal = '<p class="banner ' + (won ? 'good' : 'bad') + '">' + (won ? 'You won' : 'You lost') + '</p>';
    }

    var rows = flock.slice().sort(function (a, b) {
      return (b.eliminated_round || 9) - (a.eliminated_round || 9);
    }).map(function (g) {
      var alive = g.status === 'ALIVE';
      return '<li class="' + (alive ? 'safe' : 'out') + '"><span class="name">' + esc(playerName(g.player_id)) +
        '</span><span class="tag">' + (alive ? 'survived' : 'out in round ' + g.eliminated_round) + '</span></li>';
    }).join('');

    var history = S.rounds.filter(function (r) { return r.revealed_at; }).map(function (r) {
      var q = S.questions[r.question_id];
      return '<li><span class="name">' + esc(q ? q.prompt : 'Round ' + r.round_number) + '</span>' +
        '<span class="tag">' + esc(q ? optionLabel(q.id, r.leader_option_id) : '') + '</span></li>';
    }).join('');

    var action = isHost()
      ? '<button class="primary" data-act="again">Play again</button>'
      : '<p class="banner info">Waiting for ' + esc(playerName(S.room.host_player_id)) + ' to start another game</p>';

    return {
      top: '',
      main:
        '<div class="center"><p class="note">Game over</p>' +
        '<p class="big">' + (leaderWon
          ? esc(playerName(leaderId())) + ' wins'
          : 'The flock wins') + '</p>' +
        '<p>' + (leaderWon
          ? 'The leader caught every player.'
          : survivors.length + (survivors.length === 1 ? ' player' : ' players') + ' never matched the leader.') + '</p></div>' +
        personal +
        '<ul class="people">' + rows + '</ul>' +
        '<h2>What ' + esc(playerName(leaderId())) + ' the leader said</h2>' +
        '<ul class="people">' + history + '</ul>' +
        action +
        '<button class="quiet" data-act="leave">Leave room</button>',
      foot: ''
    };
  }

  function view() {
    if (S.screen === 'boot') return { top: '', main: '<p class="note">Loading</p>', foot: '' };
    if (S.screen === 'setup') {
      return {
        top: '',
        main: '<h1 class="logo">Sheep</h1><p class="banner bad">' + esc(S.bootError) + '</p>',
        foot: ''
      };
    }
    if (S.screen === 'home') return homeView();
    if (!S.room) return { top: '', main: '<p class="note">Joining the room</p>', foot: '' };
    if (S.room.status === 'CLOSED') {
      return { top: '', main: '<p class="banner info">This room has closed.</p>' +
        '<button class="primary" data-act="forget">Back to start</button>', foot: '' };
    }
    if (S.room.status === 'LOBBY' || !S.room.current_game_id) return lobbyView();
    if (!S.game) return { top: '', main: '<p class="note">Loading the game</p>', foot: '' };
    if (S.game.state === 'LEADER_REVEAL') return leaderRevealView();
    if (S.game.state === 'ANSWERING') return answeringView();
    if (S.game.state === 'REVEAL') return revealView();
    return gameOverView();
  }

  function render() {
    var v = view();
    setRegion('top', v.top);
    setRegion('main', v.main);
    setRegion('foot', v.foot);
    tick();
  }

  // ---------- countdown and moving the game on ----------

  function tick() {
    var g = S.screen === 'room' ? S.game : null;
    if (!g || !g.state_deadline || g.state === 'GAME_OVER') return;
    var left = new Date(g.state_deadline).getTime() - Date.now();
    var clock = document.getElementById('clock');
    var bar = document.getElementById('bar');
    if (clock) {
      var secs = Math.max(0, Math.ceil(left / 1000));
      clock.textContent = secs;
      clock.classList.toggle('low', secs <= 5 && g.state === 'ANSWERING');
    }
    if (bar) {
      var total = (SECONDS[g.state] || 10) * 1000;
      bar.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + '%';
    }
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
    tickTimer = setInterval(tick, 250);
  }

  boot();
})();
