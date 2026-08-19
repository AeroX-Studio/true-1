const {
  MIN_DEPOSIT,
  UDDOKTAPAY_API_KEY,
  getUddoktaApiUrl,
  AuthError,
  handleCors,
  getSiteUrl,
  authenticate,
  getAccessToken,
  rtdbGet,
  rtdbPush,
  rtdbUpdate
} = require('./utils');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // 1. Authenticate Firebase ID Token
    const user = await authenticate(req);

    // 2. Validate deposit amount
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const amount = Number(body.amount);
    if (!amount || isNaN(amount) || amount < MIN_DEPOSIT) {
      return res.status(400).json({ error: `Minimum deposit amount is ৳${MIN_DEPOSIT}.` });
    }

    // 3. Get Firebase access token & user data
    const accessToken = await getAccessToken();
    const userData = await rtdbGet(`users/${user.uid}`, accessToken);
    if (!userData) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    // 4. Create internal deposit record
    const depositData = {
      user_id: user.uid,
      username: userData.username || 'Unknown',
      email: userData.email || '',
      amount: amount,
      status: 'initiated',
      invoice_id: null,
      payment_url: null,
      payment_method: null,
      sender_number: null,
      uddoktapay_transaction_id: null,
      uddoktapay_fee: null,
      charged_amount: null,
      credited: false,
      failure_reason: null,
      created_at: new Date().toISOString(),
      verified_at: null
    };

    const depositId = await rtdbPush('deposits', depositData, accessToken);

    // 5. Call UddoktaPay checkout API
    const siteUrl = getSiteUrl(req);
    let uddoktaResponse;
    try {
      const uddoktaRes = await fetch(getUddoktaApiUrl('checkout-v2'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'RT-UDDOKTAPAY-API-KEY': UDDOKTAPAY_API_KEY
        },
        body: JSON.stringify({
          full_name: userData.username || 'Veltrix User',
          email: userData.email || `${user.uid}@veltrix.app`,
          amount: amount.toString(),
          metadata: { deposit_id: depositId, user_id: user.uid },
          redirect_url: `${siteUrl}/index.html`,
          cancel_url: `${siteUrl}/index.html?payment=cancelled&deposit_id=${depositId}`,
          return_type: 'GET'
        })
      });

      uddoktaResponse = await uddoktaRes.json();
      if (!uddoktaResponse || !uddoktaResponse.payment_url) {
        throw new Error(uddoktaResponse?.message || 'No payment URL received from UddoktaPay');
      }
    } catch (err) {
      await rtdbUpdate(`deposits/${depositId}`, {
        status: 'failed',
        failure_reason: `UddoktaPay error: ${err.message}`,
        verified_at: new Date().toISOString()
      }, accessToken);
      return res.status(500).json({ error: 'Failed to create payment gateway session. Please try again.' });
    }

    // 6. Extract invoice_id from response or parse from payment_url
    let invoiceId = uddoktaResponse.invoice_id || null;
    if (!invoiceId && uddoktaResponse.payment_url) {
      try {
        const urlParts = uddoktaResponse.payment_url.split('/');
        invoiceId = urlParts[urlParts.length - 1].split('?')[0] || null;
      } catch (e) {}
    }

    // 7. Update deposit record with invoice and payment URL
    await rtdbUpdate(`deposits/${depositId}`, {
      invoice_id: invoiceId,
      payment_url: uddoktaResponse.payment_url,
      status: 'awaiting_payment'
    }, accessToken);

    return res.status(200).json({
      payment_url: uddoktaResponse.payment_url,
      deposit_id: depositId,
      invoice_id: invoiceId
    });

  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error in create-charge handler:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
