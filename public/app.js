const socket = io();

let state = {
  currentUser: null,
  activeRoomId: null,
  theme: localStorage.getItem('chat_theme') || 'dark',
  roomThemes: new Map(JSON.parse(localStorage.getItem('chat_room_themes') || '[]')),
  roomReactions: new Map(JSON.parse(localStorage.getItem('chat_room_reactions') || '[]')),
  friends: [],
  requests: [],
  sentRequests: new Set(),
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

// ==========================================
// 1. KHAI BÁO BIẾN TOÀN CỤC (ĐẶT Ở ĐẦU FILE JS)
// ==========================================
let peer = null;
let localStream = null;
let currentCallTargetId = null;
let incomingCallDataGlobal = null;
let isAudioMuted = false;
let isVideoMuted = false;

// Cấu hình STUN servers
const peerConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// --- HÀM HỖ TRỢ TRUY XUẤT USER HIỆN TẠI ---
function getCurrentUser() {
  return state.currentUser || JSON.parse(localStorage.getItem('user')) || {};
}

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

// Gửi yêu cầu kháng cáo từ phía người dùng bị hạn chế
function submitRestrictionAppeal(reasonText) {
  const currentUser = getCurrentUser();

  socket.emit('appeal:submit', {
    userId: currentUser.id,
    username: currentUser.username,
    reason: reasonText
  });

  showToast('Đã gửi yêu cầu hỗ trợ tới Quản trị viên!');
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

function updateRequestBadge(requestsList) {
  const badge = document.getElementById('request-count-badge');
  if (!badge) return;

  const count = requestsList ? requestsList.length : 0;

  if (count >= 1) {
    badge.innerText = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
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
  localStorage.setItem('user', JSON.stringify(user));
  const modalAuth = document.getElementById('modal-auth');
  if (modalAuth) modalAuth.classList.add('hidden');
  const myAvatar = document.getElementById('my-avatar');
  const myName = document.getElementById('my-name');
  if (myAvatar) myAvatar.src = user.avatar;
  if (myName) myName.innerText = user.username;
});

socket.on('auth:restricted', (message) => {
  Swal.fire({
    icon: 'warning',
    title: 'Tài khoản bị hạn chế',
    text: message,
    confirmButtonColor: '#d33'
  });
});

// Lắng nghe thông báo lỗi/hạn chế tin nhắn
socket.on('message:error', (errorMsg) => {
  if (errorMsg.includes('hạn chế')) {
    Swal.fire({
      icon: 'warning',
      title: 'Tài khoản bị hạn chế',
      text: errorMsg,
      showCancelButton: true,
      confirmButtonText: 'Đã hiểu',
      cancelButtonText: '🛠️ Yêu cầu hỗ trợ gỡ hạn chế',
      confirmButtonColor: '#d33',
      cancelButtonColor: '#3182ce',
      reverseButtons: true
    }).then((result) => {
      if (result.dismiss === Swal.DismissReason.cancel) {
        Swal.fire({
          title: 'Gửi yêu cầu hỗ trợ',
          input: 'textarea',
          inputPlaceholder: 'Nhập lý do hoặc lời nhắn tới Admin để xin giảm/gỡ án phạt...',
          showCancelButton: true,
          confirmButtonText: 'Gửi yêu cầu',
          cancelButtonText: 'Hủy',
          confirmButtonColor: '#3182ce',
          cancelButtonColor: '#cbd5e0'
        }).then((appealResult) => {
          if (appealResult.isConfirmed) {
            const reason = appealResult.value || 'Xin hỗ trợ gỡ hạn chế tài khoản';
            const currentUsr = getCurrentUser();

            socket.emit('appeal:restriction', { 
              reason: reason,
              userId: currentUsr?.id,
              username: currentUsr?.username
            });
            showToast('Đã gửi yêu cầu hỗ trợ tới Admin thành công!');
          }
        });
      }
    });
  } else {
    Swal.fire({
      icon: 'warning',
      title: 'Thông báo',
      text: errorMsg,
      confirmButtonColor: '#d33',
      confirmButtonText: 'Đã hiểu'
    });
  }
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
    localStorage.removeItem('user');
    location.reload();
  };
}

// Sự kiện socket nhận danh sách lời mời kết bạn từ server
socket.on('receive_friend_requests', (requests) => {
  if (Array.isArray(requests)) {
    state.requests = requests;
    updateRequestBadge(state.requests);
    renderChatList();
  }
});

// Xử lý click ra ngoài modal cài đặt chat để đóng an toàn
const modalChatSettings = document.getElementById('modal-chat-settings');
if (modalChatSettings) {
  modalChatSettings.addEventListener('click', function(e) {
    if (e.target === modalChatSettings) {
      modalChatSettings.style.display = 'none';
      modalChatSettings.classList.add('hidden');
    }
  });
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
  state.friends = data.friends || [];
  state.requests = data.requests || [];
  state.allUsers = data.allUsers || [];
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

socket.on('friend:incoming', () => { 
  showToast('Bạn có lời mời kết bạn mới!');
  if(state.currentUser) socket.emit('auth:session', { userId: state.currentUser.id }); 
});
socket.on('friend:updated', () => { if(state.currentUser) socket.emit('auth:session', { userId: state.currentUser.id }); });
socket.on('group:updated', () => { if(state.currentUser) socket.emit('auth:session', { userId: state.currentUser.id }); });
socket.on('auth:forced_logout', () => {
  localStorage.removeItem('chat_session_token');
  localStorage.removeItem('user');
  alert('Tài khoản của bạn đã bị quản trị viên xóa!');
  location.reload();
});

// --- RENDER DANH SÁCH CHAT (OPTIMIZED DOM RENDERING) ---
function renderChatList() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  
  const query = state.searchQuery || '';
  const filter = state.activeFilter || 'all';
  let html = '';

  updateRequestBadge(state.requests);

  if (filter === 'requests' && !query) {
    if (state.requests.length === 0) {
      list.innerHTML = `<div class="empty-hint" style="text-align:center; padding:30px; color:var(--text-sub);">Không có lời mời kết bạn nào</div>`;
      return;
    }

    html += `<div style="padding: 8px 16px; font-weight: 600; color: var(--text-main);">Lời mời kết bạn (${state.requests.length})</div>`;
    state.requests.forEach(req => {
      html += `
        <div class="chat-item request-item">
          <img class="avatar" src="${req.fromAvatar}">
          <div style="flex:1; overflow:hidden; padding: 0 8px;">
            <div style="font-weight: 600; color: var(--text-main);">${req.fromUsername}</div>
            <div style="font-size: 12px; color: var(--text-sub);">Muốn kết bạn với bạn</div>
          </div>
          <button class="btn-action green" onclick="acceptFriend('${req.id}')">Đồng ý</button>
        </div>
      `;
    });
    list.innerHTML = html;
    return;
  }

  let combinedChats = [];

  if ((filter === 'all' || filter === 'groups') && !query) {
    const sortedGroups = [...state.groups];
    const displayedGroups = filter === 'unread' 
      ? sortedGroups.filter(g => (state.unreadCounts.get(g.id) || 0) > 0)
      : sortedGroups;

    displayedGroups.forEach(g => {
      const lastMsg = state.lastMessages.get(g.id);
      const timeVal = lastMsg ? new Date(lastMsg.timestamp).getTime() : 0;
      combinedChats.push({ kind: 'group', item: g, timeVal });
    });
  }

  if ((filter === 'all' || filter === 'unread' || filter === 'friends') && state.currentUser) {
    const filteredFriends = (state.friends || []).filter(f => {
      const matchesQuery = f.username.toLowerCase().includes(query.toLowerCase());
      const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
      const unreadCount = state.unreadCounts.get(dmRoomId) || 0;
      if (filter === 'unread' && unreadCount === 0) return false;
      return matchesQuery;
    });

    filteredFriends.forEach(f => {
      const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
      const lastMsg = state.lastMessages.get(dmRoomId);
      const timeVal = lastMsg ? new Date(lastMsg.timestamp).getTime() : 0;
      combinedChats.push({ kind: 'friend', item: f, timeVal, dmRoomId });
    });
  }

  combinedChats.sort((a, b) => b.timeVal - a.timeVal);

  if (combinedChats.length === 0 && !query) {
    html += `<div class="empty-hint" style="text-align:center; padding:30px; color:var(--text-sub);">Không có cuộc trò chuyện nào</div>`;
  } else {
    combinedChats.forEach(entry => {
      if (entry.kind === 'group') {
        const g = entry.item;
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

        html += `
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
      } else if (entry.kind === 'friend') {
        const f = entry.item;
        const dmRoomId = entry.dmRoomId;
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

        html += `
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
      }
    });
  }

  if (query && state.currentUser) {
    if (!state.sentRequests) state.sentRequests = new Set();

    const friendIds = new Set((state.friends || []).map(f => f.id));
    const strangers = (state.allUsers || []).filter(u => 
      u.id !== state.currentUser.id && 
      !friendIds.has(u.id) && 
      u.username.toLowerCase().includes(query.toLowerCase())
    );

    if (strangers.length > 0) {
      strangers.forEach(u => {
        const isSent = state.sentRequests.has(u.id);

        let actionButton = '';
        if (isSent) {
          actionButton = `<button class="btn-action gray" onclick="cancelFriendRequest('${u.id}')" style="background:#e4e6eb; color:#050505; border:none; padding:6px 12px; border-radius:16px; font-weight:600; cursor:pointer;">Hủy kết bạn</button>`;
        } else {
          actionButton = `<button class="btn-action blue" onclick="sendFriendRequest('${u.id}')" style="background:#0084ff; color:#fff; border:none; padding:6px 12px; border-radius:16px; font-weight:600; cursor:pointer;">Kết Bạn</button>`;
        }

        html += `
          <div class="chat-item" style="padding: 10px 14px;">
            <img class="avatar" src="${u.avatar}">
            <div style="flex:1; padding-left: 8px;">
              <h4 style="margin:0; font-size: 14px;">${u.username}</h4>
              <span style="font-size:12px; color:var(--text-sub);">${isSent ? 'Đã gửi lời mời' : 'Chưa kết bạn'}</span>
            </div>
            ${actionButton}
          </div>
        `;
      });
    }
  }

  list.innerHTML = html;
}

function sendFriendRequest(userId) {
  socket.emit('friend:request', { targetId: userId });

  if (!state.sentRequests) state.sentRequests = new Set();
  state.sentRequests.add(userId);

  renderChatList();
  showToast('Đã gửi lời mời kết bạn!');
}

function cancelFriendRequest(userId) {
  socket.emit('friend:cancel_request', { targetId: userId });

  if (state.sentRequests) {
    state.sentRequests.delete(userId);
  }

  renderChatList();
  showToast('Đã hủy lời mời kết bạn');
}

function acceptFriend(reqId) { 
  socket.emit('friend:accept', { reqId }); 
}

// --- MỞ PHÒNG CHAT ---
function openRoom(roomId, name, avatar, status) {
  state.activeRoomId = roomId;
  state.unreadCounts.set(roomId, 0);

  const chatHeader = document.querySelector('.chat-header');

  if (chatHeader) {
    chatHeader.dataset.username = name;
    chatHeader.dataset.avatar = avatar;
  }

  let displayStatus = status;

  if (roomId.startsWith('grp_')) {
    const currentGroup = state.groups.find(g => g.id === roomId);
    if (currentGroup) {
      const count = currentGroup.members
        ? currentGroup.members.length
        : (currentGroup.membersCount || 0);

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

// Lắng nghe sự kiện click nút gọi trên giao diện chat header
document.addEventListener('DOMContentLoaded', () => {
  const btnVoiceCall = document.getElementById('btn-voice-call');
  const btnVideoCall = document.getElementById('btn-video-call');

  if (btnVoiceCall) {
    btnVoiceCall.addEventListener('click', () => initiateCall(false));
  }

  if (btnVideoCall) {
    btnVideoCall.addEventListener('click', () => initiateCall(true));
  }
});

// Kiểm tra điều kiện và tiến hành gọi
function initiateCall(isVideo) {
  if (typeof state === 'undefined' || !state.activeRoomId) {
    if (typeof showToast === 'function') showToast('Vui lòng chọn một đoạn chat riêng để gọi!', false);
    return;
  }

  const currentUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  if (!currentUser) {
    if (typeof showToast === 'function') showToast('Vui lòng đăng nhập lại!', false);
    return;
  }

  // Tách ID người nhận từ phòng chat riêng dạng _DM_
  const parts = state.activeRoomId.split('_DM_');
  const targetUserId = parts.find(id => id !== currentUser.id);

  if (!targetUserId) {
    if (typeof showToast === 'function') showToast('Chỉ có thể gọi điện trong khung chat riêng 1-1!', false);
    return;
  }

  startVideoCall(targetUserId, isVideo);
}

// 1. KHỞI TẠO CUỘC GỌI
async function startVideoCall(targetUserId, isVideo) {
  currentCallTargetId = targetUserId;
  const currentUser = typeof getCurrentUser === 'function' ? getCurrentUser() : null;

  const activeChatHeader = document.querySelector('.chat-header') || {};
  const targetName = activeChatHeader.dataset?.username || 'Người dùng';
  const targetAvatar = activeChatHeader.dataset?.avatar || 'https://cdn-icons-png.flaticon.com/512/149/149071.png';

  const nameEl = document.getElementById('call-target-name');
  const avatarEl = document.getElementById('call-target-avatar');
  const statusEl = document.getElementById('call-status-text');
  const waitingView = document.getElementById('call-waiting-view');

  if (nameEl) nameEl.textContent = targetName;
  if (avatarEl) avatarEl.src = targetAvatar;
  if (statusEl) statusEl.textContent = 'Đang gọi...';
  if (waitingView) waitingView.style.display = 'flex';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: isVideo ? { width: 1280, height: 720 } : false,
      audio: true
    });

    const videoContainer = document.getElementById('video-call-container');
    if (videoContainer) videoContainer.style.display = 'flex';

    const localVideoEl = document.getElementById('local-video');
    if (localVideoEl) {
      localVideoEl.srcObject = isVideo ? localStream : null;
      localVideoEl.style.display = isVideo ? 'block' : 'none';
    }

    peer = new SimplePeer({
      initiator: true,
      trickle: false,
      stream: localStream,
      config: peerConfig
    });

    peer.on('signal', (signalData) => {
      if (!targetUserId) {
        console.error('[CALL] Missing target user ID');
        return;
      }

      socket.emit('call_user', {
        targetUserId,
        signal: signalData,
        isVideo,
        callerName: currentUser?.username || 'Người dùng',
        callerAvatar: currentUser?.avatar || ''
      });
    });

    peer.on('stream', (remoteStream) => {
      if (waitingView) waitingView.style.display = 'none';

      const remoteVideoEl = document.getElementById('remote-video');
      if (remoteVideoEl) {
        remoteVideoEl.srcObject = remoteStream;
      }
    });

    peer.on('close', () => {
      endCallCleanUp();
    });

    peer.on('error', (err) => {
      console.error('Peer connection error:', err);
      if (typeof showToast === 'function') showToast('Lỗi kết nối cuộc gọi!', false);
      endCallCleanUp();
    });

  } catch (err) {
    console.error('Media error:', err);
    if (typeof showToast === 'function') showToast('Không thể truy cập Microphone hoặc Camera! Vui lòng kiểm tra quyền.', false);
    endCallCleanUp();
  }
}

// Hàm dọn dẹp phần cứng, ngắt kết nối và ẩn giao diện cuộc gọi
function endCallCleanUp() {
  if (peer) {
    try {
      peer.destroy();
    } catch (e) {
      console.error(e);
    }
    peer = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  const localVideoEl = document.getElementById('local-video');
  const remoteVideoEl = document.getElementById('remote-video');
  const videoContainer = document.getElementById('video-call-container');
  const popup = document.getElementById('incoming-call-popup');

  if (localVideoEl) localVideoEl.srcObject = null;
  if (remoteVideoEl) remoteVideoEl.srcObject = null;
  if (videoContainer) videoContainer.style.display = 'none';
  if (popup) popup.style.display = 'none';

  currentCallTargetId = null;
  incomingCallDataGlobal = null;
}

// ==========================================
// LẮNG NGHE SỰ KIỆN SOCKET.IO CHO CUỘC GỌI
// ==========================================
if (typeof socket !== 'undefined') {
  socket.on('incoming_call', (data) => {
    console.log('[CALL] Incoming call:', data);

    incomingCallDataGlobal = data;
    currentCallTargetId = data.fromSocketId;

    const callerNameDisplay = document.getElementById('caller-name-display');
    if (callerNameDisplay) {
      callerNameDisplay.textContent = data.callerName || 'Ai đó';
    }

    const callerAvatar = document.getElementById('caller-avatar');
    if (callerAvatar) {
      callerAvatar.src =
        data.callerAvatar ||
        'https://api.dicebear.com/7.x/avataaars/svg?seed=incoming-call';
    }

    const popup = document.getElementById('incoming-call-popup');

    if (popup) {
      popup.classList.remove('hidden');
      popup.style.display = 'flex';
      popup.visibility = 'visible';
      popup.opacity = '1';
      popup.style.zIndex = '10000';
    }

    console.log('[CALL] Popup displayed');
  });

  socket.on('call_accepted', (signal) => {
    if (peer) {
      try {
        peer.signal(signal);
      } catch (e) {
        console.error('Signal error:', e);
      }
    }
  });

  socket.on('call_rejected', () => {
    if (typeof showToast === 'function') showToast('Người dùng đã từ chối cuộc gọi.', false);
    endCallCleanUp();
  });

  socket.on('call_ended', () => {
    if (typeof showToast === 'function') showToast('Cuộc gọi đã kết thúc.', true);
    endCallCleanUp();
  });
}

// Xóa đoạn chat thành công
socket.on('messages:cleared_me', ({ roomId }) => {
  if (state.activeRoomId === roomId) {
    const viewport = document.getElementById('messages-viewport');
    if (viewport) viewport.innerHTML = '';
  }
  state.lastMessages.delete(roomId);
  renderChatList();
});

socket.on('messages:cleared', ({ roomId }) => {
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

// --- RENDERING THÀNH VIÊN TẠO NHÓM CHUẨN ---
function renderGroupMembersCheckbox(preSelectedFriendId = null) {
  const container = document.getElementById('group-members-list');
  if (!container) return;

  if (state.friends.length === 0) {
    container.innerHTML = '<p style="font-size: 13px; color: #718096; text-align: center; padding: 10px;">Chưa có bạn bè để thêm</p>';
    return;
  }

  let html = '';
  state.friends.forEach(f => {
    const isChecked = f.id === preSelectedFriendId ? 'checked' : '';
    html += `
      <label class="member-checkbox-item" style="display: flex; align-items: center; justify-content: flex-start; gap: 12px; padding: 8px 10px; cursor: pointer; width: 100%; box-sizing: border-box;">
        <input type="checkbox" value="${f.id}" class="group-member-checkbox" ${isChecked} style="width: 18px; height: 18px; margin: 0; flex-shrink: 0;">
        <img src="${f.avatar}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex-shrink: 0; margin: 0;">
        <span style="font-size: 14px; font-weight: 500; text-align: left; flex: 1; margin: 0;">${f.username}</span>
      </label>
    `;
  });
  container.innerHTML = html;
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

  let html = '';
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

      html += `
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
  listContainer.innerHTML = html;
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

  const clickedTarget = e.target.closest('button, .setting-item, .menu-item, [id^="set-"], [id^="btn-"]');
  const targetText = clickedTarget ? clickedTarget.innerText.trim() : '';

  // 1. XÓA ĐOẠN CHAT
  const btnDeleteChat = e.target.closest('#delete-chat, #btn-delete-chat, #set-delete-chat, .btn-delete-chat');
  const isDeleteTextClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('Xóa đoạn chat');

  if (btnDeleteChat || isDeleteTextClick) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }

    if (state.activeRoomId && state.currentUser) {
      showConfirmModal('Xóa đoạn chat', 'Bạn có chắc chắn muốn xóa đoạn chat ở phía bạn không? (Người còn lại vẫn giữ tin nhắn)', () => {
        socket.emit('messages:clear_me', { roomId: state.activeRoomId });
        
        const viewport = document.getElementById('messages-viewport');
        if (viewport) viewport.innerHTML = '';
        state.lastMessages.delete(state.activeRoomId);
        renderChatList();

        showToast('Đã xóa đoạn chat phía bạn!');
      });
    } else {
      showToast('Không thể xác định đoạn chat!', false);
    }
    return;
  }

  // 2. XÓA KẾT BẠN (HỦY KẾT BẠN)
  const btnUnfriend = e.target.closest('#set-unfriend, #btn-unfriend');
  const isUnfriendTextClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('Xóa kết bạn');

  if (btnUnfriend || isUnfriendTextClick) {
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
          socket.emit('friend:unfriend', { friendId: targetFriendId });
          state.friends = state.friends.filter(f => f.id !== targetFriendId);

          const chatScreen = document.getElementById('chat-screen');
          if (chatScreen) chatScreen.classList.add('hidden');
          state.activeRoomId = null;

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
  const isThemeTextClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('chủ đề');

  if (btnSetTheme || isThemeTextClick) {
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
  const isNicknameTextClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('biệt danh');

  if (btnSetNickname || isNicknameTextClick) {
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
  const btnOpenGroupModal = e.target.closest('#btn-open-group-modal, .btn-create-group, #set-create-group');
  const isCreateGroupOptionClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('Tạo nhóm');

  if (btnOpenGroupModal || isCreateGroupOptionClick) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }
    if (modalGroup) {
      modalGroup.classList.remove('hidden');
      modalGroup.style.display = 'flex';
      let preSelectedFriendId = null;
      if (state.activeRoomId && state.activeRoomId.includes('_DM_')) {
        const parts = state.activeRoomId.split('_DM_');
        preSelectedFriendId = parts.find(id => id !== state.currentUser?.id);
      }
      renderGroupMembersCheckbox(preSelectedFriendId);
    }
    return;
  }

  const btnConfirmCreateGroup = e.target.closest('#btn-confirm-create-group, .btn-confirm-group');
  const isCreateGroupButtonClick = modalGroup && 
    (modalGroup.style.display === 'flex' || !modalGroup.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('Tạo Nhóm');

  if (btnConfirmCreateGroup || isCreateGroupButtonClick) {
    e.preventDefault();
    const groupNameInput = document.getElementById('group-name-input') || modalGroup.querySelector('input[type="text"]');
    const groupName = groupNameInput ? groupNameInput.value.trim() : '';
    const checkedBoxes = document.querySelectorAll('.group-member-checkbox:checked, .member-checkbox:checked');
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
  const isEmojiTextClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('Cảm xúc');

  if (setEmojiBtn || isEmojiTextClick) {
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
  
  // 9. BÁO CÁO TỚI ADMIN 
  const reportBtn = e.target.closest('#set-report'); 
  const isReportTextClick = modalChatSettings && 
    (modalChatSettings.style.display === 'flex' || !modalChatSettings.classList.contains('hidden')) && 
    clickedTarget && targetText.includes('Báo cáo');

  if (reportBtn || isReportTextClick) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }

    let targetUserId = state.activeRoomId; 
    const currentUsr = getCurrentUser();
    if (targetUserId && targetUserId.includes('_DM_')) {
      const parts = targetUserId.split('_DM_');
      targetUserId = parts.find(id => id !== currentUsr?.id) || parts[0];
    }

    Swal.fire({
      title: 'Báo cáo vi phạm',
      html: `
        <div style="text-align: left; margin-bottom: 10px;">
          <label style="font-weight: 600; font-size: 14px;">Chọn lý do báo cáo:</label>
          <select id="swal-report-reason" class="swal2-input" style="margin-top: 5px; width: 100%;">
            <option value="Spam tin nhắn">Spam tin nhắn</option>
            <option value="Tài khoản giả mạo">Tài khoản giả mạo</option>
            <option value="Nội dung phản cảm">Nội dung phản cảm / Đả kích</option>
            <option value="Lý do khác">Lý do khác</option>
          </select>
        </div>
        <div style="text-align: left;">
          <label style="font-weight: 600; font-size: 14px;">Mô tả chi tiết:</label>
          <textarea id="swal-report-desc" class="swal2-textarea" placeholder="Nhập chi tiết vi phạm (tùy chọn)..." style="margin-top: 5px; width: 100%; height: 80px;"></textarea>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: 'Gửi báo cáo',
      cancelButtonText: 'Hủy',
      confirmButtonColor: '#d33',
      cancelButtonColor: '#e4e6eb',
      preConfirm: () => {
        return {
          reason: document.getElementById('swal-report-reason').value,
          description: document.getElementById('swal-report-desc').value
        };
      }
    }).then((result) => {
      if (result.isConfirmed) {
        const { reason, description } = result.value;

        socket.emit('report:submit', { 
          targetId: targetUserId, 
          reason, 
          description,
          reporterId: currentUsr?.id,
          reporterName: currentUsr?.username
        });
        
        showToast('Đã gửi báo cáo tới Admin thành công!');
      }
    });
    return;
  }
  
  // 10. CÁC NÚT TRONG MODAL CONFIRM
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

// 2. CÁC HÀM XỬ LÝ CUỘC GỌI
function answerCall() {
  const popup = document.getElementById('incoming-call-popup');
  if (popup) popup.style.display = 'none';

  if (!incomingCallDataGlobal) return;
  const isVideo = incomingCallDataGlobal.isVideo;

  navigator.mediaDevices.getUserMedia({
    video: isVideo ? { width: 1280, height: 720 } : false,
    audio: true
  }).then(stream => {
    localStream = stream;
    const videoContainer = document.getElementById('video-call-container');
    if (videoContainer) videoContainer.style.display = 'flex';

    const localVideoEl = document.getElementById('local-video');
    if (localVideoEl) {
      localVideoEl.srcObject = isVideo ? localStream : null;
      localVideoEl.style.display = isVideo ? 'block' : 'none';
    }

    peer = new SimplePeer({
      initiator: false,
      trickle: false,
      stream: localStream,
      config: peerConfig
    });

    peer.on('signal', (signalData) => {
      if (!targetUserId) {
        console.error('[CALL] Missing target user ID');
        return;
      }

      socket.emit('call_user', {
        targetUserId,
        signal: signalData,
        isVideo,
        callerName: currentUser?.username || 'Người dùng',
        callerAvatar: currentUser?.avatar || ''
      });
    });

    peer.on('stream', (remoteStream) => {
      const remoteVideoEl = document.getElementById('remote-video');
      if (remoteVideoEl) remoteVideoEl.srcObject = remoteStream;
    });

    peer.on('close', () => endCallCleanUp());
    peer.on('error', () => endCallCleanUp());

    peer.signal(incomingCallDataGlobal.signal);
  }).catch(err => {
    console.error('Media error:', err);
    if (typeof socket !== 'undefined' && incomingCallDataGlobal) {
      socket.emit('reject_call', {
        toSocketId: incomingCallDataGlobal.fromSocketId
      });
    }
    endCallCleanUp();
  });
}

function rejectCall() {
  const popup = document.getElementById('incoming-call-popup');

  if (popup) {
    popup.style.display = 'none';
    popup.classList.add('hidden');
  }

  if (incomingCallDataGlobal && typeof socket !== 'undefined') {
    socket.emit('reject_call', {
      toSocketId: incomingCallDataGlobal.fromSocketId
    });
  }

  incomingCallDataGlobal = null;
  currentCallTargetId = null;
}

function endCall() {
  if (currentCallTargetId && typeof socket !== 'undefined') {
    socket.emit('end_call', { targetId: currentCallTargetId });
  }
  endCallCleanUp();
}

function toggleAudioTrack() {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      isAudioMuted = !isAudioMuted;
      audioTrack.enabled = !isAudioMuted;
      const btn = document.getElementById('btn-toggle-mic');
      if (btn) btn.style.background = isAudioMuted ? '#ff3b30' : '#2c2c2c';
    }
  }
}

function toggleVideoTrack() {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      isVideoMuted = !isVideoMuted;
      videoTrack.enabled = !isVideoMuted;
      const btn = document.getElementById('btn-toggle-cam');
      if (btn) btn.style.background = isVideoMuted ? '#ff3b30' : '#2c2c2c';
      const localVideoEl = document.getElementById('local-video');
      if (localVideoEl) localVideoEl.style.display = isVideoMuted ? 'none' : 'block';
    }
  }
}

// Gán toàn cục ở cuối file để các nút onclick trong HTML gọi được
window.answerCall = answerCall;
window.rejectCall = rejectCall;
window.endCall = endCall;
window.toggleAudioTrack = toggleAudioTrack;
window.toggleVideoTrack = toggleVideoTrack;