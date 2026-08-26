const webpush = require('web-push');

function configure() {
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!subject || !publicKey || !privateKey) {
    console.warn('⚠️ Web Push chưa được cấu hình: thiếu VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

const enabled = configure();

function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

async function saveSubscription(supabase, userId, subscription) {
  if (!userId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Push subscription không hợp lệ.');
  }

  const id = `push_${Buffer.from(subscription.endpoint).toString('base64url').slice(0, 32)}`;

  const { error } = await supabase.from('push_subscriptions').upsert({
    id,
    user_id: userId,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    updated_at: new Date().toISOString()
  }, { onConflict: 'endpoint' });

  if (error) throw error;
}

async function removeSubscription(supabase, endpoint) {
  if (!endpoint) return;
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

async function createNotification(supabase, userId, notification) {
  const row = {
    id: `noti_${Math.random().toString(36).slice(2, 11)}`,
    user_id: userId,
    type: notification.type || 'system',
    title: notification.title || 'PhucChatApp',
    body: notification.body || '',
    data: notification.data || {},
    is_read: false
  };

  const { data, error } = await supabase.from('notifications').insert(row).select().single();
  if (error) throw error;
  return data;
}

async function getSubscriptions(supabase, userId) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', userId);

  if (error) throw error;
  return data || [];
}

async function sendPushToUser(supabase, userId, payload) {
  if (!enabled || !userId) return;

  const subscriptions = await getSubscriptions(supabase, userId);
  const body = JSON.stringify(payload);

  await Promise.all(subscriptions.map(async subscriptionRow => {
    const subscription = {
      endpoint: subscriptionRow.endpoint,
      keys: {
        p256dh: subscriptionRow.p256dh,
        auth: subscriptionRow.auth
      }
    };

    try {
      await webpush.sendNotification(subscription, body, {
        TTL: 120,
        urgency: 'high'
      });
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await removeSubscription(supabase, subscriptionRow.endpoint);
        return;
      }

      console.error('❌ Web Push error:', error?.message || error);
    }
  }));
}

async function notifyUser(supabase, userId, notification) {
  const saved = await createNotification(supabase, userId, notification);

  try {
    await sendPushToUser(supabase, userId, {
      title: saved.title,
      body: saved.body,
      type: saved.type,
      notificationId: saved.id,
      data: saved.data || {}
    });
  } catch (error) {
    console.error('❌ Push send failed:', error?.message || error);
  }

  return saved;
}

async function getUnread(supabase, userId) {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;
  return data || [];
}

async function markRead(supabase, userId, notificationId) {
  const query = supabase
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId);

  const { error } = notificationId
    ? await query.eq('id', notificationId)
    : await query.eq('is_read', false);

  if (error) throw error;
}

module.exports = {
  enabled,
  publicKey,
  saveSubscription,
  removeSubscription,
  notifyUser,
  getUnread,
  markRead
};
