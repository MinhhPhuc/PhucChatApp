(() => {
  const NOTIFICATION_BUTTON_ID = 'btn-notifications';
  let registration = null;
  let publicKey = '';
  let unread = [];

  function getUser() {
    try {
      return window.state?.currentUser || JSON.parse(localStorage.getItem('user') || '{}');
    } catch (_) {
      return window.state?.currentUser || {};
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
      list.innerHTML = `
        <div class="notification-empty">
          Không có thông báo mới
        </div>
      `;
      return;
    }

    list.innerHTML = unread.map(item => `
      <button
        type="button"
        class="notification-item"
        data-notification-id="${String(item.id).replace(/"/g, '&quot;')}"
      >
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
        window.socket?.emit('notifications:read', { notificationId: id });
        panel.classList.remove('show');
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

      if (Notification?.permission !== 'granted') {
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
        window.showToast?.('Trình duyệt này không hỗ trợ thông báo đẩy.', false);
        return;
      }

      const config = await fetchConfig();
      if (!config.enabled || !publicKey) {
        window.showToast?.('Server chưa cấu hình Web Push.', false);
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        window.showToast?.('Bạn chưa cho phép thông báo.', false);
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

      window.socket?.emit('push:subscribe', {
        subscription: subscription.toJSON()
      });

      localStorage.setItem('push_notifications_enabled', '1');
      window.showToast?.('Đã bật thông báo trên thiết bị này!');
    } catch (error) {
      console.error('[PUSH] Enable error:', error);
      window.showToast?.('Không thể bật thông báo. Hãy thử lại.', false);
    }
  }

  function bindSocket() {
    if (!window.socket) return;

    window.socket.on('notifications:sync', list => {
      unread = Array.isArray(list) ? list : [];
      updateBadge();
      renderPanel();
    });

    window.socket.on('push:subscribed', () => {
      localStorage.setItem('push_notifications_enabled', '1');
    });

    window.socket.on('push:error', message => {
      window.showToast?.(message || 'Không thể bật thông báo.', false);
    });

    window.socket.on('auth:success', () => {
      window.socket.emit('notifications:get');
      addBell();
    });

    window.socket.on('connect', () => {
      if (getUser()?.id) {
        window.socket.emit('notifications:get');
      }
    });
  }

  function boot() {
    addBell();
    bindSocket();

    if (localStorage.getItem('push_notifications_enabled') === '1' && Notification?.permission === 'granted') {
      enablePushNotifications().catch(() => {});
    }
  }

  window.enablePushNotifications = enablePushNotifications;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
