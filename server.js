const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const ngrok = require('ngrok');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7 // 10MB
});

app.use(express.json({ limit: '10mb' }));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==========================================
// HỆ THỐNG LƯU TRỮ DATABASE TỰ ĐỘNG
// ==========================================
function replacer(key, value) {
  if (value instanceof Map) return { dataType: 'Map', value: Array.from(value.entries()) };
  if (value instanceof Set) return { dataType: 'Set', value: Array.from(value) };
  return value;
}

function reviver(key, value) {
  if (typeof value === 'object' && value !== null) {
    if (value.dataType === 'Map') return new Map(value.value);
    if (value.dataType === 'Set') return new Set(value.value);
  }
  return value;
}

let DB = {
  accounts: new Map(),       // username -> { id, username, password, avatar }
  users: new Map(),          // userId -> user status object
  friendRequests: new Map(), // reqId -> request object
  friends: new Map(),        // userId -> Set(friendUserIds)
  messages: new Map(),       // roomId -> array of messages
  groups: new Map(),         // groupId -> { id, name, avatar, members: Set() }
  clearedChats: new Map()    // `${userId}_${roomId}` -> timestamp (Lưu mốc xóa cá nhân)
};

function loadDB() {
  try {
    if (fs.existsSync('database.json')) {
      const data = fs.readFileSync('database.json', 'utf8');
      DB = JSON.parse(data, reviver);
      if (!DB.clearedChats) DB.clearedChats = new Map();
      console.log('✅ Đã nạp dữ liệu cũ từ database.json');
      
      // Reset trạng thái online về offline khi khởi động lại server
      DB.users.forEach(user => user.status = 'offline');
    } else {
      console.log('⚠️ Không tìm thấy database.json, sẽ tạo mới khi có dữ liệu.');
    }
  } catch (err) {
    console.error('❌ Lỗi khi đọc file Database:', err);
  }
}

function saveDB() {
  try {
    fs.writeFileSync('database.json', JSON.stringify(DB, replacer, 2));
  } catch (err) {
    console.error('❌ Lỗi khi lưu file Database:', err);
  }
}

loadDB();
// ==========================================

app.get('/api/admin/data', (req, res) => {
  const accounts = Array.from(DB.accounts.values()).map(acc => ({
    id: acc.id,
    username: acc.username,
    avatar: acc.avatar,
    status: DB.users.get(acc.id)?.status || 'offline'
  }));

  let totalMessages = 0;
  DB.messages.forEach(msgs => { totalMessages += msgs.length; });

  res.json({
    accounts,
    stats: {
      totalUsers: accounts.length,
      totalGroups: DB.groups.size,
      totalMessages: totalMessages
    }
  });
});

app.delete('/api/admin/user/:id', (req, res) => {
  const userId = req.params.id;
  let targetUsername = null;

  for (let [username, acc] of DB.accounts.entries()) {
    if (acc.id === userId) {
      targetUsername = username;
      break;
    }
  }

  if (targetUsername) {
    DB.accounts.delete(targetUsername);
    DB.users.delete(userId);
    DB.friends.delete(userId);
    DB.groups.forEach(group => {
      group.members.delete(userId);
    });

    io.to(userId).emit('auth:forced_logout');
    saveDB();

    return res.json({ success: true, message: 'Đã xóa tài khoản thành công!' });
  }

  res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  let currentUser = null;

  // --- 1. XÓA TIN NHẮN PHÍA CÁ NHÂN (LƯU VÀO DATABASE.JSON) ---
  socket.on('messages:clear_me', ({ roomId }) => {
    if (!currentUser || !roomId) return;

    const clearKey = `${currentUser.id}_${roomId}`;
    DB.clearedChats.set(clearKey, Date.now());
    saveDB(); // Lưu vết mốc thời gian vào database.json

    socket.emit('messages:cleared_me', { roomId });
  });

  // --- 2. XÓA DỮ LIỆU TẤT CẢ (LỆNH TOÀN CẦU) ---
  socket.on('messages:clear', ({ roomId }) => {
    if (!roomId) return;

    DB.messages.set(roomId, []);
    saveDB();

    if (roomId.startsWith('grp_')) {
      io.to(roomId).emit('messages:cleared', { roomId });
    } else {
      const parts = roomId.split('_DM_');
      if (parts.length === 2) {
        io.to(parts[0]).to(parts[1]).emit('messages:cleared', { roomId });
      } else {
        socket.emit('messages:cleared', { roomId });
      }
    }
  });

  // --- 3. LẤY LỊCH SỬ TIN NHẮN (ĐÃ LỌC THEO MỐC XÓA CỦA USER) ---
  socket.on('messages:get', ({ roomId }) => {
    if (!currentUser) return;

    const msgs = DB.messages.get(roomId) || [];
    const clearKey = `${currentUser.id}_${roomId}`;
    const clearedAt = DB.clearedChats.get(clearKey) || 0;

    // Chỉ lấy các tin nhắn được gửi SAU thời điểm user bấm xóa cá nhân
    const filteredMsgs = msgs.filter(m => {
      const msgTime = typeof m.timestamp === 'number' ? m.timestamp : new Date(m.timestamp).getTime();
      return msgTime > clearedAt;
    });

    socket.emit('messages:history', { roomId, messages: filteredMsgs });
  });

  // --- CÁC THAO TÁC QUẢN LÝ NHÓM ---
  socket.on('group:action', ({ action, groupId, targetId }) => {
    if (!currentUser) return;
    const group = DB.groups.get(groupId);
    if (!group || !group.members.has(currentUser.id)) return;

    const isAdmin = group.adminId === currentUser.id;

    if (action === 'leave') {
      if (isAdmin && group.members.size > 1) {
        group.members.delete(currentUser.id);
        const nextMemberId = Array.from(group.members)[0];
        group.adminId = nextMemberId;
      } else {
        group.members.delete(currentUser.id);
      }

      socket.leave(groupId);
      io.to(currentUser.id).emit('group:kicked_out'); 
      Array.from(group.members).forEach(mId => io.to(mId).emit('group:updated'));
      
      if (group.members.size === 0) {
        DB.groups.delete(groupId);
      }
      
      saveDB();
      return;
    }

    if (!isAdmin) return socket.emit('message:error', 'Bạn không có quyền thực hiện thao tác này!');

    if (action === 'delete_group') {
      const allMembers = Array.from(group.members);
      DB.groups.delete(groupId);
      allMembers.forEach(mId => io.to(mId).emit('group:kicked_out'));
      saveDB();
      return;
    }

    if (!targetId || targetId === currentUser.id) return;

    if (action === 'kick') {
      group.members.delete(targetId);
      group.muted.delete(targetId);
      io.to(targetId).emit('group:kicked_out');
    } else if (action === 'mute') {
      group.muted.add(targetId);
    } else if (action === 'unmute') {
      group.muted.delete(targetId);
    } else if (action === 'transfer_admin') {
      group.adminId = targetId;
    }

    saveDB();
    Array.from(group.members).forEach(mId => io.to(mId).emit('group:updated'));
  });

  socket.on('group:add_members', ({ groupId, newMemberIds }) => {
    if (!currentUser || !groupId || !newMemberIds || newMemberIds.length === 0) return;

    let group = null;
    if (DB.groups instanceof Map) {
      group = DB.groups.get(groupId);
    } else if (Array.isArray(DB.groups)) {
      group = DB.groups.find(g => String(g.id) === String(groupId));
    }

    if (!group) return;
    let isAdded = false;

    newMemberIds.forEach(rawId => {
      const membersList = Array.from(group.members || []);
      const alreadyInGroup = membersList.some(mId => String(mId) === String(rawId));

      if (!alreadyInGroup) {
        if (Array.isArray(group.members)) {
          group.members.push(rawId);
        } else if (group.members instanceof Set) {
          group.members.add(rawId);
        } else {
          group.members = [rawId];
        }
        isAdded = true;
      }
    });

    if (isAdded) {
      saveDB();
      io.emit('group:updated');
    }
  });

  // --- AUTHENTICATION ---
  socket.on('auth:register', ({ username, password, avatar }) => {
    if (!username || !password) {
      return socket.emit('auth:error', 'Vui lòng nhập đầy đủ tên tài khoản và mật khẩu!');
    }
    
    const cleanUsername = username.trim();
    if (DB.accounts.has(cleanUsername)) {
      return socket.emit('auth:error', 'Tài khoản này đã tồn tại, vui lòng chọn tên khác!');
    }

    const userId = `usr_${Math.random().toString(36).substr(2, 9)}`;
    const userAvatar = avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(cleanUsername)}`;
    const account = { id: userId, username: cleanUsername, password, avatar: userAvatar };

    DB.accounts.set(cleanUsername, account);
    DB.friends.set(userId, new Set());
    DB.users.set(userId, { id: userId, username: cleanUsername, avatar: userAvatar, status: 'online' });

    saveDB();
    socket.emit('auth:register_success', 'Tạo tài khoản thành công! Vui lòng đăng nhập.');
  });

  socket.on('auth:login', ({ username, password }) => {
    const cleanUsername = username ? username.trim() : '';
    const acc = DB.accounts.get(cleanUsername);
    
    if (!acc || acc.password !== password) {
      return socket.emit('auth:error', 'Tài khoản hoặc mật khẩu không chính xác!');
    }

    let user = DB.users.get(acc.id);
    if (!user) {
      user = { id: acc.id, username: acc.username, avatar: acc.avatar, status: 'online' };
      DB.users.set(acc.id, user);
    } else {
      user.status = 'online';
      user.avatar = acc.avatar;
    }

    currentUser = user;
    socket.join(user.id);

    DB.groups.forEach((group, groupId) => {
      if (group.members.has(user.id)) {
        socket.join(groupId);
      }
    });

    socket.emit('auth:success', { token: user.id, user });
    syncUserData(socket, user.id);
    io.emit('users:sync', Array.from(DB.users.values()));
  });

  socket.on('auth:session', ({ userId }) => {
    let foundAcc = null;
    for (let acc of DB.accounts.values()) {
      if (acc.id === userId) { foundAcc = acc; break; }
    }

    if (!foundAcc) return socket.emit('auth:session_invalid');

    let user = DB.users.get(userId) || { id: foundAcc.id, username: foundAcc.username, avatar: foundAcc.avatar, status: 'online' };
    user.status = 'online';
    user.avatar = foundAcc.avatar;
    DB.users.set(userId, user);

    currentUser = user;
    socket.join(user.id);

    DB.groups.forEach((group, groupId) => {
      if (group.members.has(user.id)) {
        socket.join(groupId);
      }
    });

    socket.emit('auth:success', { token: user.id, user });
    syncUserData(socket, user.id);
    io.emit('users:sync', Array.from(DB.users.values()));
  });

  // --- TẠO NHÓM CHAT ---
  socket.on('group:create', ({ name, avatar, memberIds }) => {
    if (!currentUser || !name || !memberIds) return;
    const groupId = `grp_${Math.random().toString(36).substr(2, 9)}`;
    const groupAvatar = avatar || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(name)}`;
    
    const membersSet = new Set([currentUser.id, ...memberIds]);
    const groupObj = {
      id: groupId,
      name,
      avatar: groupAvatar,
      members: membersSet,
      adminId: currentUser.id,
      muted: new Set()
    };

    DB.groups.set(groupId, groupObj);
    saveDB();

    membersSet.forEach(mId => {
      io.to(mId).emit('group:updated');
    });
    syncUserData(socket, currentUser.id);
  });

  // --- PHẠM VI BẠN BÈ ---
  socket.on('friend:request', ({ targetUserId }) => {
    if (!currentUser || currentUser.id === targetUserId) return;
    const reqId = `freq_${currentUser.id}_${targetUserId}`;

    DB.friendRequests.set(reqId, {
      id: reqId,
      fromUserId: currentUser.id,
      fromUsername: currentUser.username,
      fromAvatar: currentUser.avatar,
      toUserId: targetUserId,
      status: 'pending'
    });

    saveDB();
    io.to(targetUserId).emit('friend:incoming');
    syncUserData(socket, currentUser.id);
  });

  socket.on('friend:accept', ({ reqId }) => {
    const req = DB.friendRequests.get(reqId);
    if (!req || req.status !== 'pending') return;

    req.status = 'accepted';
    if (!DB.friends.has(req.fromUserId)) DB.friends.set(req.fromUserId, new Set());
    if (!DB.friends.has(req.toUserId)) DB.friends.set(req.toUserId, new Set());

    DB.friends.get(req.fromUserId).add(req.toUserId);
    DB.friends.get(req.toUserId).add(req.fromUserId);

    saveDB();
    syncUserData(socket, req.fromUserId);
    syncUserData(socket, req.toUserId);
    io.to(req.fromUserId).emit('friend:updated');
    io.to(req.toUserId).emit('friend:updated');
  });

  // --- GỬI TIN NHẮN ---
  socket.on('message:send', ({ roomId, content, type = 'text' }) => {
    if (!currentUser || !content) return;

    if (roomId.startsWith('grp_')) {
      const group = DB.groups.get(roomId);
      if (group && group.muted.has(currentUser.id)) {
        return socket.emit('message:error', 'Bạn đã bị quản trị viên cấm chat trong nhóm này!');
      }
    }
    
    const msg = {
      id: `msg_${Math.random().toString(36).substr(2, 9)}`,
      roomId,
      sender: currentUser,
      content,
      type,
      timestamp: Date.now()
    };

    if (!DB.messages.has(roomId)) DB.messages.set(roomId, []);
    DB.messages.get(roomId).push(msg);

    saveDB();

    if (roomId.startsWith('grp_')) {
      io.to(roomId).emit('message:received', msg);
    } else {
      const parts = roomId.split('_DM_');
      if (parts.length === 2) {
        io.to(parts[0]).to(parts[1]).emit('message:received', msg);
      }
    }
  });

  socket.on('disconnect', () => {
    if (currentUser) {
      currentUser.status = 'offline';
      io.emit('users:sync', Array.from(DB.users.values()));
    }
  });

  socket.on('friend:unfriend', async ({ friendId }) => {
  try {
    // 1. Lấy ID của người dùng đang đăng nhập
    const currentUserId = socket.userId || (socket.user && socket.user.id);
    if (!currentUserId || !friendId) return;

    // --- 2. CODE XÓA BẠN BÈ TRONG DATABASE CỦA BẠN ---
    // (Hãy chọn cách phù hợp với Database bạn đang dùng trên server):

    // * Nếu dùng MongoDB / Mongoose:
    await User.findByIdAndUpdate(currentUserId, { $pull: { friends: friendId } });
    await User.findByIdAndUpdate(friendId, { $pull: { friends: currentUserId } });

    // * Hoặc nếu bạn dùng file JSON (ví dụ mảng users):
    /*
    const userA = users.find(u => u.id === currentUserId);
    const userB = users.find(u => u.id === friendId);
    if (userA) userA.friends = userA.friends.filter(id => id !== friendId);
    if (userB) userB.friends = userB.friends.filter(id => id !== currentUserId);
    // Lưu lại file json của bạn ở đây...
    */
    // ------------------------------------------------

    // 3. Báo cho cả 2 phía cập nhật lại dữ liệu mới nhất từ server
    io.to(currentUserId).emit('friend:updated');
    io.to(friendId).emit('friend:updated');

  } catch (error) {
    console.error('Lỗi khi xóa kết bạn trên server:', error);
  }
});

});

function syncUserData(socket, userId) {
  const friendSet = DB.friends.get(userId) || new Set();
  const friendsList = Array.from(friendSet).map(id => {
    let acc = null;
    for (let a of DB.accounts.values()) { if (a.id === id) acc = a; }
    const statusObj = DB.users.get(id);
    return acc ? { ...acc, status: statusObj ? statusObj.status : 'offline' } : null;
  }).filter(Boolean);

  const incomingRequests = Array.from(DB.friendRequests.values())
    .filter(r => r.toUserId === userId && r.status === 'pending');

  const allRegisteredUsers = Array.from(DB.accounts.values()).map(a => ({
    id: a.id,
    username: a.username,
    avatar: a.avatar,
    status: DB.users.get(a.id)?.status || 'offline'
  }));

  const userGroups = [];
  DB.groups.forEach(group => {
    if (group.members.has(userId)) {
      const memberDetails = Array.from(group.members).map(mId => {
        let acc = null;
        for (let a of DB.accounts.values()) { if (a.id === mId) acc = a; }
        return acc ? { id: mId, username: acc.username, avatar: acc.avatar, isMuted: group.muted.has(mId) } : null;
      }).filter(Boolean);

      userGroups.push({
        id: group.id,
        name: group.name,
        avatar: group.avatar,
        membersCount: group.members.size,
        adminId: group.adminId,
        members: memberDetails
      });
    }
  });   

  socket.emit('data:sync', {
    friends: friendsList,
    requests: incomingRequests,
    allUsers: allRegisteredUsers,
    groups: userGroups
  });
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`[*] Web Chat Engine Online on port ${PORT}`);

  if (process.env.NODE_ENV !== 'production') {
    try {
      const ngrok = require('ngrok');
      const url = await ngrok.connect({ addr: PORT, authtoken_from_env: true });
      console.log(`> 🌐 Link Ngrok (Local): ${url}`);
    } catch (error) {
      console.log('Không bật ngrok (chạy trên cloud hoặc lỗi token).');
    }
  }
});