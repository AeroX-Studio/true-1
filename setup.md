# 🎮 Veltrix Tournaments — Complete Setup Guide

A complete, step-by-step guide to setting up, configuring, and deploying your own **Veltrix Tournaments** platform from scratch.

---

## 📋 Table of Contents

1. [Tech Stack & Architecture](#-tech-stack--architecture)
2. [Prerequisites](#-prerequisites)
3. [Step 1: Firebase Project Setup](#-step-1-firebase-project-setup)
4. [Step 2: UddoktaPay Gateway Setup](#-step-2-uddoktapay-gateway-setup)
5. [Step 3: Environment Variables Configuration](#-step-3-environment-variables-configuration)
6. [Step 4: Update Client Configuration](#-step-4-update-client-configuration)
7. [Step 5: Create Your First Admin User](#-step-5-create-your-first-admin-user)
8. [Step 6: Deployment Options](#-step-6-deployment-options)
   - [Option A: Deploy to Vercel (Recommended)](#option-a-deploy-to-vercel-recommended)
   - [Option B: Deploy to Firebase Hosting & Functions](#option-b-deploy-to-firebase-hosting--functions)
9. [Step 7: Testing & Verification Checklist](#-step-7-testing--verification-checklist)
10. [🛠 Troubleshooting & FAQ](#-troubleshooting--faq)

---

## 🏗 Tech Stack & Architecture

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (Responsive Single-Page App)
  - `index.html` — Player tournament portal, match listings, wallet, leaderboard.
  - `admin.html` — Administrative management dashboard.
- **Backend / Serverless APIs:** Node.js serverless functions (`/api/create-charge`, `/api/verify-payment`, `/api/health`).
- **Database & Authentication:** Firebase Realtime Database + Firebase Authentication (Email/Password).
- **Payment Gateway:** UddoktaPay / Paymently API for automated bKash, Nagad, Rocket deposits.

---

## 🧰 Prerequisites

Before starting, ensure you have:
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [Git](https://git-scm.com/)
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`)
- A [Firebase Account](https://console.firebase.google.com/)
- An [UddoktaPay / Paymently Merchant Account](https://pay.uddoktapay.com)
- A [Vercel Account](https://vercel.com/) (for hosting)

---

## ⚡ Step 1: Firebase Project Setup

### 1.1 Create a Firebase Project
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Click **Add project** and give it a name (e.g., `veltrix-tournament`).
3. Disable Google Analytics (optional) and click **Create Project**.

### 1.2 Enable Authentication
1. In the Firebase Console left menu, navigate to **Build** → **Authentication**.
2. Click **Get Started**.
3. Under the **Sign-in method** tab, select **Email/Password**.
4. Enable **Email/Password** and click **Save**.

### 1.3 Create Realtime Database
1. Go to **Build** → **Realtime Database** → **Create Database**.
2. Select your preferred database location (e.g., `asia-southeast1` (Singapore) or `us-central1`).
3. Select **Start in locked mode** and click **Enable**.

### 1.4 Apply Realtime Database Security Rules
1. In the Realtime Database section, click the **Rules** tab.
2. Replace all contents with the rules from [`database-rules.json`](file:///i:/elite%20Tournamenst/updatev4/database-rules.json):
   ```json
   {
     "rules": {
       "users": {
         ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
         "$uid": {
           ".read": "auth != null && (auth.uid === $uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
           ".write": "auth != null && (auth.uid === $uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
           "role": {
             ".validate": "newData.val() === 'user' || root.child('users').child(auth.uid).child('role').val() === 'admin'"
           },
           "wallet_balance": {
             ".validate": "newData.isNumber() && (data.exists() ? (root.child('users').child(auth.uid).child('role').val() === 'admin' || newData.val() <= data.val()) : newData.val() === 0)"
           }
         }
       },
       "tournaments": {
         ".read": true,
         ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
         ".indexOn": ["status", "created_at"]
       },
       "participants": {
         "$tid": {
           ".read": "auth != null",
           "$uid": {
             ".write": "auth != null && (auth.uid === $uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
             "status": {
               ".validate": "root.child('users').child(auth.uid).child('role').val() === 'admin' || newData.val() === 'Participated'"
             }
           }
         }
       },
       "transactions": {
         "$uid": {
           ".read": "auth != null && (auth.uid === $uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
           ".write": "auth != null && (auth.uid === $uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
           ".indexOn": ["created_at", "type"]
         }
       },
       "payment_requests": {
         ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
         ".indexOn": ["status", "created_at", "user_id"],
         "$pid": {
           ".read": "auth != null && (data.child('user_id').val() === auth.uid || root.child('users').child(auth.uid).child('role').val() === 'admin')",
           ".write": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || (!data.exists() && newData.child('user_id').val() === auth.uid && newData.child('status').val() === 'pending'))"
         }
       },
       "deposits": {
         ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
         ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
         ".indexOn": ["invoice_id", "user_id", "status", "created_at"],
         "$depositId": {
           ".read": "auth != null && (data.child('user_id').val() === auth.uid || root.child('users').child(auth.uid).child('role').val() === 'admin')"
         }
       },
       "app_settings": {
         ".read": true,
         ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
       }
     }
   }
   ```
3. Click **Publish**.

### 1.5 Generate Firebase Service Account Key
1. Go to **Project Settings** (gear icon) → **Service accounts** tab.
2. Click **Generate new private key** and confirm.
3. A `.json` file will download to your computer.
4. Open this file in a text editor — you will need its contents for the `FIREBASE_SERVICE_ACCOUNT` environment variable.

### 1.6 Copy Web App Client Configuration
1. In **Project Settings** → **General** tab, scroll down to **Your apps**.
2. Click the **Web** icon (`</>`) to add a web application.
3. Register your app (e.g. `Veltrix Web`).
4. Copy the `firebaseConfig` object (apiKey, authDomain, databaseURL, projectId, storageBucket, messagingSenderId, appId).

---

## 💳 Step 2: UddoktaPay Gateway Setup

1. Log in to your **UddoktaPay** or **Paymently** panel.
2. Navigate to **API Settings** / **API Credentials**.
3. Note your:
   - **Base URL:** e.g., `https://aerox.paymently.io/api` or `https://pay.uddoktapay.com/api`
   - **API Key:** e.g., `mY87vI5fvZyYhApJY2lPDEhoicioBMReUosYpMuk`

---

## 🔐 Step 3: Environment Variables Configuration

Create a `.env` file in the root directory (based on [`.env.example`](file:///i:/elite%20Tournamenst/updatev4/.env.example)):

```env
# Firebase Configuration
FIREBASE_PROJECT_ID=veltrix-tournament
FIREBASE_DB_URL=https://veltrix-tournament-default-rtdb.asia-southeast1.firebasedatabase.app

# Firebase Service Account JSON (paste entire contents of service account json as a single line)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"veltrix-tournament", ...}

# UddoktaPay Configuration
UDDOKTAPAY_API_KEY=mY87vI5fvZyYhApJY2lPDEhoicioBMReUosYpMuk
UDDOKTAPAY_BASE_URL=https://aerox.paymently.io/api

# Site URL (Optional in production, auto-detected by Vercel)
# SITE_URL=https://your-site.vercel.app
```

---

## 🌐 Step 4: Update Client Configuration

Ensure that [`index.html`](file:///i:/elite%20Tournamenst/updatev4/index.html) and [`admin.html`](file:///i:/elite%20Tournamenst/updatev4/admin.html) contain your Firebase Web Configuration.

In both `index.html` (around line 536) and `admin.html` (around line 192), verify `firebaseConfig`:
```javascript
const firebaseConfig = {
    apiKey: "YOUR_FIREBASE_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};
firebase.initializeApp(firebaseConfig);
```

---

## 👑 Step 5: Create Your First Admin User

1. Start your local server or visit your deployed `index.html`.
2. Click **Create Account** and register with your email and password (e.g. `admin@veltrix.app`).
3. Open your **Firebase Console** → **Realtime Database** → **Data** tab.
4. Expand `/users/{your_user_uid}`.
5. Change the `role` field value from `"user"` to `"admin"`.
6. Now visit `admin.html` (or `/admin` on Vercel) and log in with your email and password.
7. You will have full access to the Admin Dashboard! 🎉

---

## 🚀 Step 6: Deployment Options

### Option A: Deploy to Vercel (Recommended)

Vercel will host both your frontend pages and serverless API endpoints together seamlessly.

#### Method 1: Via GitHub
1. Push your repository to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for Veltrix Tournaments"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
   git push -u origin main
   ```
2. Log in to [Vercel](https://vercel.com) and click **Add New...** → **Project**.
3. Import your GitHub repository.
4. In the **Environment Variables** section, add:
   - `FIREBASE_PROJECT_ID`: `veltrix-tournament`
   - `FIREBASE_DB_URL`: `https://veltrix-tournament-default-rtdb.asia-southeast1.firebasedatabase.app`
   - `FIREBASE_SERVICE_ACCOUNT`: *(Paste the JSON key string)*
   - `UDDOKTAPAY_API_KEY`: `mY87vI5fvZyYhApJY2lPDEhoicioBMReUosYpMuk`
   - `UDDOKTAPAY_BASE_URL`: `https://aerox.paymently.io/api`
5. Click **Deploy**.

#### Method 2: Via Vercel CLI
```bash
npm install -g vercel
vercel login
vercel
# Follow interactive prompts, then deploy to production:
vercel --prod
```

---

### Option B: Deploy to Firebase Hosting & Functions

If you prefer to host 100% on Firebase:

1. **Deploy Cloud Functions:**
   ```bash
   cd functions
   npm install
   firebase functions:config:set uddoktapay.api_key="mY87vI5fvZyYhApJY2lPDEhoicioBMReUosYpMuk" uddoktapay.base_url="https://aerox.paymently.io/api"
   firebase deploy --only functions
   cd ..
   ```
2. **Deploy Database Rules:**
   ```bash
   firebase deploy --only database
   ```
3. **Deploy Hosting:**
   ```bash
   firebase deploy --only hosting
   ```

---

## ✅ Step 7: Testing & Verification Checklist

| Test Item | Expected Result |
|---|---|
| **API Health Check** (`/api/health`) | Returns `{"status":"ok","timestamp":"..."}` |
| **User Sign Up** | Creates record in `/users/{uid}` with `wallet_balance: 0` and `role: "user"` |
| **Deposit Money** | Redirects to UddoktaPay/bKash/Nagad checkout and returns to app |
| **Payment Verification** | Automatically verifies invoice and credits user wallet atomically |
| **Admin Login** | Grants access to `/admin.html` dashboard only for users with `role: "admin"` |
| **Create Tournament** | Tournament appears under "Upcoming" on user homepage |
| **Join Tournament** | Debits entry fee from wallet and adds player to `/participants/{tid}/{uid}` |
| **Go Live & Credentials** | Setting room ID and password in admin makes credentials visible to joined participants |
| **Complete & Payout** | Selecting winner credits tournament prize pool to winner's wallet automatically |
| **Withdrawal Request** | User creates request → Admin approves/rejects from Payments tab |

---

## 🛠 Troubleshooting & FAQ

#### 1. "Failed to create payment gateway session" / 500 error on Deposit
- Verify that `UDDOKTAPAY_API_KEY` and `UDDOKTAPAY_BASE_URL` are correct.
- Ensure your UddoktaPay account is active and has payment methods configured.

#### 2. "Permission Denied" in Firebase Realtime Database
- Ensure you have published the latest rules from [`database-rules.json`](file:///i:/elite%20Tournamenst/updatev4/database-rules.json).
- Check that the user is logged in (`auth != null`).

#### 3. Service Account Error on Vercel
- When copying `FIREBASE_SERVICE_ACCOUNT` into Vercel Environment Variables, ensure the entire JSON is formatted properly without unescaped newlines.

#### 4. Room ID / Password not visible to players
- Players must have joined the tournament before the match goes **Live**.
- Credentials will appear in the tournament details modal once the status is updated to **Live** by the admin.
