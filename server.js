const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const ngrok = require('ngrok');

const app = express();
const helmet = require('helmet');

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'", "*", "data:", "blob:"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "*"],
      styleSrc: ["'self'", "'unsafe-inline'", "*"],
      connectSrc: ["'self'", "*", "wss:", "ws:"],
      imgSrc: ["'self'", "*", "data:", "blob:"],
    },
  })
);

const server = http.createServer(app);

// --- CẤU HÌNH CONTENT SECURITY POLICY (CSP) ---
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "script-src 'self' * 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' * 'unsafe-inline'; " +
    "connect-src * wss: ws:;"
  );
  next();
});

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
  clearedChats: new Map(),   // `${userId}_${roomId}` -> timestamp
  reports: new Map(),        // reportId -> report object
  appeals: new Map()         // appealId -> appeal object
};

function loadDB() {
  try {
    if (fs.existsSync('database.json')) {
      const data = fs.readFileSync('database.json', 'utf8');
      DB = JSON.parse(data, reviver);
      if (!DB.clearedChats) DB.clearedChats = new Map();
      if (!DB.reports) DB.reports = new Map();
      if (!DB.appeals) DB.appeals = new Map();
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

// --- API QUẢN TRỊ VIÊN (ADMIN) ---
app.get('/api/admin/data', (req, res) => {
  let totalMessages = 0;
  DB.messages.forEach(msgs => { totalMessages += msgs.length; });

  const accountsList = Array.from(DB.accounts.values()).map(acc => {
    const userObj = DB.users.get(acc.id);
    return {
      id: acc.id,
      username: acc.username,
      avatar: acc.avatar,
      status: userObj ? userObj.status : 'offline'
    };
  });

  res.json({
    stats: {
      totalUsers: DB.accounts.size,
      totalGroups: DB.groups.size,
      totalMessages: totalMessages
    },
    accounts: accountsList
  });
});

app.get('/api/admin/reports', (req, res) => {
  if (!DB.reports) return res.json([]);
  res.json(Array.from(DB.reports.values()));
});

app.get('/api/admin/appeals', (req, res) => {
  if (!DB.appeals) return res.json([]);
  res.json(Array.from(DB.appeals.values()));
});

// Hạn chế người dùng 24h
app.post('/api/admin/user/:id/restrict', (req, res) => {
  const userId = req.params.id;
  const userObj = DB.users.get(userId);
  if (userObj) {
    userObj.restrictedUntil = Date.now() + 24 * 60 * 60 * 1000;
    saveDB();
    io.to(userId).emit('auth:restricted', 'Tài khoản của bạn đã bị hạn chế nhắn tin trong 24 giờ do vi phạm nội quy.');
    return res.json({ success: true, message: 'Đã hạn chế người dùng 24h thành công!' });
  }
  res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
});

// Gỡ hoàn toàn hạn chế
app.post('/api/admin/user/:id/lift-restriction', (req, res) => {
  const userId = req.params.id;
  const userObj = DB.users.get(userId);
  if (userObj) {
    delete userObj.restrictedUntil;
    saveDB();
    io.to(userId).emit('auth:unrestricted', 'Tài khoản của bạn đã được gỡ hạn chế nhắn tin.');
    return res.json({ success: true, message: 'Đã gỡ hạn chế thành công!' });
  }
  res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
});

// Giảm thời gian hạn chế
app.post('/api/admin/user/:id/reduce-restriction', (req, res) => {
  const userId = req.params.id;
  const { hours } = req.body;
  const userObj = DB.users.get(userId);
  if (userObj && userObj.restrictedUntil) {
    const reduceMs = (hours || 0) * 60 * 60 * 1000;
    userObj.restrictedUntil = Math.max(Date.now(), userObj.restrictedUntil - reduceMs);
    if (userObj.restrictedUntil <= Date.now()) {
      delete userObj.restrictedUntil;
    }
    saveDB();
    return res.json({ success: true, message: `Đã giảm ${hours} giờ hạn chế thành công!` });
  }
  res.status(404).json({ success: false, message: 'Không tìm thấy người dùng hoặc tài khoản không có hạn chế!' });
});

// Xóa báo cáo
app.delete('/api/admin/report/:id', (req, res) => {
  const reportId = req.params.id;
  if (DB.reports.has(reportId)) {
    DB.reports.delete(reportId);
    saveDB();
    return res.json({ success: true, message: 'Đã xóa báo cáo!' });
  }
  res.status(404).json({ success: false, message: 'Không tìm thấy báo cáo!' });
});

// Xóa tài khoản
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
    DB.groups.forEach(group => { group.members.delete(userId); });

    io.to(userId).emit('auth:forced_logout');
    saveDB();
    return res.json({ success: true, message: 'Đã xóa tài khoản thành công!' });
  }

  res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
});

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// HÀM ĐỒNG BỘ DỮ LIỆU NGƯỜI DÙNG CHUẨN HOÁ
// ==========================================
function syncUserData(target, userId) {
  if (!target || !userId) return;

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

  const payload = {
    friends: friendsList,
    requests: incomingRequests,
    allUsers: allRegisteredUsers,
    groups: userGroups
  };

  if (typeof target.emit === 'function') {
    target.emit('data:sync', payload);
    target.emit('receive_friend_requests', incomingRequests);
  } else {
    io.to(userId).emit('data:sync', payload);
    io.to(userId).emit('receive_friend_requests', incomingRequests);
  }
}

// ==========================================
// SOCKET.IO REAL-TIME HANDLING
// ==========================================
io.on('connection', (socket) => {
  let currentUser = null;

  // --- LOGIC VIDEO CALL ---
  socket.on("call_user", (data) => {
    io.to(data.userToCall).emit("incoming_call", { 
      signal: data.signalData, 
      from: socket.id, 
      name: data.callerName 
    });
  });

  socket.on("answer_call", (data) => {
    io.to(data.to).emit("call_accepted", data.signal);
  });

  socket.on("end_call", (data) => {
    io.to(data.to).emit("call_ended");
  });
  
  // Admin Room
  socket.on('join_admin_room', (userData) => {
    if (userData && userData.isAdmin) {
      socket.join('admin_room');
    }
  });

  // --- XÓA TIN NHẮN ---
  socket.on('messages:clear_me', ({ roomId }) => {
    if (!currentUser || !roomId) return;
    const clearKey = `${currentUser.id}_${roomId}`;
    DB.clearedChats.set(clearKey, Date.now());
    saveDB();
    socket.emit('messages:cleared_me', { roomId });
  });

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

  // --- LẤY LỊCH SỬ TIN NHẮN ---
  socket.on('messages:get', ({ roomId }) => {
    if (!currentUser) return;
    const msgs = DB.messages.get(roomId) || [];
    const clearKey = `${currentUser.id}_${roomId}`;
    const clearedAt = DB.clearedChats.get(clearKey) || 0;

    const filteredMsgs = msgs.filter(m => {
      const msgTime = typeof m.timestamp === 'number' ? m.timestamp : new Date(m.timestamp).getTime();
      return msgTime > clearedAt;
    });

    socket.emit('messages:history', { roomId, messages: filteredMsgs });
  });

  // --- QUẢN LÝ NHÓM ---
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
      
      if (group.members.size === 0) DB.groups.delete(groupId);
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
    const group = DB.groups.get(groupId);
    if (!group) return;

    let isAdded = false;
    newMemberIds.forEach(rawId => {
      if (!group.members.has(rawId)) {
        group.members.add(rawId);
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
      return socket.emit('auth:error', 'Tài khoản này đã tồn tại!');
    }

    const userId = `usr_${Math.random().toString(36).substr(2, 9)}`;
    const userAvatar = avatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(cleanUsername)}`;
    const account = { id: userId, username: cleanUsername, password, avatar: userAvatar };

    DB.accounts.set(cleanUsername, account);
    DB.friends.set(userId, new Set());
    DB.users.set(userId, { id: userId, username: cleanUsername, avatar: userAvatar, status: 'online' });

    saveDB();
    socket.emit('auth:register_success', 'Tạo tài khoản thành công!');
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
      if (group.members.has(user.id)) socket.join(groupId);
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
      if (group.members.has(user.id)) socket.join(groupId);
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

    membersSet.forEach(mId => io.to(mId).emit('group:updated'));
    syncUserData(socket, currentUser.id);
  });

  // --- BẠN BÈ ---
  socket.on('friend:request', ({ targetId, targetUserId }) => {
    const finalTargetId = targetId || targetUserId;
    if (!currentUser || currentUser.id === finalTargetId) return;
    const reqId = `freq_${currentUser.id}_${finalTargetId}`;

    DB.friendRequests.set(reqId, {
      id: reqId,
      fromUserId: currentUser.id,
      fromUsername: currentUser.username,
      fromAvatar: currentUser.avatar,
      toUserId: finalTargetId,
      status: 'pending'
    });

    saveDB();
    io.to(finalTargetId).emit('friend:incoming');
    syncUserData(io, finalTargetId);
    syncUserData(socket, currentUser.id);
  });

  socket.on('friend:cancel_request', ({ targetId, targetUserId }) => {
    const finalTargetId = targetId || targetUserId;
    if (!currentUser || !finalTargetId) return;
    const reqId = `freq_${currentUser.id}_${finalTargetId}`;

    if (DB.friendRequests.has(reqId)) {
      DB.friendRequests.delete(reqId);
      saveDB();

      syncUserData(socket, currentUser.id);
      syncUserData(io, finalTargetId);
    }
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
    
    syncUserData(io, req.fromUserId);
    syncUserData(socket, req.toUserId);

    io.to(req.fromUserId).emit('friend:updated');
    io.to(req.toUserId).emit('friend:updated');
  });

  socket.on('friend:unfriend', ({ friendId }) => {
    if (!currentUser || !friendId) return;
    const currentUserId = currentUser.id;

    if (DB.friends.has(currentUserId)) DB.friends.get(currentUserId).delete(friendId);
    if (DB.friends.has(friendId)) DB.friends.get(friendId).delete(currentUserId);

    saveDB();
    syncUserData(socket, currentUserId);
    syncUserData(io, friendId);

    io.to(friendId).emit('friend:updated');
  });

  // --- GỬI TIN NHẮN ---
  socket.on('message:send', ({ roomId, content, type = 'text' }) => {
    if (!currentUser || !content) return;

    // Kiểm tra trạng thái hạn chế 24h
    const userStatus = DB.users.get(currentUser.id);
    if (userStatus && userStatus.restrictedUntil && userStatus.restrictedUntil > Date.now()) {
      const hoursLeft = Math.ceil((userStatus.restrictedUntil - Date.now()) / (1000 * 60 * 60));
      return socket.emit('message:error', `Tài khoản của bạn đang bị hạn chế nhắn tin trong ${hoursLeft} giờ tới!`);
    }

    if (roomId.startsWith('grp_')) {
      const group = DB.groups.get(roomId);
      if (group && group.muted.has(currentUser.id)) {
        return socket.emit('message:error', 'Bạn đã bị cấm chat trong nhóm này!');
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

  // --- BÁO CÁO & KHÁNG CÁO ---
  socket.on('report:submit', ({ targetId, reason, description, reporterId, reporterName }) => {
    const finalReporterId = reporterId || (currentUser ? currentUser.id : null);
    const finalReporterName = reporterName || (currentUser ? currentUser.username : 'Người dùng');

    if (!finalReporterId || !targetId) return;
    
    let cleanTargetId = targetId;
    if (cleanTargetId.includes('_DM_')) {
      const parts = cleanTargetId.split('_DM_');
      cleanTargetId = parts.find(id => id !== finalReporterId) || parts[0];
    }

    const reportId = `rep_${Math.random().toString(36).substr(2, 9)}`;
    let targetUsername = cleanTargetId;
    
    for (let [uname, acc] of DB.accounts.entries()) {
      if (acc.id === cleanTargetId) {
        targetUsername = uname;
        break;
      }
    }

    const reportObj = {
      id: reportId,
      reporterId: finalReporterId,
      reporterName: finalReporterName,
      targetId: cleanTargetId,
      targetUsername: targetUsername,
      reason: reason || 'Spam',
      description: description || '',
      timestamp: Date.now()
    };

    if (!DB.reports) DB.reports = new Map();
    DB.reports.set(reportId, reportObj);
    saveDB();

    io.emit('admin:new-report', Array.from(DB.reports.values()));
    io.to('admin_room').emit('admin_notification', {
      type: 'new_report',
      title: 'Báo cáo vi phạm mới',
      data: reportObj
    });
  });

  socket.on('appeal:restriction', ({ reason, userId, username }) => {
    const finalUserId = userId || (currentUser ? currentUser.id : null);
    const finalUsername = username || (currentUser ? currentUser.username : 'Người dùng');

    if (!finalUserId) return;

    const appealId = `apl_${Math.random().toString(36).substr(2, 9)}`;
    const appealObj = {
      id: appealId,
      userId: finalUserId,
      username: finalUsername,
      reason: reason || 'Xin gỡ hạn chế',
      timestamp: Date.now(),
      status: 'pending'
    };

    if (!DB.appeals) DB.appeals = new Map();
    DB.appeals.set(appealId, appealObj);
    saveDB();

    io.emit('admin:new-appeal', Array.from(DB.appeals.values()));
    io.to('admin_room').emit('admin_notification', {
      type: 'restriction_appeal',
      title: 'Yêu cầu gỡ/giảm hạn chế mới',
      data: appealObj
    });
  });

  socket.on('appeal:submit', (data) => {
    socket.emit('appeal:restriction', data);
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    if (currentUser) {
      currentUser.status = 'offline';
      io.to('admin_room').emit('admin_notification', { type: 'user_offline', userId: currentUser.id });
      io.emit('users:sync', Array.from(DB.users.values()));
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`[*] Web Chat Engine Online on port ${PORT}`);

  if (process.env.NODE_ENV !== 'production') {
    try {
      const url = await ngrok.connect({ addr: PORT, authtoken_from_env: true });
      console.log(`> 🌐 Link Ngrok (Local): ${url}`);
    } catch (error) {
      console.log('Không bật ngrok (chạy trên cloud hoặc chưa cấu hình token).');
    }
  }
});