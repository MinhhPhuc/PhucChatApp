const socket = io();

let state = {
  currentUser: null,
  activeRoomId: null,
  theme: localStorage.getItem('chat_theme') || 'dark',
  roomThemes: new Map(JSON.parse(localStorage.getItem('chat_room_themes') || '[]')),
  roomReactions: new Map(JSON.parse(localStorage.getItem('chat_room_reactions') || '[]')),
  friends: [],
  requests: [],
  allUsers: [],
  groups: [],
  lastMessages: new Map(),
  unreadCounts: new Map(),
  searchQuery: '',
  activeFilter: 'all',
  nicknames: new Map(JSON.parse(localStorage.getItem('chat_nicknames') || '[]')),
  selectedRegAvatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=default',
  selectedGroupAvatar: 'https://api.dicebear.com/7.x/identicon/svg?seed=group'
};

function showToast(message, isSuccess = true) {
  const toast = document.getElementById('toast-notification');
  if (!toast) return;
  toast.innerText = message;
  toast.style.background = isSuccess ? '#38a169' : '#e53e3e';
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// --- MODAL XÁC NHẬN ---
let confirmCallback = null;
function showConfirmModal(title, message, onYes) {
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  if (!modal) {
    if (confirm(message)) onYes();
    return;
  }
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;
  confirmCallback = onYes;
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

// --- QUẢN LÝ THEME CHUNG ---
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('chat_theme', theme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  }
}

const btnToggleTheme = document.getElementById('btn-toggle-theme');
if (btnToggleTheme) {
  btnToggleTheme.onclick = () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  };
}
applyTheme(state.theme);

// --- QUẢN LÝ CHỦ ĐỀ PHÒNG CHAT ---
function applyRoomTheme(roomId) {
  const chatViewport = document.getElementById('messages-viewport') || document.querySelector('.chat-messages') || document.querySelector('.messages-container');
  const chatScreen = document.getElementById('chat-screen') || document.querySelector('.chat-area');
  
  if (!chatViewport && !chatScreen) return;
  
  const themes = ['theme-love', 'theme-coffee', 'theme-monochrome', 'theme-nature'];
  
  if (chatViewport) chatViewport.classList.remove(...themes);
  if (chatScreen) chatScreen.classList.remove(...themes);
  
  const currentTheme = state.roomThemes.get(roomId) || 'default';
  if (currentTheme !== 'default') {
    if (chatViewport) chatViewport.classList.add(`theme-${currentTheme}`);
    if (chatScreen) chatScreen.classList.add(`theme-${currentTheme}`);
  }
}

// --- EMOJI NHANH ---
function updateQuickReactionUI(roomId) {
  const trigger = document.getElementById('quick-reaction-trigger');
  if (!trigger) return;
  const roomEmoji = state.roomReactions?.get(roomId) || '❤️';
  trigger.innerText = roomEmoji;
}

// --- TAB ĐĂNG NHẬP / ĐĂNG KÝ ---
const tabLogin = document.getElementById('tab-btn-login');
const tabRegister = document.getElementById('tab-btn-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');

if (tabLogin && tabRegister && formLogin && formRegister) {
  tabLogin.onclick = (e) => {
    e.preventDefault();
    tabLogin.classList.add('active'); tabRegister.classList.remove('active');
    formLogin.classList.remove('hidden'); formRegister.classList.add('hidden');
  };
  tabRegister.onclick = (e) => {
    e.preventDefault();
    tabRegister.classList.add('active'); tabLogin.classList.remove('active');
    formRegister.classList.remove('hidden'); formLogin.classList.add('hidden');
  };
}

// --- CHỌN AVATAR ---
const regAvatarFile = document.getElementById('reg-avatar-file');
const regPreviewAvatar = document.getElementById('reg-preview-avatar');
const regRandomAvatar = document.getElementById('reg-random-avatar');

if (regAvatarFile && regPreviewAvatar) {
  regAvatarFile.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (uploadEvent) => {
        state.selectedRegAvatar = uploadEvent.target.result;
        regPreviewAvatar.src = state.selectedRegAvatar;
      };
      reader.readAsDataURL(file);
    }
  };
}
if (regRandomAvatar && regPreviewAvatar) {
  regRandomAvatar.onclick = () => {
    const seed = Math.random().toString(36).substring(2, 9);
    state.selectedRegAvatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}`;
    regPreviewAvatar.src = state.selectedRegAvatar;
  };
}

const groupAvatarFile = document.getElementById('group-avatar-file');
const groupPreviewAvatar = document.getElementById('group-preview-avatar');
if (groupAvatarFile && groupPreviewAvatar) {
  groupAvatarFile.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.selectedGroupAvatar = ev.target.result;
        groupPreviewAvatar.src = state.selectedGroupAvatar;
      };
      reader.readAsDataURL(file);
    }
  };
}

// --- XỬ LÝ AUTHENTICATION ---
if (formLogin) {
  formLogin.onsubmit = (e) => {
    e.preventDefault();
    socket.emit('auth:login', {
      username: document.getElementById('login-username').value,
      password: document.getElementById('login-password').value
    });
  };
}

if (formRegister) {
  formRegister.onsubmit = (e) => {
    e.preventDefault();
    socket.emit('auth:register', {
      username: document.getElementById('reg-username').value,
      password: document.getElementById('reg-password').value,
      avatar: state.selectedRegAvatar
    });
  };
}

socket.on('auth:error', (msg) => showToast(msg, false));
socket.on('auth:register_success', (msg) => {
  showToast(msg, true);
  if (tabLogin) tabLogin.click();
});

socket.on('auth:success', ({ token, user }) => {
  state.currentUser = user;
  localStorage.setItem('chat_session_token', token);
  const modalAuth = document.getElementById('modal-auth');
  if (modalAuth) modalAuth.classList.add('hidden');
  const myAvatar = document.getElementById('my-avatar');
  const myName = document.getElementById('my-name');
  if (myAvatar) myAvatar.src = user.avatar;
  if (myName) myName.innerText = user.username;
});

const savedToken = localStorage.getItem('chat_session_token');
if (savedToken) {
  socket.emit('auth:session', { userId: savedToken });
} else {
  const modalAuth = document.getElementById('modal-auth');
  if (modalAuth) modalAuth.classList.remove('hidden');
}

const btnLogout = document.getElementById('btn-logout');
if (btnLogout) {
  btnLogout.onclick = () => {
    localStorage.removeItem('chat_session_token');
    location.reload();
  };
}

// --- TÌM KIẾM ---
const searchInput = document.getElementById('search-input');
const btnClearSearch = document.getElementById('btn-clear-search');

if (searchInput && btnClearSearch) {
  searchInput.oninput = (e) => {
    state.searchQuery = e.target.value.trim().toLowerCase();
    btnClearSearch.classList.toggle('hidden', state.searchQuery.length === 0);
    renderChatList();
  };
  btnClearSearch.onclick = () => {
    searchInput.value = '';
    state.searchQuery = '';
    btnClearSearch.classList.add('hidden');
    renderChatList();
  };
}

// --- GỬI TIN NHẮN VÀ EMOJI ---
const btnEmoji = document.getElementById('btn-emoji-toggle');
const emojiPicker = document.getElementById('emoji-picker');
const msgInput = document.getElementById('msg-input');

if (btnEmoji && emojiPicker) {
  btnEmoji.onclick = (e) => { e.stopPropagation(); emojiPicker.classList.toggle('hidden'); };
}
document.querySelectorAll('.emoji-list span').forEach(el => {
  el.onclick = () => { if (msgInput) { msgInput.value += el.innerText; msgInput.focus(); } };
});
document.onclick = (e) => {
  if (emojiPicker && !emojiPicker.contains(e.target) && e.target !== btnEmoji) {
    emojiPicker.classList.add('hidden');
  }
};

document.getElementById('quick-reaction-trigger')?.addEventListener('click', () => {
  if (state.activeRoomId) {
    const quickEmoji = document.getElementById('quick-reaction-trigger')?.innerText || '❤️';
    socket.emit('message:send', { roomId: state.activeRoomId, content: quickEmoji, type: 'text' });
  }
});

const imageUploadInput = document.getElementById('image-upload-input');
if (imageUploadInput) {
  imageUploadInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file && state.activeRoomId) {
      const reader = new FileReader();
      reader.onload = (uploadEvent) => {
        socket.emit('message:send', { roomId: state.activeRoomId, content: uploadEvent.target.result, type: 'image' });
        imageUploadInput.value = '';
      };
      reader.readAsDataURL(file);
    }
  };
}

// --- SYNC DỮ LIỆU TỪ SERVER ---
socket.on('data:sync', (data) => {
  state.friends = data.friends;
  state.requests = data.requests;
  state.allUsers = data.allUsers;
  state.groups = data.groups || [];

  if (state.activeRoomId && state.activeRoomId.startsWith('grp_')) {
    const currentGroup = state.groups.find(g => g.id === state.activeRoomId);
    if (currentGroup) {
      const count = currentGroup.members ? currentGroup.members.length : (currentGroup.membersCount || 0);
      const statusEl = document.getElementById('active-chat-status');
      if (statusEl) statusEl.innerText = `${count} thành viên`;
    }
  }

  if (state.currentUser) {
    state.friends.forEach(f => {
      const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
      socket.emit('messages:get', { roomId: dmRoomId });
    });
    state.groups.forEach(g => {
      socket.emit('messages:get', { roomId: g.id });
    });
  }
  renderChatList();
  
  const modalGroupSettings = document.getElementById('modal-group-settings');
  if (modalGroupSettings && (modalGroupSettings.style.display === 'flex' || !modalGroupSettings.classList.contains('hidden'))) {
    renderGroupSettingsModal();
  }
});

socket.on('friend:incoming', () => { if(state.currentUser) socket.emit('auth:session', { userId: state.currentUser.id }); });
socket.on('friend:updated', () => { if(state.currentUser) socket.emit('auth:session', { userId: state.currentUser.id }); });
socket.on('group:updated', () => { if(state.currentUser) socket.emit('auth:session', { userId: state.currentUser.id }); });
socket.on('auth:forced_logout', () => {
  localStorage.removeItem('chat_session_token');
  alert('Tài khoản của bạn đã bị quản trị viên xóa!');
  location.reload();
});

// --- RENDER DANH SÁCH CHAT ---
function renderChatList() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  list.innerHTML = '';
  const query = state.searchQuery || '';
  const filter = state.activeFilter || 'all';

  // 1. Lời mời kết bạn
  if (state.requests.length > 0 && !query && filter === 'all') {
    list.innerHTML += `<div class="chat-section-header">LỜI MỜI KẾT BẠN (${state.requests.length})</div>`;
    state.requests.forEach(req => {
      list.innerHTML += `
        <div class="chat-item">
          <img class="avatar" src="${req.fromAvatar}">
          <div style="flex:1;"><b>${req.fromUsername}</b> muốn kết bạn</div>
          <button class="btn-action green" onclick="acceptFriend('${req.id}')">Đồng Ý</button>
        </div>
      `;
    });
  }

  // 2. Nhóm chat
  if ((filter === 'all' || filter === 'groups') && !query) {
    const sortedGroups = [...state.groups].sort((a, b) => {
      const msgA = state.lastMessages.get(a.id);
      const msgB = state.lastMessages.get(b.id);
      const timeA = msgA ? new Date(msgA.timestamp).getTime() : 0;
      const timeB = msgB ? new Date(msgB.timestamp).getTime() : 0;
      return timeB - timeA;
    });

    const displayedGroups = filter === 'unread' 
      ? sortedGroups.filter(g => (state.unreadCounts.get(g.id) || 0) > 0)
      : sortedGroups;

    if (displayedGroups.length > 0) {
      list.innerHTML += `<div class="chat-section-header">NHÓM CHAT (${displayedGroups.length})</div>`;
      displayedGroups.forEach(g => {
        const lastMsg = state.lastMessages.get(g.id);
        const unreadCount = state.unreadCounts.get(g.id) || 0;
        const memberCount = g.members ? g.members.length : (g.membersCount || 0);
        let previewText = `${memberCount} thành viên`;
        let timeText = '';
        if (lastMsg && state.currentUser) {
          const time = new Date(lastMsg.timestamp);
          timeText = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
          const prefix = lastMsg.senderId === state.currentUser.id ? 'Bạn: ' : `${lastMsg.senderName}: `;
          previewText = lastMsg.type === 'image' ? `${prefix}[Hình ảnh]` : `${prefix}${lastMsg.content}`;
        }

        list.innerHTML += `
          <div class="chat-item ${unreadCount > 0 ? 'unread' : ''}" onclick="openRoom('${g.id}', '${g.name}', '${g.avatar}', '${memberCount} thành viên')">
            <div class="avatar-wrapper">
              <img class="avatar" src="${g.avatar}">
            </div>
            <div class="chat-item-info">
              <div class="chat-item-top">
                <h4>${g.name}</h4>
                <span class="chat-time">${timeText}</span>
              </div>
              <div class="chat-item-bottom">
                <p class="chat-preview">${previewText}</p>
                ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      });
    }
  }

  // 3. Bạn bè
  if ((filter === 'all' || filter === 'unread' || filter === 'friends') && state.currentUser) {
    const filteredFriends = (state.friends || []).filter(f => {
      const matchesQuery = f.username.toLowerCase().includes(query.toLowerCase());
      const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
      const unreadCount = state.unreadCounts.get(dmRoomId) || 0;
      if (filter === 'unread' && unreadCount === 0) return false;
      return matchesQuery;
    }).sort((a, b) => {
      const dmRoomA = [state.currentUser.id, a.id].sort().join('_DM_');
      const dmRoomB = [state.currentUser.id, b.id].sort().join('_DM_');
      const msgA = state.lastMessages.get(dmRoomA);
      const msgB = state.lastMessages.get(dmRoomB);
      const timeA = msgA ? new Date(msgA.timestamp).getTime() : 0;
      const timeB = msgB ? new Date(msgB.timestamp).getTime() : 0;
      return timeB - timeA;
    });

    list.innerHTML += `<div class="chat-section-header">BẠN BÈ (${filteredFriends.length})</div>`;

    if (filteredFriends.length === 0) {
      list.innerHTML += `<div class="empty-hint">Không có cuộc trò chuyện nào</div>`;
    } else {
      filteredFriends.forEach(f => {
        const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
        const lastMsg = state.lastMessages.get(dmRoomId);
        const unreadCount = state.unreadCounts.get(dmRoomId) || 0;
        const customNick = state.nicknames ? state.nicknames.get(dmRoomId) : null;
        const displayName = customNick || f.username;

        let previewText = 'Chưa có tin nhắn';
        let timeText = '';

        if (lastMsg) {
          const time = new Date(lastMsg.timestamp);
          timeText = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
          const prefix = lastMsg.senderId === state.currentUser.id ? 'Bạn: ' : '';
          previewText = lastMsg.type === 'image' ? `${prefix}[Hình ảnh]` : `${prefix}${lastMsg.content}`;
        }

        list.innerHTML += `
          <div class="chat-item ${unreadCount > 0 ? 'unread' : ''}" onclick="openRoom('${dmRoomId}', '${f.username}', '${f.avatar}', '${f.status === 'online' ? '🟢 Online' : '⚪ Offline'}')">
            <div class="avatar-wrapper">
              <img class="avatar" src="${f.avatar}">
              <span class="status-dot ${f.status === 'online' ? 'online' : 'offline'}"></span>
            </div>
            <div class="chat-item-info">
              <div class="chat-item-top">
                <h4>${displayName}</h4>
                <span class="chat-time">${timeText}</span>
              </div>
              <div class="chat-item-bottom">
                <p class="chat-preview">${previewText}</p>
                ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount}</span>` : ''}
              </div>
            </div>
          </div>
        `;
      });
    }
  }

  // 4. Người dùng khác
  if (query && state.currentUser) {
    const friendIds = new Set((state.friends || []).map(f => f.id));
    const strangers = (state.allUsers || []).filter(u => 
      u.id !== state.currentUser.id && 
      !friendIds.has(u.id) && 
      u.username.toLowerCase().includes(query.toLowerCase())
    );

    if (strangers.length > 0) {
      list.innerHTML += `<div class="chat-section-header">NGƯỜI DÙNG KHÁC</div>`;
      strangers.forEach(u => {
        list.innerHTML += `
          <div class="chat-item">
            <img class="avatar" src="${u.avatar}">
            <div style="flex:1;">
              <h4 style="margin:0;">${u.username}</h4>
              <span style="font-size:12px; color:var(--text-secondary);">Chưa kết bạn</span>
            </div>
            <button class="btn-action blue" onclick="sendFriendRequest('${u.id}')">Kết Bạn</button>
          </div>
        `;
      });
    }
  }
}

function sendFriendRequest(targetUserId) {
  socket.emit('friend:request', { targetUserId });
  showToast('Đã gửi lời mời kết bạn!');
}

function acceptFriend(reqId) { 
  socket.emit('friend:accept', { reqId }); 
}

// --- MỞ PHÒNG CHAT ---
function openRoom(roomId, name, avatar, status) {
  state.activeRoomId = roomId;
  state.unreadCounts.set(roomId, 0);

  let displayStatus = status;
  if (roomId.startsWith('grp_')) {
    const currentGroup = state.groups.find(g => g.id === roomId);
    if (currentGroup) {
      const count = currentGroup.members ? currentGroup.members.length : (currentGroup.membersCount || 0);
      displayStatus = `${count} thành viên`;
    }
  }

  let displayName = name;
  if (roomId.includes('_DM_')) {
    const customNick = state.nicknames.get(roomId);
    if (customNick) displayName = customNick;
  }
 
  const chatNameEl = document.getElementById('active-chat-name');
  const chatStatusEl = document.getElementById('active-chat-status');
  const chatScreen = document.getElementById('chat-screen');

  if (chatNameEl) chatNameEl.innerText = displayName;
  if (chatStatusEl) chatStatusEl.innerText = displayStatus;
  if (chatScreen) chatScreen.classList.remove('hidden');
  if (emojiPicker) emojiPicker.classList.add('hidden');
  
  const btnSettings = document.getElementById('btn-group-settings');
  const btnChatOptions = document.getElementById('btn-chat-options');

  if (roomId.startsWith('grp_')) {
    if (btnSettings) btnSettings.classList.remove('hidden');
    if (btnChatOptions) btnChatOptions.classList.add('hidden');
  } else {
    if (btnSettings) btnSettings.classList.add('hidden');
    if (btnChatOptions) btnChatOptions.classList.remove('hidden');
  }
  
  socket.emit('messages:get', { roomId });
  applyRoomTheme(roomId);
  updateQuickReactionUI(roomId);
  renderChatList();
}

const btnBackList = document.getElementById('btn-back-list');
if (btnBackList) {
  btnBackList.onclick = () => {
    const chatScreen = document.getElementById('chat-screen');
    if (chatScreen) chatScreen.classList.add('hidden');
    state.activeRoomId = null;
  };
}

// --- XỬ LÝ TIN NHẮN ---
socket.on('message:received', (msg) => {
  state.lastMessages.set(msg.roomId, { 
    content: msg.content, 
    timestamp: msg.timestamp, 
    senderId: msg.sender.id, 
    senderName: msg.sender.username, 
    type: msg.type 
  });
  
  if (msg.roomId === state.activeRoomId) {
    appendMessage(msg);
  } else {
    const currentUnread = state.unreadCounts.get(msg.roomId) || 0;
    state.unreadCounts.set(msg.roomId, currentUnread + 1);
  }
  renderChatList();
});

socket.on('messages:history', ({ roomId, messages }) => {
  if (state.activeRoomId === roomId) {
    const viewport = document.getElementById('messages-viewport');
    if (viewport) viewport.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
  }
  
  if (messages && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    state.lastMessages.set(roomId, {
      content: lastMsg.content,
      timestamp: lastMsg.timestamp,
      senderId: lastMsg.sender?.id || lastMsg.senderId,
      senderName: lastMsg.sender?.username || lastMsg.senderName,
      type: lastMsg.type
    });
  } else {
    state.lastMessages.delete(roomId);
  }
  renderChatList();
});

// Lắng nghe khi xóa đơn phương thành công từ server cho riêng user hiện tại
socket.on('messages:cleared_me', ({ roomId }) => {
  if (state.activeRoomId === roomId) {
    const viewport = document.getElementById('messages-viewport');
    if (viewport) viewport.innerHTML = '';
  }
  state.lastMessages.delete(roomId);
  renderChatList();
});

function sendMessage() {
  if (!msgInput) return;
  const content = msgInput.value.trim();
  if (content && state.activeRoomId) {
    socket.emit('message:send', { roomId: state.activeRoomId, content, type: 'text' });
    msgInput.value = '';
    if(emojiPicker) emojiPicker.classList.add('hidden');
  }
}

const btnSend = document.getElementById('btn-send');
if (btnSend) btnSend.onclick = sendMessage;
if (msgInput) msgInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };

function appendMessage(msg) {
  const viewport = document.getElementById('messages-viewport');
  if (!viewport || !state.currentUser) return;
  const isSelf = msg.sender.id === state.currentUser.id;
  const div = document.createElement('div');
  div.className = `msg ${isSelf ? 'self' : 'other'}`;

  let bodyContent = '';
  if (msg.type === 'image') {
    bodyContent = `<img src="${msg.content}" class="chat-image-sent" alt="Hình ảnh">`;
  } else {
    bodyContent = `<div class="msg-text-content">${msg.content}</div>`;
  }

  const isGroup = state.activeRoomId && state.activeRoomId.startsWith('grp_');
  const showSenderName = !isSelf && isGroup;

  div.innerHTML = `${showSenderName ? `<strong>${msg.sender.username}</strong><br>` : ''}${bodyContent}`;
  viewport.appendChild(div);
  viewport.scrollTop = viewport.scrollHeight;
}

// --- GIAO DIỆN VÀ QUẢN LÝ NHÓM ---
function renderGroupMembersCheckbox(preSelectedFriendId = null) {
  const container = document.getElementById('group-members-list');
  if (!container) return;
  container.innerHTML = '';
  if (state.friends.length === 0) {
    container.innerHTML = '<p style="font-size: 13px; color: #718096; text-align: center; padding: 10px;">Chưa có bạn bè để thêm</p>';
    return;
  }
  state.friends.forEach(f => {
    const isChecked = f.id === preSelectedFriendId ? 'checked' : '';
    container.innerHTML += `
      <label class="member-checkbox-item" style="display: flex; align-items: center; gap: 10px; padding: 6px 0; cursor: pointer;">
        <input type="checkbox" value="${f.id}" class="group-member-checkbox" ${isChecked} style="width: 16px; height: 16px;">
        <img src="${f.avatar}" style="width: 28px; height: 28px; border-radius: 50%; object-fit: cover;">
        <span style="font-size: 14px; font-weight: 500;">${f.username}</span>
      </label>
    `;
  });
}

function renderGroupSettingsModal() {
  const group = state.groups.find(g => g.id === state.activeRoomId);
  if (!group || !state.currentUser) return;

  const isAdmin = group.adminId === state.currentUser.id;
  const countEl = document.getElementById('setting-member-count');
  const memberCount = group.members ? group.members.length : (group.membersCount || 0);
  if (countEl) countEl.innerText = memberCount;
  
  const btnDeleteGroup = document.getElementById('btn-delete-group');
  if (btnDeleteGroup) {
    if (isAdmin) btnDeleteGroup.classList.remove('hidden');
    else btnDeleteGroup.classList.add('hidden');
  }

  const listContainer = document.getElementById('setting-members-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (group.members) {
    group.members.forEach(m => {
      const isMemberAdmin = m.id === group.adminId;
      const isSelf = m.id === state.currentUser.id;
      let actionButtons = '';
      
      if (isAdmin && !isSelf) {
        actionButtons = `
          <div style="display:flex; gap:5px; margin-top:5px;">
            <button onclick="execGroupAction('transfer_admin', '${m.id}')" style="background:#3182ce; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Phong Admin</button>
            ${m.isMuted 
              ? `<button onclick="execGroupAction('unmute', '${m.id}')" style="background:#38a169; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Bỏ Mute</button>`
              : `<button onclick="execGroupAction('mute', '${m.id}')" style="background:#d69e2e; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Mute</button>`
            }
            <button onclick="execGroupAction('kick', '${m.id}')" style="background:#e53e3e; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Kick</button>
          </div>
        `;
      }

      listContainer.innerHTML += `
        <div style="padding: 10px; border-bottom: 1px solid #edf2f7;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <div style="display: flex; align-items: center; gap: 10px;">
              <img src="${m.avatar}" style="width: 32px; height: 32px; border-radius: 50%;">
              <div>
                <span style="font-weight: bold; font-size: 14px;">${m.username} ${isSelf ? '(Bạn)' : ''}</span>
                <div style="font-size: 11px; color: ${m.isMuted ? '#e53e3e' : '#718096'};">
                  ${isMemberAdmin ? '👑 Quản Trị Viên' : 'Thành Viên'} ${m.isMuted ? ' • 🔇 Đang bị cấm chat' : ''}
                </div>
              </div>
            </div>
          </div>
          ${actionButtons}
        </div>
      `;
    });
  }
}

window.execGroupAction = function(action, targetId) {
  const currentGroupId = state.activeRoomId;
  socket.emit('group:action', { action, groupId: currentGroupId, targetId });

  if (action === 'leave' || action === 'delete_group') {
    const modalGroupSettings = document.getElementById('modal-group-settings');
    if (modalGroupSettings) {
      modalGroupSettings.style.display = 'none';
      modalGroupSettings.classList.add('hidden');
    }

    state.groups = state.groups.filter(g => g.id !== currentGroupId);
    const chatScreen = document.getElementById('chat-screen');
    if (chatScreen) chatScreen.classList.add('hidden');
    state.activeRoomId = null;
    renderChatList();
    showToast(action === 'leave' ? 'Đã rời nhóm thành công!' : 'Đã giải tán nhóm thành công!');
  } else {
    showToast('Đã thực hiện thao tác thành công!');
  }
};

// --- BỘ ĐIỀU KHIỂN EVENT CLICK HỢP NHẤT ---
document.addEventListener('click', (e) => {
  const modalGroup = document.getElementById('modal-group');
  const modalChatSettings = document.getElementById('modal-chat-settings');
  const modalGroupSettings = document.getElementById('modal-group-settings');
  const modalTheme = document.getElementById('modal-theme');
  const modalNickname = document.getElementById('modal-nickname');
  const modalConfirm = document.getElementById('modal-confirm');

  // 1. XÓA ĐOẠN CHAT (CHỈ Ở PHÍA CÁ NHÂN HIỆN TẠI)
  const btnDeleteChat = e.target.closest('#delete-chat, #btn-delete-chat, #set-delete-chat') || 
                        (e.target.innerText && e.target.innerText.includes('Xóa đoạn chat') ? e.target : null);
  if (btnDeleteChat) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }

    if (state.activeRoomId && state.currentUser) {
      showConfirmModal('Xóa đoạn chat', 'Bạn có chắc chắn muốn xóa đoạn chat ở phía bạn không? (Người còn lại vẫn giữ tin nhắn)', () => {
        socket.emit('messages:clear_me', { roomId: state.activeRoomId });
        showToast('Đang xóa đoạn chat phía bạn...');
      });
    }
    return;
  }

 // --- XÓA KẾT BẠN (HỦY KẾT BẠN) ---
const btnUnfriend = e.target.closest('#set-unfriend, #btn-unfriend') || 
                    (e.target.innerText && e.target.innerText.includes('Xóa kết bạn') ? e.target : null);

if (btnUnfriend) {
  if (modalChatSettings) {
    modalChatSettings.classList.add('hidden');
    modalChatSettings.style.display = 'none';
  }

  if (state.activeRoomId && state.activeRoomId.includes('_DM_') && state.currentUser) {
    const parts = state.activeRoomId.split('_DM_');
    const targetFriendId = parts.find(id => id !== state.currentUser.id);
    const friend = state.friends.find(f => f.id === targetFriendId);

    const friendName = friend ? friend.username : 'người dùng này';

    showConfirmModal(
      'Xóa kết bạn',
      `Bạn có chắc chắn muốn xóa kết bạn với ${friendName}?`,
      () => {
        // 1. Gửi socket lên server
        socket.emit('friend:unfriend', { friendId: targetFriendId });

        // 2. Xóa ngay bạn bè khỏi state local ở client
        state.friends = state.friends.filter(f => f.id !== targetFriendId);

        // 3. Đóng màn hình chat hiện tại
        const chatScreen = document.getElementById('chat-screen');
        if (chatScreen) chatScreen.classList.add('hidden');
        state.activeRoomId = null;

        // 4. Cập nhật lại danh sách hiển thị
        renderChatList();

        showToast(`Đã xóa kết bạn với ${friendName}!`);
      }
    );
  }
  return;
}

  // 3. TAB LỌC DANH SÁCH CHAT
  const tabBtn = e.target.closest('.filter-tab-btn');
  if (tabBtn) {
    const filterType = tabBtn.getAttribute('data-filter');
    if (filterType === 'more') {
      showToast('Tính năng mở rộng đang phát triển!');
      return;
    }
    state.activeFilter = filterType;

    document.querySelectorAll('.filter-tab-btn').forEach(btn => {
      if (btn.getAttribute('data-filter') !== 'more') {
        btn.style.background = 'transparent';
        btn.style.color = 'var(--text-secondary, #718096)';
        btn.style.fontWeight = '500';
      }
    });
    if (filterType !== 'more') {
      tabBtn.style.background = 'var(--primary-light, #ebf8ff)';
      tabBtn.style.color = 'var(--primary-color, #3182ce)';
      tabBtn.style.fontWeight = '600';
    }
    renderChatList();
    return;
  }

  // 4. MỞ/ĐÓNG MODAL CÀI ĐẶT
  if (e.target.closest('#btn-chat-options')) {
    if (modalChatSettings) {
      modalChatSettings.classList.remove('hidden');
      modalChatSettings.style.display = 'flex';
    }
    return;
  }

  if (e.target.closest('#btn-close-chat-settings') || (modalChatSettings && e.target === modalChatSettings)) {
    if (modalChatSettings) {
      modalChatSettings.style.display = 'none';
      modalChatSettings.classList.add('hidden');
    }
    return;
  }

  if (e.target.closest('#btn-group-settings')) {
    if (modalGroupSettings) {
      modalGroupSettings.classList.remove('hidden');
      modalGroupSettings.style.display = 'flex';
      renderGroupSettingsModal();
    }
    return;
  }

  if (e.target.closest('#btn-close-group-settings') || (modalGroupSettings && e.target === modalGroupSettings)) {
    if (modalGroupSettings) {
      modalGroupSettings.style.display = 'none';
      modalGroupSettings.classList.add('hidden');
    }
    return;
  }
  
  if (e.target.closest('#btn-close-group-modal') || (modalGroup && e.target === modalGroup)) {
    if (modalGroup) {
      modalGroup.style.display = 'none';
      modalGroup.classList.add('hidden');
    }
    return;
  }

  // 5. THAY ĐỔI CHỦ ĐỀ (THEME)
  const btnSetTheme = e.target.closest('#set-theme');
  if (btnSetTheme) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }
    if (modalTheme) {
      modalTheme.classList.remove('hidden');
      modalTheme.style.display = 'flex';
    }
    return;
  }

  if (e.target.closest('#btn-close-theme-modal') || e.target.closest('#btn-close-theme') || (modalTheme && e.target === modalTheme)) {
    if (modalTheme) {
      modalTheme.style.display = 'none';
      modalTheme.classList.add('hidden');
    }
    return;
  }

  const themeOption = e.target.closest('.theme-option, .theme-option-btn');
  if (themeOption && state.activeRoomId) {
    const selectedTheme = themeOption.getAttribute('data-theme') || themeOption.getAttribute('data-theme-type');
    if (selectedTheme) {
      state.roomThemes.set(state.activeRoomId, selectedTheme);
      localStorage.setItem('chat_room_themes', JSON.stringify(Array.from(state.roomThemes.entries())));
      applyRoomTheme(state.activeRoomId);
      showToast('Đã thay đổi chủ đề đoạn chat!');
    }
    if (modalTheme) {
      modalTheme.style.display = 'none';
      modalTheme.classList.add('hidden');
    }
    return;
  }

  // 6. ĐỔI BIỆT DANH
  const btnSetNickname = e.target.closest('#set-nickname');
  if (btnSetNickname) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }

    if (state.activeRoomId && state.activeRoomId.includes('_DM_') && state.currentUser) {
      const parts = state.activeRoomId.split('_DM_');
      const targetFriendId = parts.find(id => id !== state.currentUser.id);
      const friend = state.friends.find(f => f.id === targetFriendId);

      if (friend) {
        const inputNick = document.getElementById('nickname-input');
        const titleNick = document.getElementById('nickname-target-name');

        if (titleNick) titleNick.innerText = `Đổi biệt danh cho ${friend.username}`;
        if (inputNick) inputNick.value = state.nicknames.get(state.activeRoomId) || friend.username;

        if (modalNickname) {
          modalNickname.classList.remove('hidden');
          modalNickname.style.display = 'flex';
          if (inputNick) inputNick.focus();
        }
      }
    }
    return;
  }

  if (e.target.closest('#btn-cancel-nickname') || (modalNickname && e.target === modalNickname)) {
    if (modalNickname) {
      modalNickname.style.display = 'none';
      modalNickname.classList.add('hidden');
    }
    return;
  }

  if (e.target.closest('#btn-save-nickname')) {
    const inputNick = document.getElementById('nickname-input');
    const newNickname = inputNick ? inputNick.value.trim() : '';

    if (state.activeRoomId && state.activeRoomId.includes('_DM_') && state.currentUser) {
      if (newNickname) {
        state.nicknames.set(state.activeRoomId, newNickname);
      } else {
        state.nicknames.delete(state.activeRoomId);
      }
      localStorage.setItem('chat_nicknames', JSON.stringify(Array.from(state.nicknames.entries())));

      const parts = state.activeRoomId.split('_DM_');
      const targetFriendId = parts.find(id => id !== state.currentUser.id);
      const friend = state.friends.find(f => f.id === targetFriendId);
      
      const displayName = newNickname || (friend ? friend.username : 'Cuộc trò chuyện');
      const headerNameEl = document.getElementById('active-chat-name');
      if (headerNameEl) headerNameEl.innerText = displayName;

      showToast('Đã cập nhật biệt danh thành công!');
    }

    if (modalNickname) {
      modalNickname.style.display = 'none';
      modalNickname.classList.add('hidden');
    }
    renderChatList();
    return;
  }

  // 7. TẠO NHÓM
  if (e.target.closest('#btn-open-group-modal') || e.target.closest('.btn-create-group')) {
    if (modalChatSettings) modalChatSettings.classList.add('hidden');
    if (modalGroup) {
      modalGroup.classList.remove('hidden');
      modalGroup.style.display = 'flex';
      renderGroupMembersCheckbox(null);
    }
    return;
  }

  const createGroupBtn = e.target.closest('#set-create-group');
  if (createGroupBtn) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }

    if (modalGroup && state.activeRoomId && state.activeRoomId.includes('_DM_')) {
      const parts = state.activeRoomId.split('_DM_');
      const targetFriendId = parts.find(id => id !== state.currentUser.id);
      
      modalGroup.classList.remove('hidden');
      modalGroup.style.display = 'flex';
      renderGroupMembersCheckbox(targetFriendId);
    }
    return;
  }
  
  if (e.target.closest('#btn-confirm-create-group')) {
    const groupNameInput = document.getElementById('group-name-input');
    const groupName = groupNameInput ? groupNameInput.value.trim() : '';
    const checkedBoxes = document.querySelectorAll('.group-member-checkbox:checked');
    const memberIds = Array.from(checkedBoxes).map(cb => cb.value);
    
    if (!groupName) return showToast('Vui lòng nhập tên nhóm!', false);
    if (memberIds.length === 0) return showToast('Vui lòng chọn ít nhất 1 thành viên!', false);
    
    socket.emit('group:create', {
        name: groupName,
        avatar: state.selectedGroupAvatar,
        memberIds: memberIds
    });
    
    if (modalGroup) {
        modalGroup.style.display = 'none';
        modalGroup.classList.add('hidden');
    }
    if (groupNameInput) groupNameInput.value = '';
    showToast('Đang tạo nhóm...');
    return;
  }

  // 8. CẢM XÚC NHANH
  const setEmojiBtn = e.target.closest('#set-emoji');
  if (setEmojiBtn) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }
    const currentEmoji = state.roomReactions?.get(state.activeRoomId) || '❤️';
    
    Swal.fire({
      title: 'Cảm xúc nhanh',
      text: 'Nhập emoji cảm xúc nhanh cho đoạn chat này:',
      input: 'text',
      inputValue: currentEmoji,
      showCancelButton: true,
      confirmButtonText: 'Xác nhận',
      cancelButtonText: 'Hủy',
      confirmButtonColor: '#0084ff',
      cancelButtonColor: '#e4e6eb'
    }).then((result) => {
      if (result.isConfirmed && result.value) {
        const newEmoji = result.value.trim();
        if (newEmoji) {
          if (!state.roomReactions) state.roomReactions = new Map();
          state.roomReactions.set(state.activeRoomId, newEmoji);
          localStorage.setItem('chat_room_reactions', JSON.stringify(Array.from(state.roomReactions.entries())));
          updateQuickReactionUI(state.activeRoomId);
          showToast('Đã đổi cảm xúc nhanh thành công!');
        }
      }
    });
    return;
  }
  // 9. CÁC NÚT TRONG MODAL CONFIRM
  if (e.target.closest('#btn-confirm-yes')) {
    if (modalConfirm) {
      modalConfirm.classList.add('hidden');
      modalConfirm.style.display = 'none';
    }
    if (typeof confirmCallback === 'function') {
      confirmCallback();
      confirmCallback = null;
    }
    return;
  }

  if (e.target.closest('#btn-confirm-no') || e.target.closest('#btn-close-confirm')) {
    if (modalConfirm) {
      modalConfirm.classList.add('hidden');
      modalConfirm.style.display = 'none';
    }
    confirmCallback = null;
    return;
  }
});