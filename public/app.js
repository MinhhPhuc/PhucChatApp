const socket = io();

let state = {
  currentUser: null,
  activeRoomId: null,
  theme: localStorage.getItem('chat_theme') || 'dark',
  friends: [],
  requests: [],
  allUsers: [],
  groups: [],
  lastMessages: new Map(),
  unreadCounts: new Map(),
  searchQuery: '',
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

// --- HÀM HIỂN THỊ MODAL XÁC NHẬN ĐẸP MẮT ---
let confirmCallback = null;
function showConfirmModal(title, message, onYes) {
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('confirm-title');
  const msgEl = document.getElementById('confirm-message');
  if (!modal) {
    // Fallback nếu không tìm thấy modal thì dùng confirm thường
    if (confirm(message)) onYes();
    return;
  }
  if (titleEl) titleEl.innerText = title;
  if (msgEl) msgEl.innerText = message;
  confirmCallback = onYes;
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#btn-confirm-yes')) {
    const modal = document.getElementById('modal-confirm');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }
    if (confirmCallback) {
      confirmCallback();
      confirmCallback = null;
    }
  }
  if (e.target.closest('#btn-confirm-no')) {
    const modal = document.getElementById('modal-confirm');
    if (modal) {
      modal.classList.add('hidden');
      modal.style.display = 'none';
    }
    confirmCallback = null;
  }
});

// --- QUẢN LÝ THEME ---
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('chat_theme', theme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  }
}
document.getElementById('btn-toggle-theme').onclick = () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
};
applyTheme(state.theme);

// --- TAB ĐĂNG NHẬP / ĐĂNG KÝ ---
const tabLogin = document.getElementById('tab-btn-login');
const tabRegister = document.getElementById('tab-btn-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');

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

// --- CHỌN AVATAR ĐĂNG KÝ ---
const regAvatarFile = document.getElementById('reg-avatar-file');
const regPreviewAvatar = document.getElementById('reg-preview-avatar');
const regRandomAvatar = document.getElementById('reg-random-avatar');

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
regRandomAvatar.onclick = () => {
  const seed = Math.random().toString(36).substring(2, 9);
  state.selectedRegAvatar = `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}`;
  regPreviewAvatar.src = state.selectedRegAvatar;
};

// --- CHỌN AVATAR NHÓM ---
const groupAvatarFile = document.getElementById('group-avatar-file');
const groupPreviewAvatar = document.getElementById('group-preview-avatar');
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

formLogin.onsubmit = (e) => {
  e.preventDefault();
  socket.emit('auth:login', {
    username: document.getElementById('login-username').value,
    password: document.getElementById('login-password').value
  });
};

formRegister.onsubmit = (e) => {
  e.preventDefault();
  socket.emit('auth:register', {
    username: document.getElementById('reg-username').value,
    password: document.getElementById('reg-password').value,
    avatar: state.selectedRegAvatar
  });
};

socket.on('auth:error', (msg) => showToast(msg, false));
socket.on('auth:register_success', (msg) => {
  showToast(msg, true);
  tabLogin.click();
});

socket.on('auth:success', ({ token, user }) => {
  state.currentUser = user;
  localStorage.setItem('chat_session_token', token);
  document.getElementById('modal-auth').classList.add('hidden');
  document.getElementById('my-avatar').src = user.avatar;
  document.getElementById('my-name').innerText = user.username;
});

const savedToken = localStorage.getItem('chat_session_token');
if (savedToken) {
  socket.emit('auth:session', { userId: savedToken });
} else {
  document.getElementById('modal-auth').classList.remove('hidden');
}

document.getElementById('btn-logout').onclick = () => {
  localStorage.removeItem('chat_session_token');
  location.reload();
};

// --- TÌM KIẾM ---
const searchInput = document.getElementById('search-input');
const btnClearSearch = document.getElementById('btn-clear-search');

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

// --- GỬI TIN NHẮN VÀ EMOJI ---
const btnEmoji = document.getElementById('btn-emoji-toggle');
const emojiPicker = document.getElementById('emoji-picker');
const msgInput = document.getElementById('msg-input');

btnEmoji.onclick = (e) => { e.stopPropagation(); emojiPicker.classList.toggle('hidden'); };
document.querySelectorAll('.emoji-list span').forEach(el => {
  el.onclick = () => { msgInput.value += el.innerText; msgInput.focus(); };
});
document.onclick = (e) => {
  if (emojiPicker && !emojiPicker.contains(e.target) && e.target !== btnEmoji) {
    emojiPicker.classList.add('hidden');
  }
};

const imageUploadInput = document.getElementById('image-upload-input');
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

// --- ĐỒNG BỘ DỮ LIỆU TỪ SERVER ---
socket.on('data:sync', (data) => {
  state.friends = data.friends;
  state.requests = data.requests;
  state.allUsers = data.allUsers;
  state.groups = data.groups || [];

  state.friends.forEach(f => {
    const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
    socket.emit('messages:get', { roomId: dmRoomId });
  });
  state.groups.forEach(g => {
    socket.emit('messages:get', { roomId: g.id });
  });
  renderChatList();
  
  const modalGroupSettings = document.getElementById('modal-group-settings');
  if (modalGroupSettings && (modalGroupSettings.style.display === 'flex' || !modalGroupSettings.classList.contains('hidden'))) {
    renderGroupSettingsModal();
  }
});

socket.on('friend:incoming', () => socket.emit('auth:session', { userId: state.currentUser.id }));
socket.on('friend:updated', () => socket.emit('auth:session', { userId: state.currentUser.id }));
socket.on('group:updated', () => socket.emit('auth:session', { userId: state.currentUser.id }));
socket.on('auth:forced_logout', () => {
  localStorage.removeItem('chat_session_token');
  alert('Tài khoản của bạn đã bị quản trị viên xóa!');
  location.reload();
});

// --- RENDER DANH SÁCH CHAT ---
function renderChatList() {
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  const query = state.searchQuery;

  if (state.requests.length > 0 && !query) {
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

  if (state.groups.length > 0 && !query) {
    list.innerHTML += `<div class="chat-section-header">NHÓM CHAT (${state.groups.length})</div>`;
    state.groups.forEach(g => {
      const lastMsg = state.lastMessages.get(g.id);
      const unreadCount = state.unreadCounts.get(g.id) || 0;
      let previewText = `${g.membersCount || (g.members ? g.members.length : 0)} thành viên`;
      let timeText = '';
      if (lastMsg) {
        const time = new Date(lastMsg.timestamp);
        timeText = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
        const prefix = lastMsg.senderId === state.currentUser.id ? 'Bạn: ' : `${lastMsg.senderName}: `;
        previewText = lastMsg.type === 'image' ? `${prefix}[Hình ảnh]` : `${prefix}${lastMsg.content}`;
      }

      list.innerHTML += `
        <div class="chat-item ${unreadCount > 0 ? 'unread' : ''}" onclick="openRoom('${g.id}', '${g.name}', '${g.avatar}', '${g.membersCount || (g.members ? g.members.length : 0)} thành viên')">
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

  const filteredFriends = state.friends.filter(f => f.username.toLowerCase().includes(query));
  list.innerHTML += `<div class="chat-section-header">BẠN BÈ (${filteredFriends.length})</div>`;

  if (filteredFriends.length === 0) {
    list.innerHTML += `<div class="empty-hint">Chưa có bạn bè</div>`;
  } else {
    filteredFriends.forEach(f => {
      const dmRoomId = [state.currentUser.id, f.id].sort().join('_DM_');
      const lastMsg = state.lastMessages.get(dmRoomId);
      const unreadCount = state.unreadCounts.get(dmRoomId) || 0;

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
              <h4>${f.username}</h4>
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

  if (query) {
    const friendIds = new Set(state.friends.map(f => f.id));
    const strangers = state.allUsers.filter(u => 
      u.id !== state.currentUser.id && 
      !friendIds.has(u.id) && 
      u.username.toLowerCase().includes(query)
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

  document.getElementById('active-chat-name').innerText = name;
  document.getElementById('active-chat-status').innerText = status;
  document.getElementById('chat-screen').classList.remove('hidden');
  if(emojiPicker) emojiPicker.classList.add('hidden');
  
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
  renderChatList();
}

document.getElementById('btn-back-list').onclick = () => {
  document.getElementById('chat-screen').classList.add('hidden');
  state.activeRoomId = null;
};

// --- XỬ LÝ TIN NHẮN ---
socket.on('message:received', (msg) => {
  state.lastMessages.set(msg.roomId, { content: msg.content, timestamp: msg.timestamp, senderId: msg.sender.id, senderName: msg.sender.username, type: msg.type });
  
  if (msg.roomId === state.activeRoomId) {
    appendMessage(msg);
  } else {
    const currentUnread = state.unreadCounts.get(msg.roomId) || 0;
    state.unreadCounts.set(msg.roomId, currentUnread + 1);
  }
  renderChatList();
});

function sendMessage() {
  const content = msgInput.value.trim();
  if (content && state.activeRoomId) {
    socket.emit('message:send', { roomId: state.activeRoomId, content, type: 'text' });
    msgInput.value = '';
    if(emojiPicker) emojiPicker.classList.add('hidden');
  }
}

document.getElementById('btn-send').onclick = sendMessage;
msgInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };

function appendMessage(msg) {
  const viewport = document.getElementById('messages-viewport');
  const isSelf = msg.sender.id === state.currentUser.id;
  const div = document.createElement('div');
  div.className = `msg ${isSelf ? 'self' : 'other'}`;

  let bodyContent = msg.type === 'image' ? `<img src="${msg.content}" class="chat-image-sent" alt="Hình ảnh">` : msg.content;
  div.innerHTML = `${!isSelf ? `<strong>${msg.sender.username}</strong><br>` : ''}${bodyContent}`;
  viewport.appendChild(div);
  viewport.scrollTop = viewport.scrollHeight;
}

// =========================================================
// CÁC HÀM XỬ LÝ GIAO DIỆN NHÓM & CẬP NHẬT NGAY LẬP TỨC KHÔNG CẦN F5
// =========================================================
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
  if (!group) return;

  const isAdmin = group.adminId === state.currentUser.id;
  const countEl = document.getElementById('setting-member-count');
  if (countEl) countEl.innerText = group.members ? group.members.length : group.membersCount;
  
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

  // Xử lý cập nhật ngay lập tức giao diện client mà không cần đợi hoặc F5
  const modalGroupSettings = document.getElementById('modal-group-settings');
  if (modalGroupSettings) {
    modalGroupSettings.style.display = 'none';
    modalGroupSettings.classList.add('hidden');
  }

  if (action === 'leave' || action === 'delete_group') {
    // 1. Lọc bỏ nhóm khỏi danh sách state.groups ngay lập tức
    state.groups = state.groups.filter(g => g.id !== currentGroupId);
    
    // 2. Ẩn khung chat đi và reset activeRoomId
    document.getElementById('chat-screen').classList.add('hidden');
    state.activeRoomId = null;

    // 3. Render lại danh sách chat
    renderChatList();

    // 4. Thông báo cho người dùng
    showToast(action === 'leave' ? 'Đã rời nhóm thành công!' : 'Đã giải tán nhóm thành công!');
  }
};

// =========================================================
// BỘ ĐIỀU KHIỂN EVENT CLICK DUY NHẤT
// =========================================================
document.addEventListener('click', (e) => {
  const modalGroup = document.getElementById('modal-group');
  const modalChatSettings = document.getElementById('modal-chat-settings');
  const modalReport = document.getElementById('modal-report');
  const modalGroupSettings = document.getElementById('modal-group-settings');

  // --- 1. MỞ TẠO NHÓM TỪ NÚT CHUNG ---
  if (e.target.closest('#btn-open-group-modal') || e.target.closest('.btn-create-group')) {
    if (modalChatSettings) modalChatSettings.classList.add('hidden');
    
    if (modalGroup) {
      modalGroup.classList.remove('hidden');
      modalGroup.style.display = 'flex';
      renderGroupMembersCheckbox(null);
    }
    return;
  }

  // --- 1.1 MỞ TẠO NHÓM TỪ NÚT "Tạo nhóm cùng bạn này" TRONG MENU CÀI ĐẶT 1-1 ---
  const createGroupBtn = e.target.closest('#set-create-group');
  if (createGroupBtn) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }

    if (modalGroup) {
      modalGroup.classList.remove('hidden');
      modalGroup.style.display = 'flex';
    }

    let targetFriendId = null;
    if (state.activeRoomId && state.activeRoomId.includes('_DM_')) {
      const parts = state.activeRoomId.split('_DM_');
      targetFriendId = parts.find(id => id !== state.currentUser.id);
    }

    renderGroupMembersCheckbox(targetFriendId);
    return;
  }

  // Đóng tạo nhóm
  if (e.target.closest('#btn-close-group-modal')) {
    if (modalGroup) {
      modalGroup.classList.add('hidden');
      modalGroup.style.display = 'none';
    }
    return;
  }

  // Xác nhận tạo nhóm
  if (e.target.closest('#btn-submit-group')) {
    const groupNameInput = document.getElementById('group-name-input');
    const groupName = groupNameInput ? groupNameInput.value.trim() : '';
    if (!groupName) {
      showToast('Vui lòng nhập tên nhóm!', false);
      return;
    }
    const checkboxes = document.querySelectorAll('.group-member-checkbox:checked');
    const memberIds = Array.from(checkboxes).map(cb => cb.value);
    
    socket.emit('group:create', {
      name: groupName,
      avatar: state.selectedGroupAvatar,
      memberIds: memberIds
    });
    
    if (groupNameInput) groupNameInput.value = '';
    if (modalGroup) {
      modalGroup.classList.add('hidden');
      modalGroup.style.display = 'none';
    }
    showToast('Đang tạo nhóm...');
    return;
  }

  // --- 2. CÀI ĐẶT CHAT BẠN BÈ & BÁO CÁO ---
  if (e.target.closest('#btn-chat-options')) {
    if (modalChatSettings) {
      modalChatSettings.classList.remove('hidden');
      modalChatSettings.style.display = 'flex';
    }
    return;
  }
  if (e.target.closest('#btn-close-chat-settings')) {
    if (modalChatSettings) {
      modalChatSettings.classList.add('hidden');
      modalChatSettings.style.display = 'none';
    }
    return;
  }
  if (e.target.closest('#set-report')) {
    if (modalChatSettings) modalChatSettings.classList.add('hidden');
    if (modalReport) {
      modalReport.classList.remove('hidden');
      modalReport.style.display = 'flex';
    }
    return;
  }
  if (e.target.closest('#btn-cancel-report')) {
    if (modalReport) modalReport.classList.add('hidden');
    return;
  }
  if (e.target.closest('#btn-submit-report')) {
    const reasonSelect = document.getElementById('report-reason-select');
    const reason = reasonSelect ? reasonSelect.value : 'Vi phạm';
    showToast("Đã gửi báo cáo thành công với lý do: " + reason, true);
    if (modalReport) modalReport.classList.add('hidden');
    return;
  }

  // --- 3. CÀI ĐẶT NHÓM CHAT ---
  if (e.target.closest('#btn-group-settings')) {
    renderGroupSettingsModal();
    if (modalGroupSettings) {
      modalGroupSettings.classList.remove('hidden');
      modalGroupSettings.style.display = 'flex';
    }
    return;
  }
  if (e.target.closest('#btn-close-group-settings')) {
    if (modalGroupSettings) {
      modalGroupSettings.style.display = 'none';
      modalGroupSettings.classList.add('hidden');
      const addSection = document.getElementById('add-member-section');
      if (addSection) addSection.classList.add('hidden');
    }
    return;
  }

  // --- SỬA SỰ KIỆN RỜI NHÓM & GIẢI TÁN NHÓM VỚI MODAL XÁC NHẬN ĐẸP MẮT & CẬP NHẬT TRỰC TIẾP ---
  if (e.target.closest('#btn-leave-group')) {
    showConfirmModal(
      'Xác nhận rời nhóm',
      'Bạn có chắc chắn muốn rời khỏi nhóm này không?',
      () => execGroupAction('leave', null)
    );
    return;
  }

  if (e.target.closest('#btn-delete-group')) {
    showConfirmModal(
      'Xác nhận giải tán nhóm',
      'Hành động này sẽ xóa vĩnh viễn nhóm đối với tất cả thành viên. Bạn có chắc chắn muốn giải tán?',
      () => execGroupAction('delete_group', null)
    );
    return;
  }

  // --- 4. THÊM THÀNH VIÊN VÀO NHÓM ---
  if (e.target.closest('#btn-show-add-member')) {
    const group = state.groups.find(g => g.id === state.activeRoomId);
    if (!group) return;
    
    const addSection = document.getElementById('add-member-section');
    const listDiv = document.getElementById('add-member-list');
    if (!addSection || !listDiv) return;
    
    listDiv.innerHTML = '';
    const memberIdsInGroup = new Set((group.members || []).map(m => String(m.id)));
    const friendsNotInGroup = state.friends.filter(f => !memberIdsInGroup.has(String(f.id)));

    if (friendsNotInGroup.length === 0) {
      listDiv.innerHTML = '<div style="font-size:13px; color:#718096; text-align:center;">Tất cả bạn bè đều đã ở trong nhóm!</div>';
    } else {
      friendsNotInGroup.forEach(f => {
        listDiv.innerHTML += `
          <label style="display:flex; align-items:center; gap:10px; margin-bottom:8px; cursor:pointer; padding:4px; background:#fff; border-radius:4px; border:1px solid #edf2f7;">
            <input type="checkbox" class="add-member-checkbox" value="${f.id}" style="width:16px; height:16px;">
            <img src="${f.avatar}" style="width:28px; height:28px; border-radius:50%;">
            <span style="font-size:14px; font-weight:500;">${f.username}</span>
          </label>
        `;
      });
    }
    addSection.classList.remove('hidden');
    return;
  }
  if (e.target.closest('#btn-cancel-add-member')) {
    const addSection = document.getElementById('add-member-section');
    if (addSection) addSection.classList.add('hidden');
    return;
  }
  if (e.target.closest('#btn-confirm-add-member')) {
    const checkboxes = document.querySelectorAll('.add-member-checkbox:checked');
    const newMemberIds = Array.from(checkboxes).map(cb => cb.value);
    if (newMemberIds.length > 0) {
      socket.emit('group:add_members', { groupId: state.activeRoomId, newMemberIds: newMemberIds });
      const addSection = document.getElementById('add-member-section');
      if (addSection) addSection.classList.add('hidden');
      showToast('Đã thêm thành viên thành công!');
    } else {
      showToast('Vui lòng chọn ít nhất một người bạn!', false);
    }
    return;
  }

  // --- 5. BẤM RA NGOÀI ĐỂ ĐÓNG BẢNG ---
  if (modalChatSettings && e.target === modalChatSettings) modalChatSettings.classList.add('hidden');
  if (modalReport && e.target === modalReport) modalReport.classList.add('hidden');
});