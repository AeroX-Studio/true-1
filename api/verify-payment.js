const {
  UDDOKTAPAY_API_KEY,
  getUddoktaApiUrl,
  AuthError,
  handleCors,
  authenticate,
  getAccessToken,
  rtdbGet,
  rtdbQuery,
  rtdbConditionalSet,
  rtdbGetWithEtag,
  rtdbPutWithEtag,
  rtdbUpdate,
  rtdbPush
} = require('./utils');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // 1. Authenticate Firebase ID Token
    const user = await authenticate(req);

    // 2. Validate invoice_id
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const invoiceId = body.invoice_id;
    if (!invoiceId || typeof invoiceId !== 'string') {
      return res.status(400).json({ error: 'invoice_id is required.' });
    }

    // 3. Get Firebase access token
    const accessToken = await getAccessToken();

    // 4. Verify with UddoktaPay first to obtain gateway confirmation and metadata
    let verifyResult;
    try {
      const uddoktaRes = await fetch(getUddoktaApiUrl('verify-payment'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'RT-UDDOKTAPAY-API-KEY': UDDOKTAPAY_API_KEY
        },
        body: JSON.stringify({ invoice_id: invoiceId })
      });

      verifyResult = await uddoktaRes.json();
      if (!verifyResult || typeof verifyResult !== 'object' || !verifyResult.status) {
        throw new Error(verifyResult?.message || 'Invalid response received from UddoktaPay verify endpoint');
      }
    } catch (err) {
      return res.status(500).json({ error: `Payment verification failed: ${err.message}` });
    }

    // 5. Lookup internal deposit record (Primary: by metadata.deposit_id, Fallback: by invoice_id query)
    let depositId = (verifyResult.metadata && verifyResult.metadata.deposit_id) ? verifyResult.metadata.deposit_id : null;
    let deposit = null;

    if (depositId) {
      deposit = await rtdbGet(`deposits/${depositId}`, accessToken);
    }

    if (!deposit) {
      const deposits = await rtdbQuery('deposits', 'invoice_id', invoiceId, accessToken);
      if (deposits && Object.keys(deposits).length > 0) {
        depositId = Object.keys(deposits)[0];
        deposit = deposits[depositId];
      }
    }

    if (!deposit) {
      return res.status(404).json({ error: 'No deposit record found for this invoice.' });
    }

    // 6. Idempotency Check — Already credited?
    if (deposit.credited === true) {
      return res.status(200).json({
        status: 'already_processed',
        amount: deposit.amount,
        message: 'This payment has already been credited to your wallet.'
      });
    }

    // 7. Verify user ownership
    if (deposit.user_id !== user.uid) {
      return res.status(403).json({ error: 'This deposit does not belong to you.' });
    }

    // 8. Process based on status
    if (verifyResult.status === 'COMPLETED') {
      const paidAmount = Number(verifyResult.amount);
      const expectedAmount = Number(deposit.amount);
      if (paidAmount !== expectedAmount) {
        await rtdbUpdate(`deposits/${depositId}`, {
          status: 'failed',
          invoice_id: invoiceId,
          failure_reason: `Amount mismatch: expected ৳${expectedAmount}, got ৳${paidAmount}`,
          verified_at: new Date().toISOString()
        }, accessToken);
        return res.status(400).json({ error: 'Payment amount does not match the deposit request.' });
      }

      if (verifyResult.invoice_id && verifyResult.invoice_id !== invoiceId) {
        await rtdbUpdate(`deposits/${depositId}`, {
          status: 'failed',
          invoice_id: invoiceId,
          failure_reason: 'Invoice ID mismatch from UddoktaPay',
          verified_at: new Date().toISOString()
        }, accessToken);
        return res.status(400).json({ error: 'Transaction identity verification failed.' });
      }

      // Step A: Atomic conditional set credited = true
      const creditSet = await rtdbConditionalSet(
        `deposits/${depositId}/credited`, false, true, accessToken
      );

      if (!creditSet) {
        return res.status(200).json({
          status: 'already_processed',
          amount: deposit.amount,
          message: 'This payment has already been credited to your wallet.'
        });
      }

      // Step B: Atomic wallet increment (optimistic locking via ETag)
      const walletPath = `users/${deposit.user_id}/wallet_balance`;
      let walletUpdated = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const { value: currentBalance, etag } = await rtdbGetWithEtag(walletPath, accessToken);
        const newBalance = (Number(currentBalance) || 0) + expectedAmount;
        walletUpdated = await rtdbPutWithEtag(walletPath, newBalance, etag, accessToken);
        if (walletUpdated) break;
        await new Promise(r => setTimeout(r, 100));
      }

      if (!walletUpdated) {
        console.error(`CRITICAL: credited=true but wallet update failed for deposit ${depositId}`);
      }

      // Step C: Update deposit record
      await rtdbUpdate(`deposits/${depositId}`, {
        status: 'completed',
        invoice_id: invoiceId,
        payment_method: verifyResult.payment_method || null,
        sender_number: verifyResult.sender_number || null,
        uddoktapay_transaction_id: verifyResult.transaction_id || null,
        uddoktapay_fee: verifyResult.fee || null,
        charged_amount: verifyResult.charged_amount || null,
        verified_at: new Date().toISOString()
      }, accessToken);

      // Step D: Record in transactions
      await rtdbPush(`transactions/${deposit.user_id}`, {
        amount: expectedAmount,
        type: 'credit',
        description: `Deposit via ${verifyResult.payment_method || 'UddoktaPay'}`,
        invoice_id: invoiceId,
        deposit_id: depositId,
        created_at: new Date().toISOString()
      }, accessToken);

      return res.status(200).json({
        status: 'completed',
        amount: expectedAmount,
        message: `৳${expectedAmount} has been added to your wallet!`
      });
    }

    if (verifyResult.status === 'PENDING') {
      await rtdbUpdate(`deposits/${depositId}`, {
        status: 'pending',
        invoice_id: invoiceId,
        verified_at: new Date().toISOString()
      }, accessToken);
      return res.status(200).json({ status: 'pending', message: 'Your payment is being processed. Please wait.' });
    }

    if (verifyResult.status === 'CANCELLED') {
      await rtdbUpdate(`deposits/${depositId}`, {
        status: 'cancelled',
        invoice_id: invoiceId,
        failure_reason: 'Payment was cancelled by user',
        verified_at: new Date().toISOString()
      }, accessToken);
      return res.status(200).json({ status: 'cancelled', message: 'Payment was cancelled.' });
    }

    // Default: failed/unknown
    await rtdbUpdate(`deposits/${depositId}`, {
      status: 'failed',
      invoice_id: invoiceId,
      failure_reason: verifyResult.status || 'Unknown payment status',
      verified_at: new Date().toISOString()
    }, accessToken);
    return res.status(200).json({ status: 'failed', message: verifyResult.message || 'Payment failed. Please try again.' });

  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error in verify-payment handler:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
};
