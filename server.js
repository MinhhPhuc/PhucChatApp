const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const ngrok = require('ngrok');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const helmet = require('helmet');

// =====================================================
// SUPABASE CONFIG
// =====================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    '❌ Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong Environment Variables.'
  );
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// =====================================================
// APP CONFIG
// =====================================================

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
  cors: {
    origin: "*"
  },
  maxHttpBufferSize: 1e7
});

app.use(express.json({ limit: '10mb' }));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// =====================================================
// IN-MEMORY CACHE
// =====================================================
// Supabase = DATABASE THẬT
// DB = cache runtime để giữ nguyên architecture hiện tại
// =====================================================

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

let dbReady = false;
let syncTimer = null;
let syncPromise = Promise.resolve();

// =====================================================
// HELPERS
// =====================================================

function generateId(prefix) {
  return `${prefix}_${Math.random().toString(36).substring(2, 11)}`;
}

function toTimestamp(value) {
  if (!value) return 0;

  if (typeof value === 'number') {
    return value;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

// =====================================================
// BUILD SENDER OBJECT
// =====================================================

function getSenderObject(userId) {
  if (!userId) {
    return {
      id: '',
      username: 'Unknown',
      avatar: ''
    };
  }

  const user = DB.users.get(userId);
  const account = Array.from(DB.accounts.values())
    .find(a => a.id === userId);

  return {
    id: userId,
    username:
      user?.username ||
      account?.username ||
      'Unknown',
    avatar:
      user?.avatar ||
      account?.avatar ||
      ''
  };
}

// =====================================================
// LOAD DATA FROM SUPABASE
// =====================================================

async function loadDB() {
  console.log('📥 Đang tải dữ liệu từ Supabase...');

  try {
    // -----------------------------
    // ACCOUNTS
    // -----------------------------

    const { data: accounts, error: accountsError } =
      await supabase
        .from('accounts')
        .select('*');

    if (accountsError) {
      throw accountsError;
    }

    DB.accounts.clear();

    for (const account of accounts || []) {
      DB.accounts.set(account.username, {
        id: account.id,
        username: account.username,
        password: account.password,
        avatar: account.avatar
      });
    }

    // -----------------------------
    // USERS
    // -----------------------------

    const { data: users, error: usersError } =
      await supabase
        .from('users')
        .select('*');

    if (usersError) {
      throw usersError;
    }

    DB.users.clear();

    for (const user of users || []) {
      DB.users.set(user.id, {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        status: 'offline',
        restrictedUntil: user.restricted_until
          ? new Date(user.restricted_until).getTime()
          : undefined
      });
    }

    // -----------------------------
    // FRIEND REQUESTS
    // -----------------------------

    const {
      data: friendRequests,
      error: friendRequestsError
    } = await supabase
      .from('friend_requests')
      .select('*');

    if (friendRequestsError) {
      throw friendRequestsError;
    }

    DB.friendRequests.clear();

    for (const request of friendRequests || []) {
      const fromUser = DB.users.get(request.from_user_id);

      DB.friendRequests.set(request.id, {
        id: request.id,
        fromUserId: request.from_user_id,
        fromUsername: fromUser?.username || '',
        fromAvatar: fromUser?.avatar || '',
        toUserId: request.to_user_id,
        status: request.status
      });
    }

    // -----------------------------
    // FRIENDS
    // -----------------------------

    const {
      data: friends,
      error: friendsError
    } = await supabase
      .from('friends')
      .select('*');

    if (friendsError) {
      throw friendsError;
    }

    DB.friends.clear();

    for (const row of friends || []) {
      if (!DB.friends.has(row.user_id)) {
        DB.friends.set(row.user_id, new Set());
      }

      DB.friends.get(row.user_id).add(row.friend_id);
    }

    // -----------------------------
    // GROUPS
    // -----------------------------

    const {
      data: groups,
      error: groupsError
    } = await supabase
      .from('groups')
      .select('*');

    if (groupsError) {
      throw groupsError;
    }

    const {
      data: groupMembers,
      error: groupMembersError
    } = await supabase
      .from('group_members')
      .select('*');

    if (groupMembersError) {
      throw groupMembersError;
    }

    DB.groups.clear();

    for (const group of groups || []) {
      const members = new Set();
      const muted = new Set();

      for (const member of groupMembers || []) {
        if (member.group_id !== group.id) continue;

        members.add(member.user_id);

        if (member.is_muted) {
          muted.add(member.user_id);
        }
      }

      DB.groups.set(group.id, {
        id: group.id,
        name: group.name,
        avatar: group.avatar,
        members,
        adminId: group.admin_id,
        muted
      });
    }

    // -----------------------------
    // MESSAGES
    // -----------------------------

    const {
      data: messages,
      error: messagesError
    } = await supabase
      .from('messages')
      .select('*')
      .order('timestamp', {
        ascending: true
      });

    if (messagesError) {
      throw messagesError;
    }

    DB.messages.clear();

    for (const message of messages || []) {
      if (!DB.messages.has(message.room_id)) {
        DB.messages.set(message.room_id, []);
      }

      DB.messages.get(message.room_id).push({
        id: message.id,
        roomId: message.room_id,
        sender: getSenderObject(message.sender_id),
        content: message.content,
        type: message.type,
        timestamp: Number(message.timestamp)
      });
    }

    // -----------------------------
    // CLEARED CHATS
    // -----------------------------

    const {
      data: clearedChats,
      error: clearedChatsError
    } = await supabase
      .from('cleared_chats')
      .select('*');

    if (clearedChatsError) {
      throw clearedChatsError;
    }

    DB.clearedChats.clear();

    for (const row of clearedChats || []) {
      const key = `${row.user_id}_${row.room_id}`;

      DB.clearedChats.set(
        key,
        Number(row.cleared_at)
      );
    }

    // -----------------------------
    // REPORTS
    // -----------------------------

    const {
      data: reports,
      error: reportsError
    } = await supabase
      .from('reports')
      .select('*');

    if (reportsError) {
      throw reportsError;
    }

    DB.reports.clear();

    for (const report of reports || []) {
      DB.reports.set(report.id, {
        id: report.id,
        reporterId: report.reporter_id,
        reporterName: report.reporter_name,
        targetId: report.target_id,
        targetUsername: report.target_username,
        reason: report.reason,
        description: report.description,
        timestamp: Number(report.timestamp)
      });
    }

    // -----------------------------
    // APPEALS
    // -----------------------------

    const {
      data: appeals,
      error: appealsError
    } = await supabase
      .from('appeals')
      .select('*');

    if (appealsError) {
      throw appealsError;
    }

    DB.appeals.clear();

    for (const appeal of appeals || []) {
      DB.appeals.set(appeal.id, {
        id: appeal.id,
        userId: appeal.user_id,
        username: appeal.username,
        reason: appeal.reason,
        timestamp: Number(appeal.timestamp),
        status: appeal.status
      });
    }

    dbReady = true;

    console.log('✅ Đã tải dữ liệu từ Supabase');

    console.log(
      `👤 Accounts: ${DB.accounts.size}`
    );

    console.log(
      `💬 Messages: ${Array.from(DB.messages.values())
        .reduce((total, list) => total + list.length, 0)}`
    );

    console.log(
      `👥 Groups: ${DB.groups.size}`
    );

  } catch (error) {
    console.error(
      '❌ Không thể tải database từ Supabase:',
      error
    );

    throw error;
  }
}

// =====================================================
// SYNC DB CACHE -> SUPABASE
// =====================================================

async function syncDBToSupabase() {
  if (!dbReady) {
    return;
  }

  try {
    // =================================================
    // ACCOUNTS
    // =================================================

    const accounts = Array.from(
      DB.accounts.values()
    ).map(account => ({
      id: account.id,
      username: account.username,
      password: account.password,
      avatar: account.avatar
    }));

    if (accounts.length > 0) {
      const { error } = await supabase
        .from('accounts')
        .upsert(accounts, {
          onConflict: 'id'
        });

      if (error) throw error;
    }

    // =================================================
    // USERS
    // =================================================

    const users = Array.from(
      DB.users.values()
    ).map(user => ({
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      status: user.status || 'offline',
      restricted_until:
        user.restrictedUntil
          ? new Date(user.restrictedUntil).toISOString()
          : null
    }));

    if (users.length > 0) {
      const { error } = await supabase
        .from('users')
        .upsert(users, {
          onConflict: 'id'
        });

      if (error) throw error;
    }

    // =================================================
    // FRIEND REQUESTS
    // =================================================

    const friendRequests =
      Array.from(
        DB.friendRequests.values()
      ).map(request => ({
        id: request.id,
        from_user_id: request.fromUserId,
        to_user_id: request.toUserId,
        status: request.status
      }));

    // Xóa request cũ trước khi đồng bộ
    await supabase
      .from('friend_requests')
      .delete()
      .neq('id', '__none__');

    if (friendRequests.length > 0) {
      const { error } = await supabase
        .from('friend_requests')
        .insert(friendRequests);

      if (error) throw error;
    }

    // =================================================
    // FRIENDS
    // =================================================

    const friendRows = [];

    DB.friends.forEach(
      (friendSet, userId) => {
        friendSet.forEach(friendId => {
          friendRows.push({
            user_id: userId,
            friend_id: friendId
          });
        });
      }
    );

    await supabase
      .from('friends')
      .delete()
      .neq('user_id', '__none__');

    if (friendRows.length > 0) {
      const { error } = await supabase
        .from('friends')
        .insert(friendRows);

      if (error) throw error;
    }

    // =================================================
    // GROUPS
    // =================================================

    const groups = Array.from(
      DB.groups.values()
    ).map(group => ({
      id: group.id,
      name: group.name,
      avatar: group.avatar,
      admin_id: group.adminId
    }));

    if (groups.length > 0) {
      const { error } = await supabase
        .from('groups')
        .upsert(groups, {
          onConflict: 'id'
        });

      if (error) throw error;
    }

    // =================================================
    // GROUP MEMBERS
    // =================================================

    const groupMembers = [];

    DB.groups.forEach(group => {
      group.members.forEach(userId => {
        groupMembers.push({
          group_id: group.id,
          user_id: userId,
          is_muted: group.muted.has(userId)
        });
      });
    });

    await supabase
      .from('group_members')
      .delete()
      .neq('group_id', '__none__');

    if (groupMembers.length > 0) {
      const { error } = await supabase
        .from('group_members')
        .insert(groupMembers);

      if (error) throw error;
    }

    // =================================================
    // MESSAGES
    // =================================================

    const messageRows = [];

    DB.messages.forEach(list => {
      list.forEach(message => {
        messageRows.push({
          id: message.id,
          room_id: message.roomId,
          sender_id: message.sender.id,
          content: message.content,
          type: message.type || 'text',
          timestamp: Number(message.timestamp)
        });
      });
    });

    if (messageRows.length > 0) {
      const { error } = await supabase
        .from('messages')
        .upsert(messageRows, {
          onConflict: 'id'
        });

      if (error) throw error;
    }

    // =================================================
    // CLEARED CHATS
    // =================================================

    const clearedRows = [];

    DB.clearedChats.forEach(
      (clearedAt, key) => {
        const separatorIndex =
          key.indexOf('_');

        if (separatorIndex === -1) {
          return;
        }

        const userId =
          key.substring(0, separatorIndex);

        const roomId =
          key.substring(separatorIndex + 1);

        clearedRows.push({
          user_id: userId,
          room_id: roomId,
          cleared_at: Number(clearedAt)
        });
      }
    );

    await supabase
      .from('cleared_chats')
      .delete()
      .neq('user_id', '__none__');

    if (clearedRows.length > 0) {
      const { error } = await supabase
        .from('cleared_chats')
        .insert(clearedRows);

      if (error) throw error;
    }

    // =================================================
    // REPORTS
    // =================================================

    const reports =
      Array.from(DB.reports.values())
        .map(report => ({
          id: report.id,
          reporter_id: report.reporterId,
          reporter_name: report.reporterName,
          target_id: report.targetId,
          target_username: report.targetUsername,
          reason: report.reason,
          description: report.description,
          timestamp: Number(report.timestamp)
        }));

    if (reports.length > 0) {
      const { error } = await supabase
        .from('reports')
        .upsert(reports, {
          onConflict: 'id'
        });

      if (error) throw error;
    }

    // =================================================
    // APPEALS
    // =================================================

    const appeals =
      Array.from(DB.appeals.values())
        .map(appeal => ({
          id: appeal.id,
          user_id: appeal.userId,
          username: appeal.username,
          reason: appeal.reason,
          timestamp: Number(appeal.timestamp),
          status: appeal.status
        }));

    if (appeals.length > 0) {
      const { error } = await supabase
        .from('appeals')
        .upsert(appeals, {
          onConflict: 'id'
        });

      if (error) throw error;
    }

    console.log('💾 Đồng bộ Supabase thành công');

  } catch (error) {
    console.error(
      '❌ Lỗi đồng bộ Supabase:',
      error
    );
  }
}

// =====================================================
// DEBOUNCED SAVE
// =====================================================

function saveDB() {
  clearTimeout(syncTimer);

  syncTimer = setTimeout(() => {
    syncPromise =
      syncPromise
        .then(() => syncDBToSupabase())
        .catch(error => {
          console.error(
            '❌ Sync queue error:',
            error
          );
        });
  }, 500);
}

// =====================================================
// SYNC BEFORE PROCESS EXIT
// =====================================================

async function flushDatabase() {
  clearTimeout(syncTimer);

  try {
    await syncPromise;
    await syncDBToSupabase();
  } catch (error) {
    console.error(
      '❌ Final database sync failed:',
      error
    );
  }
}

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received');
  await flushDatabase();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received');
  await flushDatabase();
  process.exit(0);
});

// =====================================================
// ADMIN API
// =====================================================

app.get('/api/admin/data', (req, res) => {
  let totalMessages = 0;

  DB.messages.forEach(messages => {
    totalMessages += messages.length;
  });

  const accountsList =
    Array.from(DB.accounts.values())
      .map(account => {
        const user =
          DB.users.get(account.id);

        return {
          id: account.id,
          username: account.username,
          avatar: account.avatar,
          status: user
            ? user.status
            : 'offline'
        };
      });

  res.json({
    stats: {
      totalUsers: DB.accounts.size,
      totalGroups: DB.groups.size,
      totalMessages
    },
    accounts: accountsList
  });
});

app.get('/api/admin/reports', (req, res) => {
  res.json(
    Array.from(DB.reports.values())
  );
});

app.get('/api/admin/appeals', (req, res) => {
  res.json(
    Array.from(DB.appeals.values())
  );
});

// =====================================================
// ADMIN RESTRICTION
// =====================================================

app.post(
  '/api/admin/user/:id/restrict',
  async (req, res) => {
    const userId = req.params.id;

    const user = DB.users.get(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy người dùng!'
      });
    }

    user.restrictedUntil =
      Date.now() +
      24 * 60 * 60 * 1000;

    saveDB();

    io.to(userId).emit(
      'auth:restricted',
      'Tài khoản của bạn đã bị hạn chế nhắn tin trong 24 giờ do vi phạm nội quy.'
    );

    res.json({
      success: true,
      message:
        'Đã hạn chế người dùng 24h thành công!'
    });
  }
);

app.post(
  '/api/admin/user/:id/lift-restriction',
  async (req, res) => {
    const userId = req.params.id;

    const user = DB.users.get(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy người dùng!'
      });
    }

    delete user.restrictedUntil;

    saveDB();

    io.to(userId).emit(
      'auth:unrestricted',
      'Tài khoản của bạn đã được gỡ hạn chế nhắn tin.'
    );

    res.json({
      success: true,
      message: 'Đã gỡ hạn chế thành công!'
    });
  }
);

app.post(
  '/api/admin/user/:id/reduce-restriction',
  async (req, res) => {
    const userId = req.params.id;
    const { hours } = req.body;

    const user = DB.users.get(userId);

    if (
      !user ||
      !user.restrictedUntil
    ) {
      return res.status(404).json({
        success: false,
        message:
          'Không tìm thấy người dùng hoặc tài khoản không có hạn chế!'
      });
    }

    const reduceMs =
      (hours || 0) *
      60 *
      60 *
      1000;

    user.restrictedUntil =
      Math.max(
        Date.now(),
        user.restrictedUntil - reduceMs
      );

    if (
      user.restrictedUntil <= Date.now()
    ) {
      delete user.restrictedUntil;
    }

    saveDB();

    res.json({
      success: true,
      message:
        `Đã giảm ${hours} giờ hạn chế thành công!`
    });
  }
);

// =====================================================
// ADMIN REPORT DELETE
// =====================================================

app.delete(
  '/api/admin/report/:id',
  (req, res) => {
    const reportId = req.params.id;

    if (!DB.reports.has(reportId)) {
      return res.status(404).json({
        success: false,
        message:
          'Không tìm thấy báo cáo!'
      });
    }

    DB.reports.delete(reportId);

    // Xoá trực tiếp Supabase
    syncPromise =
      syncPromise.then(async () => {
        await supabase
          .from('reports')
          .delete()
          .eq('id', reportId);
      });

    res.json({
      success: true,
      message: 'Đã xóa báo cáo!'
    });
  }
);

// =====================================================
// ADMIN DELETE USER
// =====================================================

app.delete(
  '/api/admin/user/:id',
  (req, res) => {
    const userId = req.params.id;

    let targetUsername = null;

    for (
      const [username, account]
      of DB.accounts.entries()
    ) {
      if (account.id === userId) {
        targetUsername = username;
        break;
      }
    }

    if (!targetUsername) {
      return res.status(404).json({
        success: false,
        message:
          'Không tìm thấy người dùng!'
      });
    }

    DB.accounts.delete(targetUsername);
    DB.users.delete(userId);
    DB.friends.delete(userId);

    DB.friendRequests.forEach(
      (request, id) => {
        if (
          request.fromUserId === userId ||
          request.toUserId === userId
        ) {
          DB.friendRequests.delete(id);
        }
      }
    );

    DB.groups.forEach(group => {
      group.members.delete(userId);
      group.muted.delete(userId);

      if (group.adminId === userId) {
        const nextAdmin =
          Array.from(group.members)[0];

        group.adminId = nextAdmin || null;
      }
    });

    io.to(userId).emit(
      'auth:forced_logout'
    );

    saveDB();

    res.json({
      success: true,
      message:
        'Đã xóa tài khoản thành công!'
    });
  }
);

// =====================================================
// SYNC USER DATA
// =====================================================

function syncUserData(target, userId) {
  if (!target || !userId) {
    return;
  }

  const friendSet =
    DB.friends.get(userId) ||
    new Set();

  const friendsList =
    Array.from(friendSet)
      .map(friendId => {
        const account =
          Array.from(
            DB.accounts.values()
          )
            .find(
              account =>
                account.id === friendId
            );

        const user =
          DB.users.get(friendId);

        return account
          ? {
              ...account,
              status:
                user?.status ||
                'offline'
            }
          : null;
      })
      .filter(Boolean);

  const incomingRequests =
    Array.from(
      DB.friendRequests.values()
    )
      .filter(
        request =>
          request.toUserId === userId &&
          request.status === 'pending'
      );

  const allRegisteredUsers =
    Array.from(
      DB.accounts.values()
    ).map(account => ({
      id: account.id,
      username: account.username,
      avatar: account.avatar,
      status:
        DB.users.get(account.id)
          ?.status ||
        'offline'
    }));

  const userGroups = [];

  DB.groups.forEach(group => {
    if (!group.members.has(userId)) {
      return;
    }

    const members =
      Array.from(
        group.members
      ).map(memberId => {
        const account =
          Array.from(
            DB.accounts.values()
          ).find(
            account =>
              account.id === memberId
          );

        return account
          ? {
              id: memberId,
              username: account.username,
              avatar: account.avatar,
              isMuted:
                group.muted.has(
                  memberId
                )
            }
          : null;
      })
      .filter(Boolean);

    userGroups.push({
      id: group.id,
      name: group.name,
      avatar: group.avatar,
      membersCount:
        group.members.size,
      adminId: group.adminId,
      members
    });
  });

  const payload = {
    friends: friendsList,
    requests:
      incomingRequests,
    allUsers:
      allRegisteredUsers,
    groups:
      userGroups
  };

  target.emit(
    'data:sync',
    payload
  );

  target.emit(
    'receive_friend_requests',
    incomingRequests
  );
}

// =====================================================
// SOCKET.IO
// =====================================================

io.on('connection', socket => {
  let currentUser = null;

  // ===================================================
  // VIDEO CALL
  // ===================================================

  socket.on(
    'call_user',
    data => {
      console.log(
        `📞 Call từ ${
          currentUser
            ? currentUser.username
            : socket.id
        } → ${data.userToCall}`
      );

      const targetUser =
        DB.users.get(
          data.userToCall
        );

      if (!targetUser) {
        return socket.emit(
          'call_error',
          {
            message:
              'Không tìm thấy người dùng trong hệ thống!'
          }
        );
      }

      const receiverRoomId =
        String(targetUser.id);

      io.to(
        receiverRoomId
      ).emit(
        'incoming_call',
        {
          signal:
            data.signalData,

          fromSocketId:
            socket.id,

          fromUserId:
            currentUser
              ? currentUser.id
              : null,

          callerName:
            data.callerName ||
            currentUser?.username ||
            'Người dùng',

          callerAvatar:
            currentUser?.avatar || '',

          isVideo:
            !!data.isVideo
        }
      );
    }
  );

  socket.on(
    'answer_call',
    data => {
      if (!data?.toSocketId) {
        return;
      }

      io.to(
        data.toSocketId
      ).emit(
        'call_accepted',
        data.signal
      );
    }
  );

  socket.on(
    'reject_call',
    data => {
      if (!data?.toSocketId) {
        return;
      }

      io.to(
        data.toSocketId
      ).emit(
        'call_rejected'
      );
    }
  );

  socket.on(
    'end_call',
    data => {
      if (
        data?.targetId
      ) {
        io.to(
          data.targetId
        ).emit(
          'call_ended'
        );
      }

      if (
        data?.toSocketId
      ) {
        io.to(
          data.toSocketId
        ).emit(
          'call_ended'
        );
      }
    }
  );

  // ===================================================
  // ADMIN ROOM
  // ===================================================

  socket.on(
    'join_admin_room',
    userData => {
      if (
        userData &&
        userData.isAdmin
      ) {
        socket.join(
          'admin_room'
        );
      }
    }
  );

  // ===================================================
  // CLEAR CHAT
  // ===================================================

  socket.on(
    'messages:clear_me',
    ({ roomId }) => {
      if (!currentUser || !roomId) {
        return;
      }

      const key =
        `${currentUser.id}_${roomId}`;

      DB.clearedChats.set(
        key,
        Date.now()
      );

      saveDB();

      socket.emit(
        'messages:cleared_me',
        {
          roomId
        }
      );
    }
  );

  socket.on(
    'messages:clear',
    ({ roomId }) => {
      if (!roomId) {
        return;
      }

      DB.messages.set(
        roomId,
        []
      );

      saveDB();

      if (
        roomId.startsWith('grp_')
      ) {
        io.to(roomId).emit(
          'messages:cleared',
          {
            roomId
          }
        );

        return;
      }

      const parts =
        roomId.split('_DM_');

      if (
        parts.length === 2
      ) {
        io.to(parts[0])
          .to(parts[1])
          .emit(
            'messages:cleared',
            {
              roomId
            }
          );
      } else {
        socket.emit(
          'messages:cleared',
          {
            roomId
          }
        );
      }
    }
  );

  // ===================================================
  // MESSAGE HISTORY
  // ===================================================

  socket.on(
    'messages:get',
    ({ roomId }) => {
      if (!currentUser) {
        return;
      }

      const messages =
        DB.messages.get(
          roomId
        ) || [];

      const clearKey =
        `${currentUser.id}_${roomId}`;

      const clearedAt =
        DB.clearedChats.get(
          clearKey
        ) || 0;

      const filtered =
        messages.filter(
          message =>
            Number(message.timestamp) >
            Number(clearedAt)
        );

      socket.emit(
        'messages:history',
        {
          roomId,
          messages: filtered
        }
      );
    }
  );

  // ===================================================
  // GROUP ACTION
  // ===================================================

  socket.on(
    'group:action',
    ({ action, groupId, targetId }) => {
      if (!currentUser) {
        return;
      }

      const group =
        DB.groups.get(groupId);

      if (
        !group ||
        !group.members.has(
          currentUser.id
        )
      ) {
        return;
      }

      const isAdmin =
        group.adminId ===
        currentUser.id;

      // LEAVE
      if (action === 'leave') {
        if (
          isAdmin &&
          group.members.size > 1
        ) {
          group.members.delete(
            currentUser.id
          );

          const nextMember =
            Array.from(
              group.members
            )[0];

          group.adminId =
            nextMember;
        } else {
          group.members.delete(
            currentUser.id
          );
        }

        group.muted.delete(
          currentUser.id
        );

        socket.leave(
          groupId
        );

        io.to(
          currentUser.id
        ).emit(
          'group:kicked_out'
        );

        Array.from(
          group.members
        ).forEach(memberId => {
          io.to(memberId)
            .emit(
              'group:updated'
            );
        });

        if (
          group.members.size ===
          0
        ) {
          DB.groups.delete(
            groupId
          );
        }

        saveDB();

        return;
      }

      if (!isAdmin) {
        return socket.emit(
          'message:error',
          'Bạn không có quyền thực hiện thao tác này!'
        );
      }

      // DELETE GROUP
      if (
        action ===
        'delete_group'
      ) {
        const members =
          Array.from(
            group.members
          );

        DB.groups.delete(
          groupId
        );

        members.forEach(
          memberId => {
            io.to(memberId)
              .emit(
                'group:kicked_out'
              );
          }
        );

        saveDB();

        return;
      }

      if (
        !targetId ||
        targetId ===
        currentUser.id
      ) {
        return;
      }

      if (
        action === 'kick'
      ) {
        group.members.delete(
          targetId
        );

        group.muted.delete(
          targetId
        );

        io.to(targetId).emit(
          'group:kicked_out'
        );
      }

      else if (
        action === 'mute'
      ) {
        group.muted.add(
          targetId
        );
      }

      else if (
        action === 'unmute'
      ) {
        group.muted.delete(
          targetId
        );
      }

      else if (
        action ===
        'transfer_admin'
      ) {
        if (
          group.members.has(
            targetId
          )
        ) {
          group.adminId =
            targetId;
        }
      }

      saveDB();

      Array.from(
        group.members
      ).forEach(memberId => {
        io.to(memberId)
          .emit(
            'group:updated'
          );
      });
    }
  );

  // ===================================================
  // ADD MEMBERS
  // ===================================================

  socket.on(
    'group:add_members',
    ({
      groupId,
      newMemberIds
    }) => {
      if (
        !currentUser ||
        !groupId ||
        !Array.isArray(
          newMemberIds
        ) ||
        newMemberIds.length === 0
      ) {
        return;
      }

      const group =
        DB.groups.get(
          groupId
        );

      if (!group) {
        return;
      }

      let changed = false;

      newMemberIds.forEach(
        userId => {
          if (
            !group.members.has(
              userId
            )
          ) {
            group.members.add(
              userId
            );

            changed = true;
          }
        }
      );

      if (changed) {
        saveDB();

        Array.from(
          group.members
        ).forEach(memberId => {
          io.to(memberId)
            .emit(
              'group:updated'
            );
        });
      }
    }
  );

  // ===================================================
  // AUTH REGISTER
  // ===================================================

  socket.on(
    'auth:register',
    async ({
      username,
      password,
      avatar
    }) => {
      try {
        if (
          !username ||
          !password
        ) {
          return socket.emit(
            'auth:error',
            'Vui lòng nhập đầy đủ tên tài khoản và mật khẩu!'
          );
        }

        const cleanUsername =
          username.trim();

        if (!cleanUsername) {
          return socket.emit(
            'auth:error',
            'Tên tài khoản không được để trống!'
          );
        }

        // Check cache
        if (
          DB.accounts.has(
            cleanUsername
          )
        ) {
          return socket.emit(
            'auth:error',
            'Tài khoản này đã tồn tại!'
          );
        }

        // Check trực tiếp DB
        const {
          data: existingAccount,
          error: accountCheckError
        } = await supabase
          .from('accounts')
          .select('id')
          .eq(
            'username',
            cleanUsername
          )
          .maybeSingle();

        if (accountCheckError) {
          throw accountCheckError;
        }

        if (existingAccount) {
          return socket.emit(
            'auth:error',
            'Tài khoản này đã tồn tại!'
          );
        }

        const userId =
          generateId('usr');

        const userAvatar =
          avatar ||
          `https://api.dicebear.com/7.x/avataaars/svg?seed=${encodeURIComponent(
            cleanUsername
          )}`;

        const account = {
          id: userId,
          username:
            cleanUsername,
          password,
          avatar:
            userAvatar
        };

        const newUser = {
          id: userId,
          username:
            cleanUsername,
          avatar:
            userAvatar,
          status:
            'offline'
        };

        // Insert account
        const {
          error: insertAccountError
        } = await supabase
          .from('accounts')
          .insert({
            id:
              account.id,
            username:
              account.username,
            password:
              account.password,
            avatar:
              account.avatar
          });

        if (insertAccountError) {
          throw insertAccountError;
        }

        // Insert user
        const {
          error: insertUserError
        } = await supabase
          .from('users')
          .insert({
            id:
              newUser.id,
            username:
              newUser.username,
            avatar:
              newUser.avatar,
            status:
              newUser.status
          });

        if (insertUserError) {
          // Rollback account
          await supabase
            .from('accounts')
            .delete()
            .eq(
              'id',
              userId
            );

          throw insertUserError;
        }

        // Update cache
        DB.accounts.set(
          cleanUsername,
          account
        );

        DB.users.set(
          userId,
          newUser
        );

        DB.friends.set(
          userId,
          new Set()
        );

        // ==========================================
        // ĐỒNG BỘ USER MỚI CHO TẤT CẢ CLIENT
        // ==========================================
        io.emit(
          'users:sync',
          Array.from(
            DB.users.values()
          ).map(user => ({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            status: user.status || 'offline'
          }))
        );

        socket.emit(
          'auth:register_success',
          'Tạo tài khoản thành công!'
        );

        console.log(
          `✅ Đăng ký thành công: ${cleanUsername}`
        );

      } catch (error) {
        console.error(
          '❌ Register error:',
          error
        );

        socket.emit(
          'auth:error',
          'Không thể tạo tài khoản. Vui lòng thử lại!'
        );
      }
    }
  );

  // ===================================================
  // AUTH LOGIN
  // ===================================================

  socket.on(
    'auth:login',
    async ({
      username,
      password
    }) => {
      try {
        const cleanUsername =
          username
            ? username.trim()
            : '';

        const account =
          DB.accounts.get(
            cleanUsername
          );

        let acc = account;

        // Fallback direct Supabase
        if (!acc) {
          const {
            data,
            error
          } = await supabase
            .from('accounts')
            .select('*')
            .eq(
              'username',
              cleanUsername
            )
            .maybeSingle();

          if (error) {
            throw error;
          }

          acc = data;
        }

        if (
          !acc ||
          acc.password !==
            password
        ) {
          return socket.emit(
            'auth:error',
            'Tài khoản hoặc mật khẩu không chính xác!'
          );
        }

        const userId =
          acc.id;

        let user =
          DB.users.get(
            userId
          );

        if (!user) {
          const {
            data,
            error
          } = await supabase
            .from('users')
            .select('*')
            .eq(
              'id',
              userId
            )
            .maybeSingle();

          if (error) {
            throw error;
          }

          if (data) {
            user = {
              id:
                data.id,
              username:
                data.username,
              avatar:
                data.avatar,
              status:
                'online',
              restrictedUntil:
                data.restricted_until
                  ? new Date(
                      data.restricted_until
                    ).getTime()
                  : undefined
            };

            DB.users.set(
              userId,
              user
            );
          }
        }

        if (!user) {
          user = {
            id:
              acc.id,
            username:
              acc.username,
            avatar:
              acc.avatar,
            status:
              'online'
          };

          DB.users.set(
            userId,
            user
          );
        }

        user.status =
          'online';

        user.avatar =
          acc.avatar;

        DB.users.set(
          userId,
          user
        );

        // Update status to Supabase
        await supabase
          .from('users')
          .update({
            status:
              'online',
            avatar:
              acc.avatar
          })
          .eq(
            'id',
            userId
          );

        currentUser =
          user;

        socket.join(
          user.id
        );

        // Join groups
        DB.groups.forEach(
          (
            group,
            groupId
          ) => {
            if (
              group.members.has(
                user.id
              )
            ) {
              socket.join(
                groupId
              );
            }
          }
        );

        socket.emit(
          'auth:success',
          {
            token:
              user.id,
            user
          }
        );

        syncUserData(
          socket,
          user.id
        );

        io.emit(
          'users:sync',
          Array.from(
            DB.users.values()
          )
        );

      } catch (error) {
        console.error(
          '❌ Login error:',
          error
        );

        socket.emit(
          'auth:error',
          'Không thể đăng nhập. Vui lòng thử lại!'
        );
      }
    }
  );

  // ===================================================
  // AUTH SESSION
  // ===================================================

  socket.on(
    'auth:session',
    async ({ userId }) => {
      try {
        if (!userId) {
          return socket.emit(
            'auth:session_invalid'
          );
        }

        let foundAcc = null;

        for (
          const account
          of DB.accounts.values()
        ) {
          if (
            account.id ===
            userId
          ) {
            foundAcc =
              account;
            break;
          }
        }

        // Fallback Supabase
        if (!foundAcc) {
          const {
            data,
            error
          } = await supabase
            .from('accounts')
            .select('*')
            .eq(
              'id',
              userId
            )
            .maybeSingle();

          if (error) {
            throw error;
          }

          if (data) {
            foundAcc =
              data;

            DB.accounts.set(
              data.username,
              data
            );
          }
        }

        if (!foundAcc) {
          return socket.emit(
            'auth:session_invalid'
          );
        }

        let user =
          DB.users.get(
            userId
          );

        if (!user) {
          const {
            data,
            error
          } = await supabase
            .from('users')
            .select('*')
            .eq(
              'id',
              userId
            )
            .maybeSingle();

          if (error) {
            throw error;
          }

          if (data) {
            user = {
              id:
                data.id,
              username:
                data.username,
              avatar:
                data.avatar,
              status:
                'online',
              restrictedUntil:
                data.restricted_until
                  ? new Date(
                      data.restricted_until
                    ).getTime()
                  : undefined
            };

            DB.users.set(
              userId,
              user
            );
          }
        }

        if (!user) {
          user = {
            id:
              foundAcc.id,
            username:
              foundAcc.username,
            avatar:
              foundAcc.avatar,
            status:
              'online'
          };
        }

        user.status =
          'online';

        user.avatar =
          foundAcc.avatar;

        DB.users.set(
          userId,
          user
        );

        await supabase
          .from('users')
          .update({
            status:
              'online',
            avatar:
              foundAcc.avatar
          })
          .eq(
            'id',
            userId
          );

        currentUser =
          user;

        socket.join(
          user.id
        );

        DB.groups.forEach(
          (
            group,
            groupId
          ) => {
            if (
              group.members.has(
                user.id
              )
            ) {
              socket.join(
                groupId
              );
            }
          }
        );

        socket.emit(
          'auth:success',
          {
            token:
              user.id,
            user
          }
        );

        syncUserData(
          socket,
          user.id
        );

        io.emit(
          'users:sync',
          Array.from(
            DB.users.values()
          )
        );

      } catch (error) {
        console.error(
          '❌ Session error:',
          error
        );

        socket.emit(
          'auth:session_invalid'
        );
      }
    }
  );

  // ===================================================
  // GROUP CREATE
  // ===================================================

  socket.on(
    'group:create',
    async ({
      name,
      avatar,
      memberIds
    }) => {
      try {
        if (
          !currentUser ||
          !name ||
          !Array.isArray(
            memberIds
          )
        ) {
          return;
        }

        const groupId =
          generateId(
            'grp'
          );

        const groupAvatar =
          avatar ||
          `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(
            name
          )}`;

        const membersSet =
          new Set([
            currentUser.id,
            ...memberIds
          ]);

        const group = {
          id:
            groupId,
          name,
          avatar:
            groupAvatar,
          members:
            membersSet,
          adminId:
            currentUser.id,
          muted:
            new Set()
        };

        const {
          error:
            groupInsertError
        } = await supabase
          .from('groups')
          .insert({
            id:
              group.id,
            name:
              group.name,
            avatar:
              group.avatar,
            admin_id:
              group.adminId
          });

        if (groupInsertError) {
          throw groupInsertError;
        }

        const groupMemberRows =
          Array.from(
            membersSet
          ).map(
            userId => ({
              group_id:
                groupId,
              user_id:
                userId,
              is_muted:
                false
            })
          );

        if (
          groupMemberRows.length
        ) {
          const {
            error
          } = await supabase
            .from(
              'group_members'
            )
            .insert(
              groupMemberRows
            );

          if (error) {
            // rollback group
            await supabase
              .from('groups')
              .delete()
              .eq(
                'id',
                groupId
              );

            throw error;
          }
        }

        DB.groups.set(
          groupId,
          group
        );

        membersSet.forEach(
          memberId => {
            socket.join(
              groupId
            );

            io.to(
              memberId
            ).emit(
              'group:updated'
            );
          }
        );

        syncUserData(
          socket,
          currentUser.id
        );

      } catch (error) {
        console.error(
          '❌ Group create error:',
          error
        );

        socket.emit(
          'message:error',
          'Không thể tạo nhóm!'
        );
      }
    }
  );

  // ===================================================
  // FRIEND REQUEST
  // ===================================================

  socket.on(
    'friend:request',
    async ({
      targetId,
      targetUserId
    }) => {
      try {
        const finalTargetId =
          targetId ||
          targetUserId;

        if (
          !currentUser ||
          !finalTargetId ||
          currentUser.id ===
            finalTargetId
        ) {
          return;
        }

        const reqId =
          `freq_${currentUser.id}_${finalTargetId}`;

        const targetUser =
          DB.users.get(
            finalTargetId
          );

        if (!targetUser) {
          return;
        }

        const request = {
          id:
            reqId,
          fromUserId:
            currentUser.id,
          fromUsername:
            currentUser.username,
          fromAvatar:
            currentUser.avatar,
          toUserId:
            finalTargetId,
          status:
            'pending'
        };

        const {
          error
        } = await supabase
          .from(
            'friend_requests'
          )
          .upsert({
            id:
              reqId,
            from_user_id:
              currentUser.id,
            to_user_id:
              finalTargetId,
            status:
              'pending'
          }, {
            onConflict:
              'id'
          });

        if (error) {
          throw error;
        }

        DB.friendRequests.set(
          reqId,
          request
        );

        io.to(
          finalTargetId
        ).emit(
          'friend:incoming'
        );

        syncUserData(
          io.to(finalTargetId),
          finalTargetId
        );

        syncUserData(
          socket,
          currentUser.id
        );

      } catch (error) {
        console.error(
          '❌ Friend request error:',
          error
        );

        socket.emit(
          'message:error',
          'Không thể gửi lời mời kết bạn!'
        );
      }
    }
  );

  // ===================================================
  // CANCEL FRIEND REQUEST
  // ===================================================

  socket.on(
    'friend:cancel_request',
    async ({
      targetId,
      targetUserId
    }) => {
      try {
        const finalTargetId =
          targetId ||
          targetUserId;

        if (
          !currentUser ||
          !finalTargetId
        ) {
          return;
        }

        const reqId =
          `freq_${currentUser.id}_${finalTargetId}`;

        DB.friendRequests.delete(
          reqId
        );

        await supabase
          .from(
            'friend_requests'
          )
          .delete()
          .eq(
            'id',
            reqId
          );

        syncUserData(
          socket,
          currentUser.id
        );

        const targetSockets =
          io.sockets.adapter
            .rooms.get(
              String(
                finalTargetId
              )
            );

        if (
          targetSockets &&
          targetSockets.size
        ) {
          for (
            const socketId
            of targetSockets
          ) {
            const targetSocket =
              io.sockets.sockets.get(
                socketId
              );

            if (
              targetSocket
            ) {
              syncUserData(
                targetSocket,
                finalTargetId
              );
            }
          }
        }

      } catch (error) {
        console.error(
          '❌ Cancel request error:',
          error
        );
      }
    }
  );

  // ===================================================
  // ACCEPT FRIEND
  // ===================================================

  socket.on(
    'friend:accept',
    async ({
      reqId
    }) => {
      try {
        const request =
          DB.friendRequests.get(
            reqId
          );

        if (
          !request ||
          request.status !==
            'pending'
        ) {
          return;
        }

        request.status =
          'accepted';

        const fromId =
          request.fromUserId;

        const toId =
          request.toUserId;

        if (
          !DB.friends.has(
            fromId
          )
        ) {
          DB.friends.set(
            fromId,
            new Set()
          );
        }

        if (
          !DB.friends.has(
            toId
          )
        ) {
          DB.friends.set(
            toId,
            new Set()
          );
        }

        DB.friends
          .get(fromId)
          .add(toId);

        DB.friends
          .get(toId)
          .add(fromId);

        await supabase
          .from(
            'friend_requests'
          )
          .update({
            status:
              'accepted'
          })
          .eq(
            'id',
            reqId
          );

        await supabase
          .from(
            'friends'
          )
          .upsert(
            [
              {
                user_id:
                  fromId,
                friend_id:
                  toId
              },
              {
                user_id:
                  toId,
                friend_id:
                  fromId
              }
            ],
            {
              onConflict:
                'user_id,friend_id'
            }
          );

        saveDB();

        syncUserData(
          socket,
          toId
        );

        const sockets =
          io.sockets.sockets;

        sockets.forEach(
          targetSocket => {
            if (
              targetSocket.id !==
              socket.id
            ) {
              syncUserData(
                targetSocket,
                fromId
              );
            }
          }
        );

        io.to(
          fromId
        ).emit(
          'friend:updated'
        );

        io.to(
          toId
        ).emit(
          'friend:updated'
        );

      } catch (error) {
        console.error(
          '❌ Friend accept error:',
          error
        );
      }
    }
  );

  // ===================================================
  // UNFRIEND
  // ===================================================

  socket.on(
    'friend:unfriend',
    async ({
      friendId
    }) => {
      try {
        if (
          !currentUser ||
          !friendId
        ) {
          return;
        }

        const currentUserId =
          currentUser.id;

        DB.friends
          .get(currentUserId)
          ?.delete(friendId);

        DB.friends
          .get(friendId)
          ?.delete(currentUserId);

        await supabase
          .from('friends')
          .delete()
          .eq(
            'user_id',
            currentUserId
          )
          .eq(
            'friend_id',
            friendId
          );

        await supabase
          .from('friends')
          .delete()
          .eq(
            'user_id',
            friendId
          )
          .eq(
            'friend_id',
            currentUserId
          );

        saveDB();

        syncUserData(
          socket,
          currentUserId
        );

        io.to(
          friendId
        ).emit(
          'friend:updated'
        );

      } catch (error) {
        console.error(
          '❌ Unfriend error:',
          error
        );
      }
    }
  );

  // ===================================================
  // SEND MESSAGE
  // ===================================================

  socket.on(
    'message:send',
    async ({
      roomId,
      content,
      type = 'text'
    }) => {
      try {
        if (
          !currentUser ||
          !content ||
          !roomId
        ) {
          return;
        }

        const userStatus =
          DB.users.get(
            currentUser.id
          );

        if (
          userStatus &&
          userStatus.restrictedUntil &&
          userStatus.restrictedUntil >
            Date.now()
        ) {
          const hoursLeft =
            Math.ceil(
              (
                userStatus.restrictedUntil -
                Date.now()
              ) /
              (
                1000 *
                60 *
                60
              )
            );

          return socket.emit(
            'message:error',
            `Tài khoản của bạn đang bị hạn chế nhắn tin trong ${hoursLeft} giờ tới!`
          );
        }

        if (
          roomId.startsWith('grp_')
        ) {
          const group =
            DB.groups.get(
              roomId
            );

          if (
            group &&
            group.muted.has(
              currentUser.id
            )
          ) {
            return socket.emit(
              'message:error',
              'Bạn đã bị cấm chat trong nhóm này!'
            );
          }
        }

        const message = {
          id:
            generateId('msg'),
          roomId,
          sender:
            {
              id:
                currentUser.id,
              username:
                currentUser.username,
              avatar:
                currentUser.avatar
            },
          content,
          type,
          timestamp:
            Date.now()
        };

        const {
          error
        } = await supabase
          .from('messages')
          .insert({
            id:
              message.id,
            room_id:
              roomId,
            sender_id:
              currentUser.id,
            content,
            type,
            timestamp:
              message.timestamp
          });

        if (error) {
          throw error;
        }

        if (
          !DB.messages.has(
            roomId
          )
        ) {
          DB.messages.set(
            roomId,
            []
          );
        }

        DB.messages
          .get(roomId)
          .push(
            message
          );

        if (
          roomId.startsWith('grp_')
        ) {
          io.to(roomId).emit(
            'message:received',
            message
          );
        } else {
          const parts =
            roomId.split('_DM_');

          if (
            parts.length === 2
          ) {
            io.to(parts[0])
              .to(parts[1])
              .emit(
                'message:received',
                message
              );
          }
        }

      } catch (error) {
        console.error(
          '❌ Message send error:',
          error
        );

        socket.emit(
          'message:error',
          'Không thể gửi tin nhắn!'
        );
      }
    }
  );

  // ===================================================
  // REPORT
  // ===================================================

  socket.on(
    'report:submit',
    async ({
      targetId,
      reason,
      description,
      reporterId,
      reporterName
    }) => {
      try {
        const finalReporterId =
          reporterId ||
          currentUser?.id ||
          null;

        const finalReporterName =
          reporterName ||
          currentUser?.username ||
          'Người dùng';

        if (
          !finalReporterId ||
          !targetId
        ) {
          return;
        }

        let cleanTargetId =
          targetId;

        if (
          cleanTargetId.includes(
            '_DM_'
          )
        ) {
          const parts =
            cleanTargetId.split(
              '_DM_'
            );

          cleanTargetId =
            parts.find(
              id =>
                id !==
                finalReporterId
            ) ||
            parts[0];
        }

        const reportId =
          generateId('rep');

        const targetUser =
          DB.users.get(
            cleanTargetId
          );

        const targetUsername =
          targetUser?.username ||
          cleanTargetId;

        const report = {
          id:
            reportId,
          reporterId:
            finalReporterId,
          reporterName:
            finalReporterName,
          targetId:
            cleanTargetId,
          targetUsername,
          reason:
            reason ||
            'Spam',
          description:
            description ||
            '',
          timestamp:
            Date.now()
        };

        await supabase
          .from('reports')
          .insert({
            id:
              report.id,
            reporter_id:
              report.reporterId,
            reporter_name:
              report.reporterName,
            target_id:
              report.targetId,
            target_username:
              report.targetUsername,
            reason:
              report.reason,
            description:
              report.description,
            timestamp:
              report.timestamp
          });

        DB.reports.set(
          reportId,
          report
        );

        io.emit(
          'admin:new-report',
          Array.from(
            DB.reports.values()
          )
        );

        io.to(
          'admin_room'
        ).emit(
          'admin_notification',
          {
            type:
              'new_report',
            title:
              'Báo cáo vi phạm mới',
            data:
              report
          }
        );

      } catch (error) {
        console.error(
          '❌ Report error:',
          error
        );
      }
    }
  );

  // ===================================================
  // APPEAL
  // ===================================================

  socket.on(
    'appeal:restriction',
    async ({
      reason,
      userId,
      username
    }) => {
      try {
        const finalUserId =
          userId ||
          currentUser?.id ||
          null;

        const finalUsername =
          username ||
          currentUser?.username ||
          'Người dùng';

        if (!finalUserId) {
          return;
        }

        const appealId =
          generateId('apl');

        const appeal = {
          id:
            appealId,
          userId:
            finalUserId,
          username:
            finalUsername,
          reason:
            reason ||
            'Xin gỡ hạn chế',
          timestamp:
            Date.now(),
          status:
            'pending'
        };

        await supabase
          .from('appeals')
          .insert({
            id:
              appeal.id,
            user_id:
              appeal.userId,
            username:
              appeal.username,
            reason:
              appeal.reason,
            timestamp:
              appeal.timestamp,
            status:
              appeal.status
          });

        DB.appeals.set(
          appealId,
          appeal
        );

        io.emit(
          'admin:new-appeal',
          Array.from(
            DB.appeals.values()
          )
        );

        io.to(
          'admin_room'
        ).emit(
          'admin_notification',
          {
            type:
              'restriction_appeal',
            title:
              'Yêu cầu gỡ/giảm hạn chế mới',
            data:
              appeal
          }
        );

      } catch (error) {
        console.error(
          '❌ Appeal error:',
          error
        );
      }
    }
  );

  socket.on(
    'appeal:submit',
    data => {
      socket.emit(
        'appeal:restriction',
        data
      );
    }
  );

  // ===================================================
  // DISCONNECT
  // ===================================================

  socket.on(
    'disconnect',
    async () => {
      if (!currentUser) {
        return;
      }

      currentUser.status =
        'offline';

      DB.users.set(
        currentUser.id,
        currentUser
      );

      try {
        await supabase
          .from('users')
          .update({
            status:
              'offline'
          })
          .eq(
            'id',
            currentUser.id
          );
      } catch (error) {
        console.error(
          '❌ Offline status error:',
          error
        );
      }

      io.to(
        'admin_room'
      ).emit(
        'admin_notification',
        {
          type:
            'user_offline',
          userId:
            currentUser.id
        }
      );

      io.emit(
        'users:sync',
        Array.from(
          DB.users.values()
        )
      );
    }
  );
});

// =====================================================
// START SERVER
// =====================================================

const PORT =
  process.env.PORT || 3000;

async function startServer() {
  try {
    await loadDB();

    server.listen(
      PORT,
      async () => {
        console.log(
          `[*] Web Chat Engine Online on port ${PORT}`
        );

        console.log(
          `[*] Supabase: ${SUPABASE_URL}`
        );

        if (
          process.env.NODE_ENV !==
          'production'
        ) {
          try {
            const url =
              await ngrok.connect({
                addr: PORT,
                authtoken_from_env:
                  true
              });

            console.log(
              `> 🌐 Link Ngrok (Local): ${url}`
            );

          } catch (error) {
            console.log(
              'Không bật ngrok (chạy trên cloud hoặc chưa cấu hình token).'
            );
          }
        }
      }
    );

  } catch (error) {
    console.error(
      '❌ Server không thể khởi động:',
      error
    );

    process.exit(1);
  }
}

startServer();