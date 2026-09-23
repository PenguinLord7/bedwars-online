/*
 * net.js — P2P lobby networking for Bedwars.
 *
 * Presence, invites, and WebRTC signaling travel over a public MQTT broker.
 * Once an invite is accepted, the two players connect directly over a WebRTC
 * data channel (peer-to-peer). No gameplay sync yet: on connect, both players
 * just launch the game.
 */
(function (global) {
  'use strict';

  var BROKER = 'wss://broker.emqx.io:8084/mqtt';
  var NS = 'bedwars/v1';
  var HEARTBEAT_MS = 5000;
  var STALE_MS = 15000;
  var ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  function createLobby(opts) {
    var id = opts.id;
    var name = opts.name;
    var onPlayers = opts.onPlayers || function () {};
    var onInvite = opts.onInvite || function () {};
    var onInviteResult = opts.onInviteResult || function () {};
    var onConnecting = opts.onConnecting || function () {};
    var onPeer = opts.onPeer || function () {};
    var onStatus = opts.onStatus || function () {};

    var client = null;
    var players = new Map();
    var pc = null;
    var dc = null;
    var peerId = null;
    var peerName = null;
    var matchId = null;
    var inMatch = false;
    var heartbeat = null;
    var prune = null;

    function publish(topic, payload, retain) {
      if (!client) return;
      client.publish(topic, JSON.stringify(payload), { qos: 0, retain: !!retain });
    }

    function emitPlayers() {
      var list = [];
      players.forEach(function (p) {
        if (p.id !== id) list.push(p);
      });
      list.sort(function (a, b) {
        return String(a.name).localeCompare(String(b.name));
      });
      onPlayers(list);
    }

    function announce() {
      publish(NS + '/lobby/' + id, {
        id: id, name: name, ts: Date.now(), inMatch: inMatch,
      }, true);
    }

    function connect() {
      onStatus('connecting');
      client = mqtt.connect(BROKER, {
        clientId: 'bedwars_' + id,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 12000,
        will: {
          topic: NS + '/lobby/' + id,
          payload: JSON.stringify({ id: id, name: name, ts: 0, gone: true }),
          qos: 0,
          retain: true,
        },
      });

      client.on('connect', function () {
        onStatus('online');
        client.subscribe([NS + '/lobby/+', NS + '/invite/' + id, NS + '/rtc/' + id]);
        announce();
        clearInterval(heartbeat);
        heartbeat = setInterval(announce, HEARTBEAT_MS);
      });

      client.on('reconnect', function () { onStatus('connecting'); });
      client.on('close', function () { onStatus('offline'); });
      client.on('error', function (e) {
        console.warn('[lobby] mqtt error', e);
        onStatus('offline');
      });

      client.on('message', handleMessage);

      clearInterval(prune);
      prune = setInterval(function () {
        var now = Date.now();
        var changed = false;
        players.forEach(function (p, pid) {
          if (now - p.ts > STALE_MS) {
            players.delete(pid);
            changed = true;
          }
        });
        if (changed) emitPlayers();
      }, 3000);
    }

    function handleMessage(topic, buf) {
      var msg;
      try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

      if (topic.indexOf(NS + '/lobby/') === 0) {
        var pid = topic.slice((NS + '/lobby/').length);
        if (!pid || pid === id) return;
        if (msg.gone || !msg.ts || msg.inMatch) {
          if (players.delete(pid)) emitPlayers();
        } else {
          players.set(pid, {
            id: pid,
            name: msg.name || 'player',
            ts: msg.ts || Date.now(),
          });
          emitPlayers();
        }
        return;
      }

      if (topic === NS + '/invite/' + id) {
        if (msg.type === 'invite') {
          onInvite({ id: msg.from, name: msg.fromName || 'player' });
        } else if (msg.type === 'decline') {
          onInviteResult({ accepted: false, id: msg.from, name: msg.fromName || 'player' });
        } else if (msg.type === 'accept') {
          onInviteResult({ accepted: true, id: msg.from, name: msg.fromName || 'player' });
          startPeer(msg.from, msg.fromName, true);
        }
        return;
      }

      if (topic === NS + '/rtc/' + id) {
        handleSignal(msg);
      }
    }

    function invite(target) {
      publish(NS + '/invite/' + target.id, {
        type: 'invite', from: id, fromName: name,
      });
    }

    function respond(peer, accepted) {
      publish(NS + '/invite/' + peer.id, {
        type: accepted ? 'accept' : 'decline',
        from: id,
        fromName: name,
      });
      if (accepted) startPeer(peer.id, peer.name, false);
    }

    function startPeer(otherId, otherName, initiator) {
      if (pc) return;
      peerId = otherId;
      peerName = otherName || 'player';
      matchId = 'm_' + [id, otherId].sort().join('_').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40);
      onConnecting({ id: peerId, name: peerName });

      pc = new RTCPeerConnection({ iceServers: ICE });

      pc.onicecandidate = function (e) {
        if (e.candidate) {
          publish(NS + '/rtc/' + peerId, { type: 'ice', from: id, candidate: e.candidate });
        }
      };
      pc.onconnectionstatechange = function () {
        var s = pc && pc.connectionState;
        if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          onStatus('peer-lost');
        }
      };

      if (initiator) {
        bindChannel(pc.createDataChannel('game'));
        pc.createOffer()
          .then(function (offer) { return pc.setLocalDescription(offer); })
          .then(function () {
            publish(NS + '/rtc/' + peerId, { type: 'offer', from: id, sdp: pc.localDescription });
          })
          .catch(function (e) { console.warn('[lobby] offer failed', e); onStatus('peer-lost'); });
      } else {
        pc.ondatachannel = function (e) { bindChannel(e.channel); };
      }
    }

    function bindChannel(channel) {
      dc = channel;
      dc.onopen = function () {
        try { dc.send(JSON.stringify({ type: 'hello', from: id, name: name })); } catch (e) {}
        onStatus('matched');
        onPeer({ id: peerId, name: peerName, matchId: matchId, channel: dc });
      };
      dc.onmessage = function () {};
      dc.onclose = function () { onStatus('peer-lost'); };
    }

    function handleSignal(msg) {
      if (!pc) {
        if (msg.type === 'offer') startPeer(msg.from, msg.fromName, false);
        else return;
      }
      if (msg.type === 'offer') {
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(function () { return pc.createAnswer(); })
          .then(function (answer) { return pc.setLocalDescription(answer); })
          .then(function () {
            publish(NS + '/rtc/' + msg.from, { type: 'answer', from: id, sdp: pc.localDescription });
          })
          .catch(function (e) { console.warn('[lobby] answer failed', e); });
      } else if (msg.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
            .catch(function (e) { console.warn('[lobby] setRemote(answer) failed', e); });
        }
      } else if (msg.type === 'ice' && msg.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(function () {});
      }
    }

    function setInMatch(value) {
      inMatch = value;
      publish(NS + '/lobby/' + id, {
        id: id, name: name, ts: value ? 0 : Date.now(), gone: value, inMatch: value,
      }, true);
    }

    function close() {
      clearInterval(heartbeat);
      clearInterval(prune);
      if (dc) { try { dc.close(); } catch (e) {} }
      if (pc) { try { pc.close(); } catch (e) {} }
      if (client) {
        publish(NS + '/lobby/' + id, { id: id, name: name, ts: 0, gone: true }, true);
        setTimeout(function () { try { client.end(true); } catch (e) {} }, 100);
      }
    }

    connect();
    return {
      invite: invite,
      respond: respond,
      setInMatch: setInMatch,
      close: close,
      matchId: function () { return matchId; },
      peerName: function () { return peerName; },
    };
  }

  global.createLobby = createLobby;
})(window);
