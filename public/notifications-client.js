(() => {
  const NOTIFICATION_BUTTON_ID = 'btn-notifications';
  let registration = null;
  let publicKey = '';
  let unread = [];
  let notifySocket = null;
  let lastAuthToken = null;

  function getPermission() {
    return 'Notification' in window ? window.Notification.permission : 'denied';
  }

  function getUserToken() {
    return localStorage.getItem('chat_session_token') || null;
  }

  function showToastSafe(message, success = true) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, success);
    }
  }

  function updateBadge() {
    const button = document.getElementById(NOTIFICATION_BUTTON_ID);
    if (!button) return;

    let badge = button.querySelector('.notification-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'notification-badge';
      button.appendChild(badge);
    }

    badge.textContent = String(unread.length);
    badge.style.display = unread.length ? 'flex' : 'none';
  }

  function renderPanel() {
    let panel = document.getElementById('notification-panel');

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'notification-panel';
      panel.innerHTML = `
        <div class="notification-panel-header">
          <strong>Thông báo</strong>
          <button id="notification-close" type="button" aria-label="Đóng">×</button>
        </div>
        <div id="notification-list" class="notification-list"></div>
      `;
      document.body.appendChild(panel);

      panel.querySelector('#notification-close').addEventListener('click', () => {
        panel.classList.remove('show');
      });
    }

    const list = panel.querySelector('#notification-list');

    if (!unread.length) {
      list.innerHTML = '<div class="notification-empty">Không có thông báo mới</div>';
      return;
    }

    list.innerHTML = unread.map(item => `
      <button type="button" class="notification-item" data-notification-id="${escapeHtml(item.id)}">
        <div class="notification-icon">🔔</div>
        <div class="notification-content">
          <strong>${escapeHtml(item.title || 'PhucChatApp')}</strong>
          <span>${escapeHtml(item.body || '')}</span>
          <small>${formatTime(item.created_at)}</small>
        </div>
      </button>
    `).join('');

    list.querySelectorAll('.notification-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-notification-id');
        notifySocket?.emit('notifications:read', { notificationId: id });
      });
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit'
    });
  }

  function addBell() {
    const actions = document.querySelector('.header-actions');
    if (!actions || document.getElementById(NOTIFICATION_BUTTON_ID)) return;

    const button = document.createElement('button');
    button.id = NOTIFICATION_BUTTON_ID;
    button.type = 'button';
    button.className = 'icon-btn notification-button';
    button.title = 'Thông báo';
    button.setAttribute('aria-label', 'Thông báo');
    button.innerHTML = '<i class="fa-solid fa-bell"></i><span class="notification-badge">0</span>';

    button.addEventListener('click', async () => {
      const panel = document.getElementById('notification-panel');
      renderPanel();
      panel?.classList.toggle('show');

      if (getPermission() !== 'granted') {
        await enablePushNotifications();
      }
    });

    actions.insertBefore(button, actions.firstChild);
    updateBadge();
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
  }

  async function fetchConfig() {
    const response = await fetch('/api/push/public-key', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Push config HTTP ${response.status}`);
    const data = await response.json();
    publicKey = data.publicKey || '';
    return data;
  }

  async function enablePushNotifications() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        showToastSafe('Trình duyệt này không hỗ trợ thông báo đẩy.', false);
        return;
      }

      const config = await fetchConfig();
      if (!config.enabled || !publicKey) {
        showToastSafe('Server chưa cấu hình Web Push.', false);
        return;
      }

      const permission = await window.Notification.requestPermission();
      if (permission !== 'granted') {
        showToastSafe('Bạn chưa cho phép thông báo.', false);
        return;
      }

      registration = await navigator.serviceWorker.register('/service-worker.js');
      await navigator.serviceWorker.ready;

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey)
        });
      }

      notifySocket?.emit('push:subscribe', {
        subscription: subscription.toJSON()
      });

      localStorage.setItem('push_notifications_enabled', '1');
      showToastSafe('Đã bật thông báo trên thiết bị này!');
    } catch (error) {
      console.error('[PUSH] Enable error:', error);
      showToastSafe('Không thể bật thông báo. Hãy thử lại.', false);
    }
  }

  function authenticateNotificationSocket() {
    if (!notifySocket) return;

    const token = getUserToken();
    if (!token || token === lastAuthToken) return;

    lastAuthToken = token;
    notifySocket.emit('auth:session', { userId: token });
  }

  function bindNotificationSocket() {
    if (!window.io || notifySocket) return;

    notifySocket = window.io();

    notifySocket.on('connect', () => {
      authenticateNotificationSocket();
    });

    notifySocket.on('auth:success', () => {
      notifySocket.emit('notifications:get');
    });

    notifySocket.on('notifications:sync', list => {
      unread = Array.isArray(list) ? list : [];
      updateBadge();
      renderPanel();
    });

    notifySocket.on('push:subscribed', () => {
      localStorage.setItem('push_notifications_enabled', '1');
    });

    notifySocket.on('push:error', message => {
      showToastSafe(message || 'Không thể bật thông báo.', false);
    });
  }

  function boot() {
    addBell();
    bindNotificationSocket();
    authenticateNotificationSocket();

    if (localStorage.getItem('push_notifications_enabled') === '1' && getPermission() === 'granted') {
      enablePushNotifications().catch(() => {});
    }

    // auth.js của app dùng localStorage cho session token. Kiểm tra thay đổi khi người dùng vừa đăng nhập.
    setInterval(() => {
      authenticateNotificationSocket();
    }, 1000);
  }

  window.enablePushNotifications = enablePushNotifications;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
