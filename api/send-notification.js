const {
  handleCors,
  authenticate,
  getAccessToken,
  rtdbGet,
  rtdbPush,
  rtdbUpdate,
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  formatOneSignalAuthHeader,
  AuthError
} = require('./utils');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed. Use POST or GET.' });
  }

  try {
    // 1. Authenticate Firebase ID Token
    const user = await authenticate(req);
    const userToken = user.token;

    // 2. Resolve database token (Service Account OAuth Token with User ID Token fallback)
    let tokenToUse = userToken;
    try {
      tokenToUse = await getAccessToken();
    } catch (saErr) {
      console.warn('[send-notification] Service Account token not active, falling back to user token:', saErr.message);
    }

    // 3. Fetch user profile and verify Admin or Moderator privileges
    const userData = await rtdbGet(`users/${user.uid}`, tokenToUse);
    if (!userData) {
      return res.status(404).json({ error: 'User account not found in database.' });
    }

    const role = userData.role || 'user';
    if (role !== 'admin' && role !== 'moderator') {
      return res.status(403).json({ error: 'Access denied. Only Admins and authorized Moderators can access Push Notifications.' });
    }

    if (role === 'moderator') {
      const perms = userData.mod_permissions || {};
      if (perms.send_notifications === false) {
        return res.status(403).json({ error: 'Your moderator account does not have permission to dispatch notifications.' });
      }
    }

    // 4. Resolve active OneSignal Credentials (RTDB app_settings/onesignal with Environment / Default fallback)
    let appId = ONESIGNAL_APP_ID;
    let apiKey = ONESIGNAL_REST_API_KEY;
    let rtdbNeedsSync = false;

    try {
      const osSettings = await rtdbGet('app_settings/onesignal', tokenToUse);
      if (osSettings && typeof osSettings === 'object') {
        if (osSettings.app_id && typeof osSettings.app_id === 'string' && osSettings.app_id.trim()) {
          appId = osSettings.app_id.trim();
        }
        if (osSettings.rest_api_key && typeof osSettings.rest_api_key === 'string' && osSettings.rest_api_key.trim() && !osSettings.rest_api_key.includes('YOUR_')) {
          apiKey = osSettings.rest_api_key.trim();
        } else {
          rtdbNeedsSync = true;
        }
      } else {
        rtdbNeedsSync = true;
      }
    } catch (dbErr) {
      console.warn('[send-notification] Failed to read RTDB onesignal config, using default credentials:', dbErr.message);
    }

    // Auto-sync active settings to RTDB if uninitialized so Admin Panel reflects current configuration
    if (rtdbNeedsSync && appId && apiKey) {
      rtdbUpdate('app_settings/onesignal', {
        app_id: appId,
        rest_api_key: apiKey,
        auto_synced: true,
        updated_at: new Date().toISOString()
      }, tokenToUse).catch(() => {});
    }

    // Clean and validate API Key
    apiKey = (apiKey || '').trim().replace(/^["']|["']$/g, '');
    appId = (appId || '').trim().replace(/^["']|["']$/g, '');

    if (!apiKey || apiKey.includes('YOUR_') || apiKey === '') {
      return res.status(400).json({
        error: 'OneSignal REST API Key is not configured. Please enter your valid OneSignal REST API Key in Admin Panel → Settings & Config → OneSignal Push Engine.'
      });
    }

    if (!appId || appId === '') {
      return res.status(400).json({
        error: 'OneSignal App ID is not configured. Please enter your OneSignal App ID in Admin Panel → Settings & Config.'
      });
    }

    // Parse request body or query
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = req.query?.action || body.action || (req.method === 'GET' ? 'status' : 'send');

    // ── Handle Connection Test / Status Check ──
    if (action === 'test' || body.test_only === true) {
      const authHeader = formatOneSignalAuthHeader(apiKey);
      try {
        const testPayload = {
          app_id: appId,
          headings: { en: 'Connectivity Test' },
          contents: { en: 'Testing OneSignal REST API credentials.' },
          included_segments: ['Subscribed Users']
        };

        const testRes = await fetch('https://api.onesignal.com/notifications', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': authHeader
          },
          body: JSON.stringify(testPayload)
        });

        const testData = await testRes.json().catch(() => ({}));

        if (testRes.ok || (testData && testData.id)) {
          return res.status(200).json({
            success: true,
            status: 'connected',
            app_id: appId,
            notification_id: testData.id || null,
            recipients: testData.recipients || 0,
            message: 'OneSignal REST API credentials are valid and active!'
          });
        }

        const errMsg = testData?.errors ? (Array.isArray(testData.errors) ? testData.errors.join(', ') : JSON.stringify(testData.errors)) : `OneSignal response HTTP ${testRes.status}`;
        return res.status(testRes.status === 401 ? 401 : 400).json({
          success: false,
          error: `OneSignal API Test Failed: ${errMsg}`
        });
      } catch (testErr) {
        return res.status(500).json({
          success: false,
          error: `Failed to connect to OneSignal: ${testErr.message}`
        });
      }
    }

    if (action === 'status' && req.method === 'GET') {
      return res.status(200).json({
        success: true,
        configured: true,
        app_id: appId,
        key_preview: apiKey.slice(0, 12) + '...' + apiKey.slice(-6)
      });
    }

    // ── Parse & Validate Notification Payload ──
    const title = (body.title || '').trim();
    const message = (body.message || body.body || '').trim();
    const target = body.target || 'all';
    const imageUrl = (body.image_url || body.imageUrl || '').trim();
    const actionUrl = (body.url || body.actionUrl || '').trim();
    const tournamentId = body.tournament_id || body.tournamentId || null;
    let targetUids = Array.isArray(body.target_uids) ? body.target_uids.filter(Boolean) : [];

    if (!title) {
      return res.status(400).json({ error: 'Notification title is required.' });
    }
    if (!message) {
      return res.status(400).json({ error: 'Notification message is required.' });
    }

    if (target === 'tournament') {
      if (!tournamentId) {
        return res.status(400).json({ error: 'Tournament ID is required when targeting tournament players.' });
      }
      const participants = await rtdbGet(`participants/${tournamentId}`, tokenToUse) || {};
      targetUids = Object.keys(participants);
      if (targetUids.length === 0) {
        return res.status(400).json({ error: 'No registered players found in this tournament.' });
      }
    }

    // Construct OneSignal payload
    const osPayload = {
      app_id: appId,
      headings: { en: title.slice(0, 120) },
      contents: { en: message.slice(0, 500) }
    };

    if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'))) {
      osPayload.big_picture = imageUrl;
      osPayload.chrome_web_image = imageUrl;
      osPayload.ios_attachments = { id1: imageUrl };
    }

    if (actionUrl) {
      osPayload.url = actionUrl;
    }

    if (target === 'tournament' || target === 'uids') {
      osPayload.include_aliases = { external_id: targetUids };
      osPayload.include_external_user_ids = targetUids;
    } else if (target === 'tags' && body.tags && typeof body.tags === 'object') {
      const filters = [];
      Object.entries(body.tags).forEach(([k, v], idx) => {
        if (idx > 0) filters.push({ operator: 'OR' });
        filters.push({ field: 'tag', key: k, relation: '=', value: String(v) });
      });
      osPayload.filters = filters;
    } else {
      osPayload.included_segments = ['Total Subscriptions', 'Subscribed Users'];
    }

    // Dispatch via OneSignal REST API securely
    const authHeader = formatOneSignalAuthHeader(apiKey);
    const osResponse = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': authHeader
      },
      body: JSON.stringify(osPayload)
    });

    const osData = await osResponse.json().catch(() => ({}));

    if (!osResponse.ok && (!osData || !osData.id)) {
      const errMsg = (osData && osData.errors) ? (Array.isArray(osData.errors) ? osData.errors.join(', ') : JSON.stringify(osData.errors)) : `OneSignal dispatch failed (HTTP ${osResponse.status})`;
      if (osResponse.status === 401) {
        return res.status(401).json({
          error: `OneSignal Authentication Failed: Invalid REST API Key. (${errMsg})`
        });
      }
      return res.status(502).json({ error: errMsg });
    }

    // Record to push_notifications_history
    const historyData = {
      onesignal_id: osData.id || null,
      title,
      message,
      target,
      tournament_id: tournamentId || null,
      image_url: imageUrl || null,
      url: actionUrl || null,
      sender_uid: user.uid,
      sender_name: userData.username || (role === 'admin' ? 'Admin' : 'Moderator'),
      sender_role: role,
      recipients: osData.recipients ?? (target === 'tournament' ? targetUids.length : 0),
      status: 'delivered',
      created_at: new Date().toISOString()
    };

    let pushKey = null;
    try {
      pushKey = await rtdbPush('push_notifications_history', historyData, tokenToUse);
    } catch (histErr) {
      console.warn('[send-notification] Failed to write push history log:', histErr.message);
    }

    const recipientsCount = osData.recipients ?? (target === 'tournament' ? targetUids.length : 0);
    return res.status(200).json({
      success: true,
      notification_id: osData.id || pushKey,
      recipients: recipientsCount,
      message: `Push notification dispatched successfully to ${target === 'all' ? 'all app devices' : targetUids.length + ' player(s)'}!`
    });

  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('send-notification error:', err);
    return res.status(500).json({ error: 'Failed to send notification: ' + err.message });
  }
};
