# Veltrix Tournaments — Project Brain (Context File)

> **Last Updated:** 2026-08-15T10:16:00+06:00  
> **Project:** Veltrix Tournaments — Competitive Gaming Platform  
> **Tech Stack:** HTML/CSS/JS (vanilla) + Firebase (Auth, Realtime Database, Cloud Functions)  
> **Payment Gateway:** UddoktaPay (sandbox mode)

---

## Project Structure

```
updatev4/
├── index.html              ← User-facing tournament app (SPA)
├── admin.html              ← Admin panel (SPA)
├── database-rules.json     ← Firebase RTDB security rules
├── firebase.json           ← Firebase project config
├── .firebaserc             ← Firebase project reference
├── brain.md                ← THIS FILE — all project context
├── prompt.txt              ← Original prompt (empty)
├── architecture.txt        ← Admin panel architecture tree
└── functions/              ← Firebase Cloud Functions (backend)
    ├── package.json        ← Node.js dependencies
    ├── index.js            ← createCharge + verifyPayment functions
    └── .env.example        ← Environment variables template
```

---

## Firebase Config

```
Project ID:      veltrix-tournament
Auth Domain:     veltrix-tournament.firebaseapp.com
Database URL:    https://veltrix-tournament-default-rtdb.asia-southeast1.firebasedatabase.app
Storage Bucket:  veltrix-tournament.firebasestorage.app
App ID:          1:929705162089:web:f02ee691c418b3e01ab9f8
```

---

## Database Schema (RTDB)

```
/users/{uid}
  ├── username: string
  ├── email: string
  ├── wallet_balance: number
  ├── role: "user" | "admin"
  └── created_at: ISO string

/tournaments/{id}
  ├── title, game_name, game_type
  ├── entry_fee, prize_pool
  ├── match_time: ISO string
  ├── commission_percentage: number
  ├── status: "Upcoming" | "Live" | "Completed"
  ├── room_id, room_password (set when Live)
  ├── winner_id (set when Completed)
  └── created_at

/participants/{tournament_id}/{uid}
  ├── game_name, game_uid
  ├── status: "Participated" | "Winner"
  └── joined_at

/transactions/{uid}/{txn_id}
  ├── amount, type: "credit" | "debit"
  ├── description
  ├── invoice_id (for UddoktaPay deposits)
  ├── deposit_id (for UddoktaPay deposits)
  └── created_at

/deposits/{deposit_id}                 ← NEW (UddoktaPay)
  ├── user_id, username, email
  ├── amount: number
  ├── status: "initiated" | "awaiting_payment" | "pending" | "completed" | "failed" | "cancelled"
  ├── invoice_id: string (from UddoktaPay)
  ├── payment_url: string
  ├── payment_method: string (bkash, nagad, etc.)
  ├── sender_number: string
  ├── uddoktapay_transaction_id: string
  ├── uddoktapay_fee: string
  ├── charged_amount: string
  ├── credited: boolean               ← IDEMPOTENCY FLAG
  ├── failure_reason: string | null
  ├── created_at: ISO string
  └── verified_at: ISO string

/payment_requests/{id}                 ← Legacy (manual withdrawals)
  ├── user_id, username, amount
  ├── payment_method, phone_number
  ├── transaction_id (for manual deposits)
  ├── status: "pending" | "approved" | "rejected"
  ├── type: "deposit" | "withdraw"
  └── created_at

/app_settings
  └── banner: { title, subtitle, enabled }
```

---

## UddoktaPay Integration

### Configuration
- **Base URL:** `https://aerox.paymently.io/api`
- **Vercel API Routes:** `/api/create-charge`, `/api/verify-payment`

### Payment Flow
```
User → Enter Amount → initiateDeposit()
  → Cloud Function: createCharge
    → Creates /deposits/{id} with status "initiated"
    → POST /api/checkout-v2 to UddoktaPay
    → Returns payment_url
  → Frontend redirects to UddoktaPay
  → User completes payment
  → UddoktaPay redirects back with ?invoice_id=XXX
  → handlePaymentReturn()
  → Cloud Function: verifyPayment
    → Finds deposit by invoice_id
    → IDEMPOTENCY: checks credited === true → early return
    → POST /api/verify-payment to UddoktaPay
    → Verifies: status, amount, invoice_id, metadata.deposit_id
    → COMPLETED:
      → Atomic credited=true (transaction, abort if already true)
      → Atomic wallet_balance increment (transaction)
      → Update deposit record with payment details
      → Create /transactions/{uid}/{txn_id} entry
    → PENDING: update status, return pending message
    → FAILED/CANCELLED: update status + failure_reason
  → Show result overlay to user
```

### Idempotency (Double-Credit Prevention)
1. **`credited` boolean flag** on deposit record — checked before any wallet operation
2. **Firebase `ref.transaction()`** for atomic `credited = true` — aborts if already `true`
3. **Firebase `ref.transaction()`** for atomic wallet balance increment — prevents race conditions

### Verification Steps (all 4 must pass)
1. ✅ Transaction status === "COMPLETED"
2. ✅ Amount matches internal deposit record
3. ✅ invoice_id matches stored record
4. ✅ metadata.deposit_id matches stored deposit_id

---

## Admin Panel Architecture (from architecture.txt)

```
ADMIN PANEL
│
├── Dashboard                ✅ Implemented
├── Users                    ✅ Implemented
├── Games                    ❌ Not yet
├── Tournaments              ✅ Implemented
│   ├── Create Tournament    ✅ Implemented
│   ├── Edit Tournament      ❌ Not yet
│   ├── Matches              ❌ Not yet
│   ├── Results              ❌ Not yet
│   ├── Prize Pool           ❌ Not yet
│   └── Leaderboard          ❌ Not yet
│
├── Wallet                   ❌ Not yet (admin wallet overview)
├── Payments                 ✅ Updated (3 tabs: Withdrawals, Deposits, History)
├── Withdrawals              ✅ Implemented (in Payments tab)
│
├── Commission               ❌ Not yet
│   ├── Enable/Disable
│   ├── Type
│   ├── Rate
│   └── Settings
│
└── Settings                 ✅ Implemented
```

---

## Pages & Navigation

### User Panel (index.html)
- **Bottom Nav:** Home → Matches → Wallet → Profile
- **Pages:** loginPage, homePage, myTournamentsPage, walletPage, profilePage
- **Modals:** joinTournamentModal, depositMoneyModal (UddoktaPay), withdrawMoneyModal
- **Payment Overlay:** paymentVerifyOverlay (shows during verification)
- **Currency:** BDT (৳)

### Admin Panel (admin.html)
- **Bottom Nav:** Dashboard → Tournaments → Payments → Users → Settings
- **Pages:** adminLoginPage, adminDashboardPage, adminTournamentPage, adminManageTournamentPage, adminUsersPage, adminPaymentsPage, adminSettingsPage
- **Payments Tabs:** Withdrawals (manual approve/reject) | Deposits (UddoktaPay auto-verified) | History (combined)

---

## Deployment Steps (TODO)

```bash
# 1. Install Firebase CLI (if not installed)
npm install -g firebase-tools

# 2. Login to Firebase
firebase login

# 3. Install Cloud Functions dependencies
cd functions
npm install

# 4. Set environment variables (production)
# Option A: .env file in functions/
# Option B: firebase functions:config:set uddoktapay.api_key="YOUR_KEY" uddoktapay.base_url="https://pay.uddoktapay.com" site.url="https://your-site.com"

# 5. Deploy Cloud Functions
firebase deploy --only functions

# 6. Deploy database rules
firebase deploy --only database

# 7. Deploy hosting (optional)
firebase deploy --only hosting
```

---

## Key Design Decisions

1. **Firebase Cloud Functions** used as backend because UddoktaPay API key must not be exposed to client
2. **Withdrawals remain manual** — admin approves and sends money outside the platform
3. **Deposits are now automated** via UddoktaPay with server-side verification
4. **Old `payment_requests` node kept** for backward compatibility with existing withdrawal flow
5. **New `deposits` node** created specifically for UddoktaPay-tracked deposits
6. **Transaction history** in `/transactions/{uid}/` records both deposit credits and tournament debits
7. **Branding:** "Veltrix Tournaments" | "Made by AeroX Studio" watermark
