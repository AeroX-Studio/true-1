/**
 * Veltrix Tournaments — Firebase Cloud Functions
 * UddoktaPay Payment Gateway Integration
 * 
 * Two callable functions:
 *   1. createCharge  — Initiates a deposit, calls UddoktaPay checkout
 *   2. verifyPayment — Verifies payment via UddoktaPay, credits wallet (idempotent)
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.database();

// ─── Configuration ────────────────────────────────────────────────────
// Set these via: firebase functions:config:set uddoktapay.api_key="..." uddoktapay.base_url="..." site.url="..."
// Or use .env file in functions/ directory (Firebase Functions v2)
const UDDOKTAPAY_API_KEY = process.env.UDDOKTAPAY_API_KEY
  || (functions.config().uddoktapay && functions.config().uddoktapay.api_key)
  || "mY87vI5fvZyYhApJY2lPDEhoicioBMReUosYpMuk";

const UDDOKTAPAY_BASE_URL = process.env.UDDOKTAPAY_BASE_URL
  || (functions.config().uddoktapay && functions.config().uddoktapay.base_url)
  || "https://aerox.paymently.io/api";

function getUddoktaApiUrl(endpoint) {
  let base = UDDOKTAPAY_BASE_URL.replace(/\/+$/, '');
  const cleanEndpoint = endpoint.replace(/^\/+/, '').replace(/^api\//, '');
  if (base.endsWith('/api')) {
    return `${base}/${cleanEndpoint}`;
  }
  return `${base}/api/${cleanEndpoint}`;
}

const SITE_URL = process.env.SITE_URL
  || (functions.config().site && functions.config().site.url)
  || "https://your-site.com";

const MIN_DEPOSIT = 10; // Minimum deposit amount in BDT


// ═══════════════════════════════════════════════════════════════════════
// 1. CREATE CHARGE
// ═══════════════════════════════════════════════════════════════════════
/**
 * Creates an internal deposit record and initiates UddoktaPay checkout.
 * 
 * @param {Object} data - { amount: number }
 * @returns {Object} - { payment_url: string, deposit_id: string }
 */
exports.createCharge = functions
  .region("asia-southeast1") // Match your Firebase RTDB region
  .https.onCall(async (data, context) => {

    // ── 1. Authentication check ──
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to make a deposit."
      );
    }

    const uid = context.auth.uid;

    // ── 2. Validate amount ──
    const amount = Number(data.amount);
    if (!amount || isNaN(amount) || amount < MIN_DEPOSIT) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `Minimum deposit amount is ৳${MIN_DEPOSIT}.`
      );
    }

    // ── 3. Get user data from RTDB ──
    const userSnap = await db.ref(`users/${uid}`).once("value");
    const userData = userSnap.val();

    if (!userData) {
      throw new functions.https.HttpsError(
        "not-found",
        "User account not found."
      );
    }

    // ── 4. Create internal deposit record ──
    const depositRef = db.ref("deposits").push();
    const depositId = depositRef.key;

    await depositRef.set({
      user_id: uid,
      username: userData.username || "Unknown",
      email: userData.email || "",
      amount: amount,
      status: "initiated",
      invoice_id: null,
      payment_url: null,
      payment_method: null,
      sender_number: null,
      uddoktapay_transaction_id: null,
      uddoktapay_fee: null,
      charged_amount: null,
      credited: false,          // Idempotency flag
      failure_reason: null,
      created_at: new Date().toISOString(),
      verified_at: null
    });

    // ── 5. Call UddoktaPay Create Charge ──
    let uddoktaResponse;
    try {
      const response = await fetch(getUddoktaApiUrl('checkout-v2'), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "RT-UDDOKTAPAY-API-KEY": UDDOKTAPAY_API_KEY
        },
        body: JSON.stringify({
          full_name: userData.username || "Veltrix User",
          email: userData.email || `${uid}@veltrix.app`,
          amount: amount.toString(),
          metadata: {
            deposit_id: depositId,
            user_id: uid
          },
          redirect_url: `${SITE_URL}/index.html`,
          cancel_url: `${SITE_URL}/index.html?payment=cancelled&deposit_id=${depositId}`,
          return_type: "GET"
        })
      });

      uddoktaResponse = await response.json();

      if (!uddoktaResponse || !uddoktaResponse.payment_url) {
        throw new Error(
          uddoktaResponse?.message || "No payment URL received from UddoktaPay"
        );
      }
    } catch (err) {
      // Mark deposit as failed if UddoktaPay call fails
      await depositRef.update({
        status: "failed",
        failure_reason: `UddoktaPay error: ${err.message}`,
        verified_at: new Date().toISOString()
      });
      throw new functions.https.HttpsError(
        "internal",
        "Failed to create payment. Please try again."
      );
    }

    // ── 6. Extract invoice_id & update deposit with UddoktaPay response ──
    let invoiceId = uddoktaResponse.invoice_id || null;
    if (!invoiceId && uddoktaResponse.payment_url) {
      try {
        const urlParts = uddoktaResponse.payment_url.split('/');
        invoiceId = urlParts[urlParts.length - 1].split('?')[0] || null;
      } catch (e) {}
    }

    await depositRef.update({
      invoice_id: invoiceId,
      payment_url: uddoktaResponse.payment_url,
      status: "awaiting_payment"
    });

    // ── 7. Return payment URL to frontend ──
    return {
      payment_url: uddoktaResponse.payment_url,
      deposit_id: depositId,
      invoice_id: invoiceId
    };
  });


// ═══════════════════════════════════════════════════════════════════════
// 2. VERIFY PAYMENT
// ═══════════════════════════════════════════════════════════════════════
/**
 * Verifies a payment with UddoktaPay and credits the user's wallet.
 * Implements full idempotency — calling this multiple times with the same
 * invoice_id will never credit the wallet twice.
 * 
 * Verification steps:
 *   1. Verify transaction status (COMPLETED)
 *   2. Verify amount matches internal record
 *   3. Verify transaction identity (invoice_id)
 *   4. Verify internal transaction reference (metadata.deposit_id)
 *   5. Only then mark as SUCCESS and credit wallet
 * 
 * @param {Object} data - { invoice_id: string }
 * @returns {Object} - { status: string, amount?: number, message?: string }
 */
exports.verifyPayment = functions
  .region("asia-southeast1")
  .https.onCall(async (data, context) => {

    // ── 1. Authentication check ──
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be logged in to verify a payment."
      );
    }

    const uid = context.auth.uid;
    const invoiceId = data.invoice_id;

    if (!invoiceId || typeof invoiceId !== "string") {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "invoice_id is required."
      );
    }

    // ── 2. Call UddoktaPay Verify Payment API First ──
    let verifyResult;
    try {
      const response = await fetch(getUddoktaApiUrl('verify-payment'), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "RT-UDDOKTAPAY-API-KEY": UDDOKTAPAY_API_KEY
        },
        body: JSON.stringify({ invoice_id: invoiceId })
      });

      verifyResult = await response.json();

      if (!verifyResult || !verifyResult.status) {
        throw new Error(verifyResult?.message || "Invalid response from UddoktaPay verify API");
      }
    } catch (err) {
      throw new functions.https.HttpsError(
        "internal",
        `Payment verification failed: ${err.message}`
      );
    }

    // ── 3. Find internal deposit by metadata.deposit_id or query invoice_id ──
    let depositId = (verifyResult.metadata && verifyResult.metadata.deposit_id) ? verifyResult.metadata.deposit_id : null;
    let deposit = null;

    if (depositId) {
      const snap = await db.ref(`deposits/${depositId}`).once("value");
      if (snap.exists()) {
        deposit = snap.val();
      }
    }

    if (!deposit) {
      const depositsSnap = await db.ref("deposits")
        .orderByChild("invoice_id")
        .equalTo(invoiceId)
        .once("value");

      if (depositsSnap.exists()) {
        depositsSnap.forEach((child) => {
          depositId = child.key;
          deposit = child.val();
        });
      }
    }

    if (!deposit) {
      throw new functions.https.HttpsError(
        "not-found",
        "No deposit record found for this invoice."
      );
    }

    // ── 4. IDEMPOTENCY CHECK — Already credited? ──
    if (deposit.credited === true) {
      return {
        status: "already_processed",
        amount: deposit.amount,
        message: "This payment has already been credited to your wallet."
      };
    }

    // ── 5. Verify user owns this deposit ──
    if (deposit.user_id !== uid) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "This deposit does not belong to you."
      );
    }

    const depositRef = db.ref(`deposits/${depositId}`);

    // ── 6. Handle payment status ──

    // ─── COMPLETED ───
    if (verifyResult.status === "COMPLETED") {

      // Verify amount matches
      const paidAmount = Number(verifyResult.amount);
      if (paidAmount !== deposit.amount) {
        await depositRef.update({
          status: "failed",
          failure_reason: `Amount mismatch: expected ৳${deposit.amount}, got ৳${paidAmount}`,
          verified_at: new Date().toISOString()
        });
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Payment amount does not match the deposit request."
        );
      }

      // Verify invoice_id matches
      if (verifyResult.invoice_id !== invoiceId) {
        await depositRef.update({
          status: "failed",
          failure_reason: "Invoice ID mismatch from UddoktaPay",
          verified_at: new Date().toISOString()
        });
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Transaction identity verification failed."
        );
      }

      // Verify internal reference (metadata.deposit_id)
      if (verifyResult.metadata
        && verifyResult.metadata.deposit_id
        && verifyResult.metadata.deposit_id !== depositId) {
        await depositRef.update({
          status: "failed",
          failure_reason: "Internal reference mismatch",
          verified_at: new Date().toISOString()
        });
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Internal transaction reference verification failed."
        );
      }

      // ── ATOMIC IDEMPOTENT WALLET CREDIT ──
      // Step A: Atomically set credited = true (only if currently false)
      const creditResult = await depositRef
        .child("credited")
        .transaction((currentValue) => {
          if (currentValue === true) {
            return undefined; // Abort — already credited
          }
          return true;
        });

      if (!creditResult.committed) {
        // Another process already credited this deposit
        return {
          status: "already_processed",
          amount: deposit.amount,
          message: "This payment has already been credited."
        };
      }

      // Step B: Atomically increment wallet balance
      const walletRef = db.ref(`users/${deposit.user_id}/wallet_balance`);
      await walletRef.transaction((currentBalance) => {
        return (currentBalance || 0) + deposit.amount;
      });

      // Step C: Update deposit record with full payment details
      await depositRef.update({
        status: "completed",
        payment_method: verifyResult.payment_method || null,
        sender_number: verifyResult.sender_number || null,
        uddoktapay_transaction_id: verifyResult.transaction_id || null,
        uddoktapay_fee: verifyResult.fee || null,
        charged_amount: verifyResult.charged_amount || null,
        verified_at: new Date().toISOString()
      });

      // Step D: Create transaction history entry
      await db.ref(`transactions/${deposit.user_id}`).push({
        amount: deposit.amount,
        type: "credit",
        description: `Deposit via ${verifyResult.payment_method || "UddoktaPay"}`,
        invoice_id: invoiceId,
        deposit_id: depositId,
        created_at: new Date().toISOString()
      });

      return {
        status: "completed",
        amount: deposit.amount,
        message: `৳${deposit.amount} has been added to your wallet!`
      };
    }

    // ─── PENDING ───
    if (verifyResult.status === "PENDING") {
      await depositRef.update({
        status: "pending",
        verified_at: new Date().toISOString()
      });
      return {
        status: "pending",
        message: "Your payment is being processed. Please wait."
      };
    }

    // ─── CANCELLED ───
    if (verifyResult.status === "CANCELLED") {
      await depositRef.update({
        status: "cancelled",
        failure_reason: "Payment was cancelled by user",
        verified_at: new Date().toISOString()
      });
      return {
        status: "cancelled",
        message: "Payment was cancelled."
      };
    }

    // ─── FAILED / ERROR / UNKNOWN ───
    await depositRef.update({
      status: "failed",
      failure_reason: verifyResult.status || "Unknown payment status",
      verified_at: new Date().toISOString()
    });
    return {
      status: "failed",
      message: "Payment failed. Please try again."
    };
  });
