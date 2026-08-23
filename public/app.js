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

// --- MODAL TẠO NHÓM ---
const modalGroup = document.getElementById('modal-group');

document.getElementById('btn-open-group-modal').onclick = () => {
  modalGroup.classList.remove('hidden');
  modalGroup.style.display = 'flex';
  renderGroupMembersCheckbox();
};

document.getElementById('btn-close-group-modal').onclick = () => {
  modalGroup.classList.add('hidden');
  modalGroup.style.display = 'none';
};

function renderGroupMembersCheckbox() {
  const container = document.getElementById('group-members-list');
  container.innerHTML = '';
  if (state.friends.length === 0) {
    container.innerHTML = '<p style="font-size: 13px; color: #718096; text-align: center;">Chưa có bạn bè để thêm vào nhóm</p>';
    return;
  }
  state.friends.forEach(f => {
    container.innerHTML += `
      <label class="member-checkbox-item">
        <input type="checkbox" value="${f.id}" class="group-member-checkbox" style="width: 16px; height: 16px;">
        <img src="${f.avatar}" style="width: 28px; height: 28px; border-radius: 50%;">
        <span style="font-size: 14px;">${f.username}</span>
      </label>
    `;
  });
}

document.getElementById('btn-submit-group').onclick = () => {
  const groupName = document.getElementById('group-name-input').value.trim();
  if (!groupName) {
    alert('Vui lòng nhập tên nhóm!');
    return;
  }
  const checkboxes = document.querySelectorAll('.group-member-checkbox:checked');
  const memberIds = Array.from(checkboxes).map(cb => cb.value);

  socket.emit('group:create', {
    name: groupName,
    avatar: state.selectedGroupAvatar,
    memberIds
  });

  document.getElementById('group-name-input').value = '';
  modalGroup.style.display = 'none';
  showToast('Đã tạo nhóm thành công!');
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

const btnEmoji = document.getElementById('btn-emoji-toggle');
const emojiPicker = document.getElementById('emoji-picker');
const msgInput = document.getElementById('msg-input');

btnEmoji.onclick = (e) => { e.stopPropagation(); emojiPicker.classList.toggle('hidden'); };
document.querySelectorAll('.emoji-list span').forEach(el => {
  el.onclick = () => { msgInput.value += el.innerText; msgInput.focus(); };
});
document.onclick = (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== btnEmoji) emojiPicker.classList.add('hidden');
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
  
  // Tự động vẽ lại bảng cài đặt nhóm nếu đang mở
  const modalGroupSettings = document.getElementById('modal-group-settings');
  if (modalGroupSettings && modalGroupSettings.style.display === 'flex') {
    renderGroupSettingsModal();
  }
});

socket.on('friend:incoming', () => socket.emit('auth:session', { userId: state.currentUser.id }));
socket.on('friend:updated', () => socket.emit('auth:session', { userId: state.currentUser.id }));
socket.on('group:updated', () => socket.emit('auth:session', { userId: state.currentUser.id }));

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
      list.innerHTML += `<div class="chat-section-header">NGƯỜI DÙNG KHÁC TRÊN HỆ THỐNG</div>`;
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

function openRoom(roomId, name, avatar, status) {
  state.activeRoomId = roomId;
  state.unreadCounts.set(roomId, 0);

  document.getElementById('active-chat-name').innerText = name;
  document.getElementById('active-chat-status').innerText = status;
  document.getElementById('chat-screen').classList.remove('hidden');
  emojiPicker.classList.add('hidden');
  
  const btnSettings = document.getElementById('btn-group-settings');
  if (roomId.startsWith('grp_')) {
    btnSettings.classList.remove('hidden');
  } else {
    btnSettings.classList.add('hidden');
  }
  
  socket.emit('messages:get', { roomId });
  renderChatList();
}

socket.on('messages:history', ({ roomId, messages }) => {
  if (messages.length > 0) {
    const last = messages[messages.length - 1];
    state.lastMessages.set(roomId, { content: last.content, timestamp: last.timestamp, senderId: last.sender.id, senderName: last.sender.username, type: last.type });
  }
  if (roomId === state.activeRoomId) {
    const viewport = document.getElementById('messages-viewport');
    viewport.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
  }
  renderChatList();
});

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
    emojiPicker.classList.add('hidden');
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

function acceptFriend(reqId) { socket.emit('friend:accept', { reqId }); }

document.getElementById('btn-back-list').onclick = () => {
  document.getElementById('chat-screen').classList.add('hidden');
  state.activeRoomId = null;
};

socket.on('auth:forced_logout', () => {
  localStorage.removeItem('chat_session_token');
  alert('Tài khoản của bạn đã bị quản trị viên xóa!');
  location.reload();
});

// --- QUẢN LÝ CÀI ĐẶT NHÓM ---
const modalGroupSettings = document.getElementById('modal-group-settings');
const btnSettings = document.getElementById('btn-group-settings');
const btnLeave = document.getElementById('btn-leave-group');
const btnDeleteGroup = document.getElementById('btn-delete-group');

function renderGroupSettingsModal() {
  const group = state.groups.find(g => g.id === state.activeRoomId);
  if (!group) return;

  const isAdmin = group.adminId === state.currentUser.id;
  document.getElementById('setting-member-count').innerText = group.members ? group.members.length : group.membersCount;
  
  if (isAdmin) {
    btnDeleteGroup.classList.remove('hidden');
  } else {
    btnDeleteGroup.classList.add('hidden');
  }

  const listContainer = document.getElementById('setting-members-list');
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

btnSettings.onclick = () => {
  renderGroupSettingsModal();
  modalGroupSettings.classList.remove('hidden');
  modalGroupSettings.style.display = 'flex';
};

document.getElementById('btn-close-group-settings').onclick = () => {
  modalGroupSettings.style.display = 'none';
  document.getElementById('add-member-section').classList.add('hidden');
};

btnLeave.onclick = () => execGroupAction('leave', null);
btnDeleteGroup.onclick = () => {
  if (confirm('Bạn có chắc chắn muốn giải tán nhóm này không?')) execGroupAction('delete_group', null);
};

window.execGroupAction = function(action, targetId) {
  socket.emit('group:action', { action, groupId: state.activeRoomId, targetId });
};

socket.on('message:error', (msg) => showToast(msg, false));

socket.on('group:kicked_out', () => {
  modalGroupSettings.style.display = 'none';
  document.getElementById('chat-screen').classList.add('hidden');
  state.activeRoomId = null;
  socket.emit('auth:session', { userId: state.currentUser.id });
  showToast('Bạn đã rời khỏi nhóm hoặc nhóm đã bị giải tán.', false);
});

// --- CHỨC NĂNG THÊM THÀNH VIÊN VÀO NHÓM ---
document.getElementById('btn-show-add-member').onclick = () => {
  const group = state.groups.find(g => g.id === state.activeRoomId);
  if (!group) return;

  const addSection = document.getElementById('add-member-section');
  const listDiv = document.getElementById('add-member-list');
  listDiv.innerHTML = '';

  const memberIdsInGroup = new Set((group.members || []).map(m => String(m.id)));
  const friendsNotInGroup = state.friends.filter(f => !memberIdsInGroup.has(String(f.id)));

  if (friendsNotInGroup.length === 0) {
    listDiv.innerHTML = '<div style="font-size:13px; color:#718096; text-align:center;">Tất cả bạn bè của bạn đều đã ở trong nhóm này!</div>';
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
};

document.getElementById('btn-cancel-add-member').onclick = () => {
  document.getElementById('add-member-section').classList.add('hidden');
};

document.getElementById('btn-confirm-add-member').onclick = () => {
  const checkboxes = document.querySelectorAll('.add-member-checkbox:checked');
  const newMemberIds = Array.from(checkboxes).map(cb => cb.value);

  if (newMemberIds.length > 0) {
    socket.emit('group:add_members', {
      groupId: state.activeRoomId,
      newMemberIds: newMemberIds
    });
    
    document.getElementById('add-member-section').classList.add('hidden');
    showToast('Đã thêm thành viên thành công!');
  } else {
    showToast('Vui lòng chọn ít nhất một người bạn!', false);
  }
};