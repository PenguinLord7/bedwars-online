/* lobby.js — username, player list, invites, match start. */
(function () {
  'use strict';

  var NAME_KEY = 'bedwars.username';
  var AVATARS = ['assets/lobby/avatar1.svg', 'assets/lobby/avatar2.svg', 'assets/lobby/avatar3.svg'];

  var els = {
    nameScreen: document.getElementById('name-screen'),
    lobbyScreen: document.getElementById('lobby-screen'),
    nameInput: document.getElementById('name-input'),
    nameBtn: document.getElementById('name-btn'),
    nameError: document.getElementById('name-error'),
    playerList: document.getElementById('player-list'),
    playerCount: document.getElementById('player-count'),
    emptyHint: document.getElementById('empty-hint'),
    selfAvatar: document.getElementById('self-avatar'),
    selfName: document.getElementById('self-name'),
    connStatus: document.getElementById('conn-status'),
    connText: document.getElementById('conn-text'),
    logoutBtn: document.getElementById('logout-btn'),
    modal: document.getElementById('modal'),
    modalAvatar: document.getElementById('modal-avatar'),
    modalText: document.getElementById('modal-text'),
    acceptBtn: document.getElementById('accept-btn'),
    declineBtn: document.getElementById('decline-btn'),
    toast: document.getElementById('toast'),
  };

  var lobby = null;
  var myName = '';
  var myId = '';
  var pendingInvite = null;
  var busy = false;
  var toastTimer = null;

  function avatarFor(seed) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return AVATARS[h % AVATARS.length];
  }

  function toast(text, ms) {
    els.toast.textContent = text;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, ms || 3000);
  }

  function setStatus(kind, text) {
    els.connStatus.className = 'status status-' + kind;
    els.connText.textContent = text;
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function renderPlayers(list) {
    els.playerCount.textContent = String(list.length);
    els.playerList.innerHTML = '';
    els.emptyHint.hidden = list.length > 0;

    list.forEach(function (p) {
      var li = document.createElement('li');
      li.title = 'Invite ' + p.name;

      var img = document.createElement('img');
      img.className = 'avatar';
      img.src = avatarFor(p.id);
      img.alt = '';

      var name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;

      var play = document.createElement('span');
      play.className = 'play';
      play.textContent = 'Invite \u25B6';

      li.appendChild(img);
      li.appendChild(name);
      li.appendChild(play);
      li.addEventListener('click', function () { sendInvite(p); });

      els.playerList.appendChild(li);
    });
  }

  function sendInvite(player) {
    if (!lobby || busy) return;
    busy = true;
    lobby.invite(player);
    toast('Invite sent to ' + player.name + '\u2026', 4000);
    setTimeout(function () { busy = false; }, 4000);
  }

  function showInvite(from) {
    if (pendingInvite) {
      lobby.respond(from, false);
      return;
    }
    pendingInvite = from;
    els.modalAvatar.src = avatarFor(from.id);
    els.modalText.textContent = from.name + ' wants to play Bedwars';
    els.modal.hidden = false;
  }

  function answerInvite(accepted) {
    if (!pendingInvite) return;
    var from = pendingInvite;
    pendingInvite = null;
    els.modal.hidden = true;
    lobby.respond(from, accepted);
    if (accepted) {
      toast('Starting match with ' + from.name + '\u2026', 6000);
    } else {
      toast('Declined ' + from.name, 2500);
    }
  }

  function enterMatch(info) {
    lobby.setInMatch(true);
    toast('Connected to ' + info.name + '. Loading game\u2026', 4000);
    var url = 'game.html?match=' + encodeURIComponent(info.matchId) +
              '&peer=' + encodeURIComponent(info.name);
    setTimeout(function () { window.location.href = url; }, 600);
  }

  function startLobby(name) {
    myName = name;
    myId = makeId();

    els.selfName.textContent = name;
    els.selfAvatar.src = avatarFor(myId);
    els.nameScreen.hidden = true;
    els.lobbyScreen.hidden = false;

    lobby = window.createLobby({
      id: myId,
      name: name,
      onPlayers: renderPlayers,
      onInvite: showInvite,
      onInviteResult: function (r) {
        if (r.accepted) {
          toast(r.name + ' accepted. Connecting\u2026', 5000);
        } else {
          toast(r.name + ' declined your invite.', 3000);
        }
      },
      onConnecting: function (peer) {
        setStatus('matched', 'connecting to ' + peer.name);
      },
      onPeer: enterMatch,
      onStatus: function (s) {
        if (s === 'online') setStatus('online', 'online');
        else if (s === 'connecting') setStatus('connecting', 'connecting\u2026');
        else if (s === 'offline') setStatus('offline', 'offline');
        else if (s === 'matched') setStatus('matched', 'matched');
        else if (s === 'peer-lost') {
          setStatus('offline', 'connection lost');
          toast('Peer connection lost.', 4000);
          busy = false;
        }
      },
    });
  }

  els.nameBtn.addEventListener('click', function () {
    var value = els.nameInput.value.trim().replace(/\s+/g, ' ');
    if (value.length < 2) {
      els.nameError.textContent = 'Username must be at least 2 characters.';
      els.nameError.hidden = false;
      return;
    }
    els.nameError.hidden = true;
    try { localStorage.setItem(NAME_KEY, value); } catch (e) {}
    startLobby(value.slice(0, 16));
  });

  els.nameInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') els.nameBtn.click();
  });

  els.acceptBtn.addEventListener('click', function () { answerInvite(true); });
  els.declineBtn.addEventListener('click', function () { answerInvite(false); });

  els.logoutBtn.addEventListener('click', function () {
    if (lobby) lobby.close();
    try { localStorage.removeItem(NAME_KEY); } catch (e) {}
    window.location.reload();
  });

  window.addEventListener('beforeunload', function () {
    if (lobby) lobby.close();
  });

  // Prefill saved username.
  try {
    var saved = localStorage.getItem(NAME_KEY);
    if (saved) els.nameInput.value = saved;
  } catch (e) {}
  els.nameInput.focus();
})();
