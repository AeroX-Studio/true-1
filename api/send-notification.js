const {
  handleCors,
  authenticate,
  getAccessToken,
  rtdbGet,
  rtdbPush,
  AuthError
} = require('./utils');

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '421b1a39-54f8-45bd-84b8-aee27bba64c5';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY || 'os_v2_app_iinruoku7bc33bfyv3rhxoteyvkootsciqwuqv5t5xov2w7tgn2mqtvylcsehyqpt47urzyi5i2uc4abejmf6xxh5jh34bmlql5a45y';

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // 1. Authenticate Firebase ID Token
    const user = await authenticate(req);

    // 2. Fetch user profile and verify Admin or Moderator role
    const accessToken = await getAccessToken();
    const userData = await rtdbGet(`users/${user.uid}`, accessToken);

    if (!userData) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const role = userData.role || 'user';
    if (role !== 'admin' && role !== 'moderator') {
      return res.status(403).json({ error: 'Access denied. Only Admins and Moderators can send push broadcasts.' });
    }

    if (role === 'moderator') {
      const perms = userData.mod_permissions || {};
      if (perms.send_notifications === false) {
        return res.status(403).json({ error: 'Your moderator account does not have permission to send notifications.' });
      }
    }

    // 3. Parse & Validate notification payload
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const title = (body.title || '').trim();
    const message = (body.message || body.body || '').trim();
    const target = body.target || 'all';
    const imageUrl = (body.image_url || body.imageUrl || '').trim();
    const actionUrl = (body.url || body.actionUrl || '').trim();
    const tournamentId = body.tournament_id || body.tournamentId || null;
    let targetUids = Array.isArray(body.target_uids) ? body.target_uids : [];

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
      const participants = await rtdbGet(`participants/${tournamentId}`, accessToken) || {};
      targetUids = Object.keys(participants);
      if (targetUids.length === 0) {
        return res.status(400).json({ error: 'No registered players found in this tournament.' });
      }
    }

    // 4. Construct OneSignal payload
    const osPayload = {
      app_id: ONESIGNAL_APP_ID,
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

    // 5. Dispatch via OneSignal REST API securely from server
    const osResponse = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify(osPayload)
    });

    const osData = await osResponse.json();

    if (!osResponse.ok && (!osData || !osData.id)) {
      const errMsg = (osData && osData.errors) ? (Array.isArray(osData.errors) ? osData.errors.join(', ') : JSON.stringify(osData.errors)) : 'OneSignal dispatch failed';
      return res.status(502).json({ error: errMsg });
    }

    // 6. Record to push_notifications_history
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
      recipients: osData.recipients || (target === 'tournament' ? targetUids.length : 0),
      status: 'delivered',
      created_at: new Date().toISOString()
    };

    const pushKey = await rtdbPush('push_notifications_history', historyData, accessToken);

    return res.status(200).json({
      success: true,
      notification_id: osData.id || pushKey,
      recipients: osData.recipients || (target === 'tournament' ? targetUids.length : 0),
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
