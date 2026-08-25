(() => {
  'use strict';

  // Group call is intentionally isolated from the existing 1-1 call state.
  // It reuses the existing Socket.IO signaling events and SimplePeer library.
  const GROUP_SIGNAL_MARKER = '__phucGroupCall';
  const MAX_WAIT_MS = 25000;

  const groupCallState = {
    active: false,
    isCaller: false,
    groupId: null,
    groupName: '',
    callId: null,
    isVideo: false,
    localStream: null,
    peers: new Map(), // userId -> { peer, name, avatar, timer, initiator }
    incoming: null,
    muted: false,
    cameraOff: false
  };

  function currentUser() {
    return typeof getCurrentUser === 'function' ? getCurrentUser() : (state?.currentUser || {});
  }

  function getGroup(groupId) {
    return (state?.groups || []).find(group => group.id === groupId) || null;
  }

  function getUser(userId) {
    const me = currentUser();
    if (me?.id === userId) return me;

    for (const user of state?.allUsers || []) {
      if (user.id === userId) return user;
    }

    for (const group of state?.groups || []) {
      for (const member of group.members || []) {
        if (member.id === userId) return member;
      }
    }

    return { id: userId, username: 'Người dùng', avatar: '' };
  }

  function makeId() {
    return `gcall_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function makeSignalPacket(meta, signal) {
    return {
      [GROUP_SIGNAL_MARKER]: true,
      callId: meta.callId,
      groupId: meta.groupId,
      groupName: meta.groupName,
      callerId: meta.callerId,
      senderId: currentUser()?.id || null,
      isVideo: !!meta.isVideo,
      signal
    };
  }

  function isGroupSignal(signal) {
    return !!(signal && typeof signal === 'object' && signal[GROUP_SIGNAL_MARKER]);
  }

  function ensureGroupUI() {
    let popup = document.getElementById('group-call-popup');
    let screen = document.getElementById('group-call-screen');

    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'group-call-popup';
      popup.innerHTML = `
        <div class="group-call-popup-card">
          <div class="group-call-avatar-stack">
            <img id="group-call-popup-avatar" alt="Ảnh nhóm">
          </div>
          <h2 class="group-call-popup-title" id="group-call-popup-title">Cuộc gọi nhóm</h2>
          <p class="group-call-popup-subtitle" id="group-call-popup-subtitle">Cuộc gọi đến...</p>
          <div class="group-call-popup-actions">
            <button type="button" class="group-call-round-btn reject" id="group-call-reject" title="Từ chối"><i class="fas fa-phone-slash"></i></button>
            <button type="button" class="group-call-round-btn accept" id="group-call-accept" title="Nhận cuộc gọi"><i class="fas fa-phone"></i></button>
          </div>
        </div>
      `;
      document.body.appendChild(popup);

      popup.querySelector('#group-call-reject')?.addEventListener('click', rejectIncomingGroupCall);
      popup.querySelector('#group-call-accept')?.addEventListener('click', answerIncomingGroupCall);
    }

    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'group-call-screen';
      screen.innerHTML = `
        <div class="group-call-topbar">
          <div class="group-call-topbar-main">
            <h2 class="group-call-title" id="group-call-title">Cuộc gọi nhóm</h2>
            <div class="group-call-status" id="group-call-status">Đang kết nối...</div>
          </div>
          <button type="button" class="group-call-end-top" id="group-call-end-top" title="Kết thúc"><i class="fas fa-phone-slash"></i></button>
        </div>
        <div id="group-call-grid"></div>
        <div class="group-call-controls">
          <button type="button" class="group-call-control" id="group-call-mic" title="Bật/tắt mic"><i class="fas fa-microphone"></i></button>
          <button type="button" class="group-call-control" id="group-call-cam" title="Bật/tắt camera"><i class="fas fa-video"></i></button>
          <button type="button" class="group-call-control end" id="group-call-end" title="Rời cuộc gọi"><i class="fas fa-phone-slash"></i></button>
        </div>
      `;
      document.body.appendChild(screen);

      screen.querySelector('#group-call-end-top')?.addEventListener('click', endGroupCall);
      screen.querySelector('#group-call-end')?.addEventListener('click', leaveGroupCall);
      screen.querySelector('#group-call-mic')?.addEventListener('click', toggleGroupAudio);
      screen.querySelector('#group-call-cam')?.addEventListener('click', toggleGroupVideo);
    }

    return { popup, screen };
  }

  function setGroupCallStatus(text) {
    const el = document.getElementById('group-call-status');
    if (el) el.textContent = text;
  }

  function updateGroupCallStatus() {
    const count = 1 + groupCallState.peers.size;
    const mode = groupCallState.isVideo ? 'Video' : 'Thoại';
    setGroupCallStatus(`${count} người đang kết nối • ${mode}`);
  }

  function showGroupCallScreen() {
    const { screen } = ensureGroupUI();
    document.getElementById('group-call-title').textContent = groupCallState.groupName || 'Cuộc gọi nhóm';
    screen.classList.add('show');
    document.getElementById('group-call-popup')?.classList.remove('show');
    document.getElementById('group-call-popup').style.display = 'none';
    updateGroupCallStatus();
  }

  function hideGroupCallScreen() {
    const screen = document.getElementById('group-call-screen');
    if (screen) screen.classList.remove('show');
  }

  function showIncomingGroupCall(meta, data) {
    const { popup } = ensureGroupUI();
    const caller = getUser(meta.callerId || data.fromUserId);
    const avatar = meta.callerAvatar || caller.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=group-call';
    const groupName = meta.groupName || 'Cuộc gọi nhóm';

    groupCallState.incoming = { meta, data };

    const avatarEl = document.getElementById('group-call-popup-avatar');
    const titleEl = document.getElementById('group-call-popup-title');
    const subtitleEl = document.getElementById('group-call-popup-subtitle');

    if (avatarEl) avatarEl.src = avatar;
    if (titleEl) titleEl.textContent = groupName;
    if (subtitleEl) {
      subtitleEl.textContent = `${meta.callerName || caller.username || 'Ai đó'} đang gọi ${meta.isVideo ? 'video' : 'thoại'} nhóm...`;
    }

    // Existing 1-1 popup is also triggered by app.js. Hide it immediately.
    const oneToOnePopup = document.getElementById('incoming-call-popup');
    if (oneToOnePopup) {
      oneToOnePopup.style.display = 'none';
      oneToOnePopup.classList.add('hidden');
    }

    popup.classList.add('show');
    popup.style.display = 'flex';
  }

  function hideIncomingGroupCall() {
    const popup = document.getElementById('group-call-popup');
    if (popup) {
      popup.classList.remove('show');
      popup.style.display = 'none';
    }
  }

  async function getLocalStream(isVideo) {
    if (groupCallState.localStream) return groupCallState.localStream;

    groupCallState.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo ? { width: 1280, height: 720 } : false
    });

    addLocalTile();
    return groupCallState.localStream;
  }

  function addLocalTile() {
    const grid = document.getElementById('group-call-grid');
    if (!grid || !groupCallState.localStream) return;

    let tile = document.getElementById('group-call-tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.id = 'group-call-tile-local';
      tile.className = `group-call-tile local${groupCallState.isVideo ? '' : ' voice'}`;
      tile.innerHTML = `
        <video id="group-call-local-video" autoplay muted playsinline></video>
        <div class="group-call-tile-label">${currentUser()?.username || 'Bạn'} (Bạn)</div>
      `;
      grid.appendChild(tile);
    }

    const video = tile.querySelector('video');
    video.srcObject = groupCallState.localStream;
    video.style.opacity = groupCallState.isVideo ? '1' : '.001';
  }

  function removeTile(userId) {
    document.getElementById(`group-call-tile-${CSS.escape(userId)}`)?.remove();
  }

  function addRemoteTile(userId, stream, userInfo) {
    const grid = document.getElementById('group-call-grid');
    if (!grid) return;

    const safeId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    let tile = document.getElementById(`group-call-tile-${safeId}`);

    if (!tile) {
      tile = document.createElement('div');
      tile.id = `group-call-tile-${safeId}`;
      tile.className = `group-call-tile${groupCallState.isVideo ? '' : ' voice'}`;
      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="group-call-tile-placeholder">
          <img src="${userInfo?.avatar || 'https://api.dicebear.com/7.x/avataaars/svg?seed=remote'}" alt="">
          <span>${userInfo?.username || 'Người dùng'}</span>
        </div>
        <div class="group-call-tile-label">${userInfo?.username || 'Người dùng'}</div>
      `;
      grid.appendChild(tile);
    }

    const video = tile.querySelector('video');
    const placeholder = tile.querySelector('.group-call-tile-placeholder');
    video.srcObject = stream;
    video.style.opacity = groupCallState.isVideo ? '1' : '.001';
    if (placeholder) placeholder.style.display = groupCallState.isVideo ? 'none' : 'flex';
  }

  function createPeer(remoteUserId, initiator, meta, initialOffer) {
    if (!window.SimplePeer) {
      showToast?.('Không tìm thấy SimplePeer. Vui lòng tải lại trang.', false);
      return null;
    }

    if (groupCallState.peers.has(remoteUserId)) {
      const existing = groupCallState.peers.get(remoteUserId);
      if (existing?.peer) return existing.peer;
    }

    const remote = getUser(remoteUserId);
    const peer = new SimplePeer({
      initiator,
      trickle: false,
      stream: groupCallState.localStream,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    const entry = {
      peer,
      name: remote.username || 'Người dùng',
      avatar: remote.avatar || '',
      initiator,
      timer: null
    };

    groupCallState.peers.set(remoteUserId, entry);
    updateGroupCallStatus();

    entry.timer = setTimeout(() => {
      const current = groupCallState.peers.get(remoteUserId);
      if (current && current.peer === peer) {
        removeGroupPeer(remoteUserId, false);
      }
    }, MAX_WAIT_MS);

    peer.on('signal', signalData => {
      if (!groupCallState.active || !groupCallState.callId) return;

      const packet = makeSignalPacket({
        callId: groupCallState.callId,
        groupId: groupCallState.groupId,
        groupName: groupCallState.groupName,
        callerId: groupCallState.isCaller ? currentUser()?.id : (meta?.callerId || meta?.fromUserId),
        isVideo: groupCallState.isVideo,
        callerName: groupCallState.isCaller ? currentUser()?.username : (meta?.callerName || 'Ai đó'),
        callerAvatar: groupCallState.isCaller ? currentUser()?.avatar : (meta?.callerAvatar || '')
      }, signalData);

      if (initiator) {
        socket.emit('call_user', {
          userToCall: remoteUserId,
          signalData: packet,
          callerName: packet.callerName || currentUser()?.username || 'Người dùng',
          callerAvatar: packet.callerAvatar || currentUser()?.avatar || '',
          isVideo: groupCallState.isVideo
        });
      } else if (meta?.fromSocketId) {
        socket.emit('answer_call', {
          toSocketId: meta.fromSocketId,
          signal: {
            ...packet,
            senderId: currentUser()?.id || null,
            callerId: meta.callerId || meta.fromUserId || null
          }
        });
      }
    });

    peer.on('stream', remoteStream => {
      clearTimeout(entry.timer);
      addRemoteTile(remoteUserId, remoteStream, remote);
      updateGroupCallStatus();
    });

    peer.on('connect', () => {
      clearTimeout(entry.timer);
      updateGroupCallStatus();
    });

    peer.on('close', () => {
      removeGroupPeer(remoteUserId, false, peer);
    });

    peer.on('error', error => {
      console.error('[GROUP CALL] Peer error:', remoteUserId, error);
      removeGroupPeer(remoteUserId, false, peer);
    });

    if (!initiator && initialOffer) {
      try {
        peer.signal(initialOffer);
      } catch (error) {
        console.error('[GROUP CALL] Initial signal error:', error);
      }
    }

    return peer;
  }

  function removeGroupPeer(userId, destroy = true, expectedPeer = null) {
    const entry = groupCallState.peers.get(userId);
    if (!entry) return;
    if (expectedPeer && entry.peer !== expectedPeer) return;

    clearTimeout(entry.timer);

    if (destroy && entry.peer) {
      try { entry.peer.destroy(); } catch (error) { console.error(error); }
    }

    groupCallState.peers.delete(userId);
    removeTile(userId);
    updateGroupCallStatus();
  }

  async function startGroupCall(isVideo) {
    const groupId = state?.activeRoomId;
    const group = getGroup(groupId);
    const me = currentUser();

    if (!group || !me?.id) {
      showToast?.('Không thể xác định nhóm để gọi.', false);
      return;
    }

    if (groupCallState.active) {
      showToast?.('Bạn đang ở trong một cuộc gọi nhóm.', false);
      return;
    }

    try {
      groupCallState.active = true;
      groupCallState.isCaller = true;
      groupCallState.groupId = groupId;
      groupCallState.groupName = group.name;
      groupCallState.callId = makeId();
      groupCallState.isVideo = !!isVideo;
      groupCallState.peers.clear();
      groupCallState.incoming = null;
      groupCallState.muted = false;
      groupCallState.cameraOff = false;

      ensureGroupUI();
      document.getElementById('group-call-grid').innerHTML = '';
      await getLocalStream(groupCallState.isVideo);
      showGroupCallScreen();

      const members = Array.isArray(group.members) ? group.members : [];
      const targets = members.filter(member => member.id !== me.id);

      let invited = 0;
      for (const member of targets) {
        const user = getUser(member.id);
        if (user.status && user.status !== 'online') continue;

        const peer = createPeer(member.id, true, {
          callerId: me.id,
          callerName: me.username,
          callerAvatar: me.avatar
        });

        if (peer) invited++;
      }

      if (targets.length === 0) {
        showToast?.('Nhóm chưa có thành viên khác để gọi.', false);
      } else if (invited === 0) {
        showToast?.('Không có thành viên nào đang online.', false);
      }

      updateGroupCallStatus();
    } catch (error) {
      console.error('[GROUP CALL] Start error:', error);
      showToast?.('Không thể truy cập Microphone hoặc Camera!', false);
      cleanupGroupCall(false);
    }
  }

  async function answerIncomingGroupCall() {
    const incoming = groupCallState.incoming;
    if (!incoming) return;

    const { meta, data } = incoming;
    const group = getGroup(meta.groupId);

    if (!group || !currentUser()?.id) {
      hideIncomingGroupCall();
      groupCallState.incoming = null;
      return;
    }

    try {
      groupCallState.active = true;
      groupCallState.isCaller = false;
      groupCallState.groupId = meta.groupId;
      groupCallState.groupName = meta.groupName || group.name;
      groupCallState.callId = meta.callId;
      groupCallState.isVideo = !!meta.isVideo;
      groupCallState.peers.clear();
      groupCallState.muted = false;
      groupCallState.cameraOff = false;

      hideIncomingGroupCall();
      ensureGroupUI();
      document.getElementById('group-call-grid').innerHTML = '';
      await getLocalStream(groupCallState.isVideo);
      showGroupCallScreen();

      const offerPacket = data.signal;
      const initialOffer = offerPacket?.signal;
      createPeer(meta.callerId || data.fromUserId, false, {
        callId: meta.callId,
        groupId: meta.groupId,
        groupName: meta.groupName,
        callerId: meta.callerId || data.fromUserId,
        callerName: meta.callerName || data.callerName,
        callerAvatar: meta.callerAvatar || data.callerAvatar,
        fromSocketId: data.fromSocketId
      }, initialOffer);

      groupCallState.incoming = null;
    } catch (error) {
      console.error('[GROUP CALL] Answer error:', error);
      hideIncomingGroupCall();
      groupCallState.incoming = null;
      cleanupGroupCall(false);
      showToast?.('Không thể tham gia cuộc gọi nhóm.', false);
    }
  }

  function rejectIncomingGroupCall() {
    hideIncomingGroupCall();
    groupCallState.incoming = null;

    // Caller has a timeout for unanswered peers, so no extra signaling is needed.
    showToast?.('Đã từ chối cuộc gọi nhóm.');
  }

  function endGroupCall() {
    if (!groupCallState.active) return;

    // The caller is the only participant who can terminate everyone at once.
    if (groupCallState.isCaller) {
      for (const [userId] of groupCallState.peers) {
        socket.emit('end_call', { targetId: userId });
      }
    }

    cleanupGroupCall(true);
  }

  function leaveGroupCall() {
    if (!groupCallState.active) return;
    cleanupGroupCall(true);
  }

  function cleanupGroupCall(showMessage) {
    for (const [userId, entry] of groupCallState.peers) {
      clearTimeout(entry.timer);
      try { entry.peer?.destroy(); } catch (error) { console.error(error); }
      removeTile(userId);
    }

    groupCallState.peers.clear();

    if (groupCallState.localStream) {
      groupCallState.localStream.getTracks().forEach(track => {
        try { track.stop(); } catch (error) { console.error(error); }
      });
    }

    groupCallState.localStream = null;
    groupCallState.active = false;
    groupCallState.isCaller = false;
    groupCallState.groupId = null;
    groupCallState.groupName = '';
    groupCallState.callId = null;
    groupCallState.isVideo = false;
    groupCallState.incoming = null;
    groupCallState.muted = false;
    groupCallState.cameraOff = false;

    hideIncomingGroupCall();
    hideGroupCallScreen();

    const grid = document.getElementById('group-call-grid');
    if (grid) grid.innerHTML = '';

    if (showMessage) showToast?.('Đã rời cuộc gọi nhóm.');
  }

  function toggleGroupAudio() {
    if (!groupCallState.localStream) return;
    const track = groupCallState.localStream.getAudioTracks()[0];
    if (!track) return;

    groupCallState.muted = !groupCallState.muted;
    track.enabled = !groupCallState.muted;

    const btn = document.getElementById('group-call-mic');
    if (btn) btn.classList.toggle('active-off', groupCallState.muted);
    if (btn) btn.innerHTML = `<i class="fas ${groupCallState.muted ? 'fa-microphone-slash' : 'fa-microphone'}"></i>`;
  }

  function toggleGroupVideo() {
    if (!groupCallState.localStream || !groupCallState.isVideo) {
      showToast?.('Cuộc gọi thoại không có camera.', false);
      return;
    }

    const track = groupCallState.localStream.getVideoTracks()[0];
    if (!track) return;

    groupCallState.cameraOff = !groupCallState.cameraOff;
    track.enabled = !groupCallState.cameraOff;

    const btn = document.getElementById('group-call-cam');
    if (btn) btn.classList.toggle('active-off', groupCallState.cameraOff);
    if (btn) btn.innerHTML = `<i class="fas ${groupCallState.cameraOff ? 'fa-video-slash' : 'fa-video'}"></i>`;

    const video = document.getElementById('group-call-local-video');
    if (video) video.style.opacity = groupCallState.cameraOff ? '.001' : '1';
  }

  // Capture phase prevents the normal 1-1 initiateCall handler from firing for groups.
  document.addEventListener('click', event => {
    const button = event.target.closest('#btn-voice-call, #btn-video-call');
    if (!button) return;
    if (!state?.activeRoomId?.startsWith('grp_')) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    startGroupCall(button.id === 'btn-video-call');
  }, true);

  // Existing incoming_call event is reused as the transport for group invitations.
  socket.on('incoming_call', data => {
    const packet = data?.signal;
    if (!isGroupSignal(packet)) return;

    const meta = {
      callId: packet.callId,
      groupId: packet.groupId,
      groupName: packet.groupName || 'Cuộc gọi nhóm',
      callerId: packet.callerId || data.fromUserId,
      callerName: packet.callerName || data.callerName,
      callerAvatar: packet.callerAvatar || data.callerAvatar,
      isVideo: !!packet.isVideo,
      fromSocketId: data.fromSocketId
    };

    if (groupCallState.active) return;
    if (groupCallState.incoming?.meta?.callId === meta.callId) return;

    showIncomingGroupCall(meta, data);
  });

  // Existing call_accepted is reused, but group packets carry senderId to route the signal.
  socket.on('call_accepted', packet => {
    if (!isGroupSignal(packet) || !groupCallState.active) return;
    if (packet.callId !== groupCallState.callId) return;

    const remoteUserId = packet.senderId;
    if (!remoteUserId) return;

    const entry = groupCallState.peers.get(remoteUserId);
    if (!entry?.peer) return;

    try {
      entry.peer.signal(packet.signal);
      clearTimeout(entry.timer);
    } catch (error) {
      console.error('[GROUP CALL] Answer routing error:', error);
    }
  });

  // When the caller ends the whole call, each target receives the normal call_ended event.
  socket.on('call_ended', () => {
    if (!groupCallState.active) return;
    if (groupCallState.isCaller) return;
    cleanupGroupCall(false);
    showToast?.('Cuộc gọi nhóm đã kết thúc.');
  });

  // If the page becomes hidden due to navigation, keep the call alive. No automatic cleanup.
  window.startGroupCall = startGroupCall;
  window.answerIncomingGroupCall = answerIncomingGroupCall;
  window.rejectIncomingGroupCall = rejectIncomingGroupCall;
  window.endGroupCall = endGroupCall;
  window.leaveGroupCall = leaveGroupCall;
  window.toggleGroupAudio = toggleGroupAudio;
  window.toggleGroupVideo = toggleGroupVideo;

  ensureGroupUI();
})();
