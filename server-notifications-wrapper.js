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

inject(
  "const helmet = require('helmet');",
  "const helmet = require('helmet');\nconst notifications = require('./notifications-server');",
  'notifications require'
);

// Inject push API + a small HTML wrapper before Express static files.
inject(
  "app.use(express.static(path.join(__dirname, 'public')));",
  `app.get('/api/push/public-key', (req, res) => {
  res.json({
    enabled: notifications.enabled,
    publicKey: notifications.publicKey()
  });
});

app.get('/', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (error, html) => {
    if (error) return next(error);
    const injectedHtml = html.replace(
      '</head>',
      '<link rel="stylesheet" href="/notifications.css"></head>'
    ).replace(
      '</body>',
      '<script src="/notifications-client.js"></script></body>'
    );
    res.type('html').send(injectedHtml);
  });
});

app.get('/index.html', (req, res, next) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (error, html) => {
    if (error) return next(error);
    const injectedHtml = html.replace(
      '</head>',
      '<link rel="stylesheet" href="/notifications.css"></head>'
    ).replace(
      '</body>',
      '<script src="/notifications-client.js"></script></body>'
    );
    res.type('html').send(injectedHtml);
  });
});

app.use(express.static(path.join(__dirname, 'public')));`,
  'push endpoint and client injection'
);

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
