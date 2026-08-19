# 🚀 How to Host on Vercel

Your project is now fully configured and ready for **1-click deployment on Vercel**!

---

## ⚡ Option 1: Deploy via GitHub (Recommended)

1. **Push your project to GitHub**:
   ```bash
   git init
   git add .
   git commit -m "Configure Vercel hosting and serverless API"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
   git push -u origin main
   ```

2. Go to **[vercel.com](https://vercel.com)** and log in.
3. Click **"Add New..."** → **"Project"**.
4. Import your GitHub repository.
5. In the **Environment Variables** section, add your environment variables (see below).
6. Click **Deploy**! 🎉

---

## ⚡ Option 2: Deploy directly via Vercel CLI

1. Open your terminal in this project directory:
   ```bash
   npm i -g vercel
   vercel login
   vercel
   ```
2. Follow the interactive prompts (select defaults).
3. To deploy directly to production:
   ```bash
   vercel --prod
   ```

---

## 🔑 Environment Variables Setup on Vercel

In your **Vercel Dashboard → Project Settings → Environment Variables**, configure the following:

| Variable Name | Required | Description / Value |
|---|---|---|
| `FIREBASE_PROJECT_ID` | ✅ Yes | `veltrix-tournament` |
| `FIREBASE_DB_URL` | ✅ Yes | `https://veltrix-tournament-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_SERVICE_ACCOUNT` | ✅ Yes | The full JSON string of your Firebase Service Account private key *(Firebase Console → Project Settings → Service Accounts → Generate new private key)* |
| `UDDOKTAPAY_API_KEY` | ✅ Yes | Your UddoktaPay API Key |
| `UDDOKTAPAY_BASE_URL` | ✅ Yes | `https://aerox.paymently.io/api` |
| `SITE_URL` | ⚙️ Optional | `https://your-project.vercel.app` *(auto-detected if omitted)* |

---

## 🌐 Available Routes after Deployment

- **Main App**: `https://<your-project>.vercel.app/`
- **Admin Panel**: `https://<your-project>.vercel.app/admin` (or `/admin.html`)
- **API Health Check**: `https://<your-project>.vercel.app/api/health`
- **Deposit Checkout**: `https://<your-project>.vercel.app/api/create-charge`
- **Payment Verification**: `https://<your-project>.vercel.app/api/verify-payment`
