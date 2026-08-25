const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

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
  maxHttpBufferSize: 1e7
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

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
  accounts: new Map(),       
  users: new Map(),          
  friendRequests: new Map(), 
  friends: new Map(),        
  messages: new Map(),       
  groups: new Map(),         
  clearedChats: new Map(),   
  reports: new Map(),        
  appeals: new Map()         
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
    saveDB();
    io.to(userId).emit('auth:forced_logout');
    return res.json({ success: true, message: 'Đã xóa người dùng thành công!' });
  }
  res.status(404).json({ success: false, message: 'Không tìm thấy người dùng!' });
});

// ==========================================
// SOCKET.IO XỬ LÝ SỰ KIỆN VÀ WEBRTC CALL
// ==========================================
io.on('connection', (socket) => {
  socket.on('auth:login', ({ username, password }) => {
    let foundAcc = null;
    for (let acc of DB.accounts.values()) {
      if (acc.username === username && acc.password === password) {
        foundAcc = acc;
        break;
      }
    }
    if (foundAcc) {
      socket.join(foundAcc.id);
      socket.userId = foundAcc.id;
      const userObj = DB.users.get(foundAcc.id) || { id: foundAcc.id, username, avatar: foundAcc.avatar, status: 'online' };
      userObj.status = 'online';
      DB.users.set(foundAcc.id, userObj);
      saveDB();
      socket.emit('auth:success', { token: foundAcc.id, user: userObj });
    } else {
      socket.emit('auth:error', 'Tài khoản hoặc mật khẩu không chính xác!');
    }
  });

  socket.on('auth:register', ({ username, password, avatar }) => {
    if (DB.accounts.has(username)) {
      socket.emit('auth:error', 'Tên tài khoản đã tồn tại!');
      return;
    }
    const id = 'usr_' + Math.random().toString(36).substring(2, 9);
    const newAcc = { id, username, password, avatar };
    DB.accounts.set(username, newAcc);
    DB.users.set(id, { id, username, avatar, status: 'offline' });
    saveDB();
    socket.emit('auth:register_success', 'Đăng ký tài khoản thành công!');
  });

  socket.on('auth:session', ({ userId }) => {
    let foundAcc = null;
    for (let acc of DB.accounts.values()) {
      if (acc.id === userId) {
        foundAcc = acc;
        break;
      }
    }
    if (foundAcc) {
      socket.join(foundAcc.id);
      socket.userId = foundAcc.id;
      const userObj = DB.users.get(foundAcc.id);
      if (userObj) userObj.status = 'online';
      saveDB();
      socket.emit('auth:success', { token: foundAcc.id, user: userObj });
      
      const userFriends = DB.friends.get(foundAcc.id) || [];
      const userRequests = DB.friendRequests.get(foundAcc.id) || [];
      const allUsersList = Array.from(DB.users.values());
      const userGroups = Array.from(DB.groups.values()).filter(g => g.members && g.members.some(m => m.id === foundAcc.id));

      socket.emit('data:sync', {
        friends: userFriends,
        requests: userRequests,
        allUsers: allUsersList,
        groups: userGroups
      });
    }
  });

  // --- WEBRTC CALL SIGNALING ---
  socket.on('call_user', ({ userToCall, signalData, callerName, callerAvatar, isVideo }) => {
    io.to(userToCall).emit('incoming_call', {
      signal: signalData,
      from: socket.id,
      callerName,
      callerAvatar,
      isVideo
    });
  });

  socket.on('answer_call', ({ signal, to }) => {
    io.to(to).emit('call_accepted', signal);
  });

  socket.on('reject_call', ({ to }) => {
    io.to(to).emit('call_rejected');
  });

  socket.on('end_call', ({ targetId }) => {
    io.to(targetId).emit('call_ended');
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      const userObj = DB.users.get(socket.userId);
      if (userObj) {
        userObj.status = 'offline';
        saveDB();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
});