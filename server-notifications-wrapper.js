const fs = require('fs');
const path = require('path');
const Module = require('module');

const serverPath = path.join(__dirname, 'server.js');
let source = fs.readFileSync(serverPath, 'utf8');

function inject(anchor, replacement, label) {
  if (!source.includes(anchor)) {
    throw new Error(`❌ Không tìm thấy anchor để cài notifications: ${label}`);
  }
  source = source.replace(anchor, replacement);
}

// 1) Load web-push helper.
inject(
  "const helmet = require('helmet');",
  "const helmet = require('helmet');\nconst notifications = require('./notifications-server');",
  'notifications require'
);

// 2) Public VAPID key endpoint + inject the client script without forcing a large index.html rewrite.
inject(
  "app.use(express.static(path.join(__dirname, 'public')));",
  `app.get('/api/push/public-key', (req, res) => {
  res.json({
    enabled: notifications.enabled,
    publicKey: notifications.publicKey()
  });
});

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    const originalSendFile = res.sendFile.bind(res);
    res.sendFile = (filePath, options, callback) => {
      return originalSendFile(filePath, options, (error) => {
        if (callback) callback(error);
      });
    };
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));`,
  'push public key route'
);

// 3) Socket handlers for subscriptions and in-app notifications.
inject(
  "  let currentUser = null;\n",
  `  let currentUser = null;

  socket.on('push:subscribe', async ({ subscription }) => {
    try {
      if (!currentUser || !subscription) return;
      await notifications.saveSubscription(supabase, currentUser.id, subscription);
      socket.emit('push:subscribed');
    } catch (error) {
      console.error('❌ Push subscribe error:', error);
      socket.emit('push:error', 'Không thể bật thông báo trên thiết bị này.');
    }
  });

  socket.on('push:unsubscribe', async ({ endpoint }) => {
    try {
      if (!currentUser || !endpoint) return;
      await notifications.removeSubscription(supabase, endpoint);
    } catch (error) {
      console.error('❌ Push unsubscribe error:', error);
    }
  });

  socket.on('notifications:get', async () => {
    try {
      if (!currentUser) return;
      const list = await notifications.getUnread(supabase, currentUser.id);
      socket.emit('notifications:sync', list);
    } catch (error) {
      console.error('❌ Notifications load error:', error);
      socket.emit('notifications:sync', []);
    }
  });

  socket.on('notifications:read', async ({ notificationId }) => {
    try {
      if (!currentUser) return;
      await notifications.markRead(supabase, currentUser.id, notificationId || null);
      const list = await notifications.getUnread(supabase, currentUser.id);
      socket.emit('notifications:sync', list);
    } catch (error) {
      console.error('❌ Notifications read error:', error);
    }
  });
`,
  'socket notification handlers'
);

// 4) Call notification: only push when the target is not currently online.
inject(
  `    const receiverRoomId =
        String(targetUser.id);

    io.to(
      receiverRoomId
    ).emit(`,
  `    const receiverRoomId =
        String(targetUser.id);

    if (targetUser.status !== 'online') {
      notifications.notifyUser(supabase, targetUser.id, {
        type: data.isVideo ? 'video_call' : 'voice_call',
        title: data.callerName || (currentUser ? currentUser.username : 'Cuộc gọi đến'),
        body: data.isVideo ? 'Cuộc gọi video đến' : 'Cuộc gọi thoại đến',
        data: { fromUserId: currentUser?.id || null, isVideo: !!data.isVideo }
      }).catch(error => console.error('❌ Call notification error:', error));
    }

    io.to(
      receiverRoomId
    ).emit(`,
  'call notification hook'
);

// 5) Message notification: store in Supabase for every recipient and push only when offline.
inject(
  `        DB.messages
          .get(roomId)
          .push(
            message
          );

        if (
          roomId.startsWith('grp_')
        ) {`,
  `        DB.messages
          .get(roomId)
          .push(
            message
          );

        const notificationTargets = new Set();

        if (roomId.startsWith('grp_')) {
          const groupForNotification = DB.groups.get(roomId);
          if (groupForNotification) {
            groupForNotification.members.forEach(memberId => {
              if (memberId !== currentUser.id) notificationTargets.add(memberId);
            });
          }
        } else {
          const dmPartsForNotification = roomId.split('_DM_');
          dmPartsForNotification.forEach(memberId => {
            if (memberId && memberId !== currentUser.id) notificationTargets.add(memberId);
          });
        }

        await Promise.all(Array.from(notificationTargets).map(async targetId => {
          const targetUserForNotification = DB.users.get(targetId);
          if (!targetUserForNotification || targetUserForNotification.status === 'online') return;

          try {
            await notifications.notifyUser(supabase, targetId, {
              type: 'message',
              title: currentUser.username,
              body: type === 'image' ? 'Đã gửi một hình ảnh' : String(content).slice(0, 120),
              data: { roomId, senderId: currentUser.id }
            });
          } catch (error) {
            console.error('❌ Message notification error:', error);
          }
        }));

        if (
          roomId.startsWith('grp_')
        ) {`,
  'message notification hook'
);

// 6) Friend-request notification.
inject(
  `        DB.friendRequests.set(
          reqId,
          request
        );

        io.to(
          finalTargetId
        ).emit(`,
  `        DB.friendRequests.set(
          reqId,
          request
        );

        const targetUserForNotification = DB.users.get(finalTargetId);
        if (!targetUserForNotification || targetUserForNotification.status !== 'online') {
          notifications.notifyUser(supabase, finalTargetId, {
            type: 'friend_request',
            title: currentUser.username,
            body: 'Đã gửi cho bạn một lời mời kết bạn',
            data: { fromUserId: currentUser.id }
          }).catch(error => console.error('❌ Friend notification error:', error));
        }

        io.to(
          finalTargetId
        ).emit(`,
  'friend notification hook'
);

const serverModule = new Module(serverPath, module);
serverModule.filename = serverPath;
serverModule.paths = Module._nodeModulePaths(path.dirname(serverPath));
serverModule._compile(source, serverPath);
