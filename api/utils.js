const crypto = require('crypto');

// Configuration Defaults
const MIN_DEPOSIT = 10;
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SA_SCOPES = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'veltrix-tournament';
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || 'https://veltrix-tournament-default-rtdb.asia-southeast1.firebasedatabase.app').replace(/\/$/, '');
const UDDOKTAPAY_API_KEY = process.env.UDDOKTAPAY_API_KEY || 'mY87vI5fvZyYhApJY2lPDEhoicioBMReUosYpMuk';
const UDDOKTAPAY_BASE_URL = (process.env.UDDOKTAPAY_BASE_URL || 'https://aerox.paymently.io/api').replace(/\/$/, '');

function getUddoktaApiUrl(endpoint) {
  let base = (process.env.UDDOKTAPAY_BASE_URL || 'https://aerox.paymently.io/api').replace(/\/+$/, '');
  const cleanEndpoint = endpoint.replace(/^\/+/, '').replace(/^api\//, '');
  if (base.endsWith('/api')) {
    return `${base}/${cleanEndpoint}`;
  }
  return `${base}/api/${cleanEndpoint}`;
}

// Cache in-memory
let cachedJwks = null;
let cachedJwksExp = 0;
let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function handleCors(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function getSiteUrl(req) {
  if (process.env.SITE_URL) {
    return process.env.SITE_URL.replace(/\/$/, '');
  }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  return `${proto}://${host}`;
}

async function getGoogleJWKs() {
  const now = Date.now();
  if (cachedJwks && now < cachedJwksExp) return cachedJwks;

  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('Failed to fetch Google JWKs for auth verification');

  cachedJwks = await res.json();
  cachedJwksExp = now + 3600 * 1000; // 1 hour cache
  return cachedJwks;
}

async function verifyFirebaseIdToken(token, projectId = FIREBASE_PROJECT_ID) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed token structure');

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new AuthError('Invalid token encoding');
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new AuthError('Token has expired');
  if (!payload.iat || payload.iat > now + 300) throw new AuthError('Token issued in the future');
  if (payload.aud !== projectId) throw new AuthError('Invalid token audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new AuthError('Invalid token issuer');
  if (!payload.sub || typeof payload.sub !== 'string') throw new AuthError('Missing token subject');
  if (header.alg !== 'RS256') throw new AuthError('Unsupported algorithm');

  const jwks = await getGoogleJWKs();
  const jwk = jwks.keys && jwks.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new AuthError('Firebase signing key not found in Google JWKs');

  const keyObj = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  const isValid = verifier.verify(keyObj, Buffer.from(parts[2], 'base64url'));

  if (!isValid) throw new AuthError('Invalid token signature');

  return { uid: payload.sub, email: payload.email || null };
}

async function authenticate(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid Authorization header');
  }
  const token = authHeader.slice(7).trim();
  const payload = await verifyFirebaseIdToken(token);
  return { uid: payload.uid, email: payload.email, token };
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && now < cachedAccessTokenExp) return cachedAccessToken;

  let rawSA = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawSA) {
    try {
      const fs = require('fs');
      const path = require('path');
      const rootDir = path.resolve(__dirname, '..');
      const files = fs.readdirSync(rootDir);
      const saFile = files.find(f => f.includes('firebase-adminsdk') && f.endsWith('.json'));
      if (saFile) {
        rawSA = fs.readFileSync(path.join(rootDir, saFile), 'utf8');
      }
    } catch (e) {}
  }

  if (!rawSA) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT environment variable is not configured. Please add your Firebase Service Account JSON in Vercel settings.');
  }

  let sa;
  try {
    sa = typeof rawSA === 'string' ? JSON.parse(rawSA) : rawSA;
  } catch (err) {
    throw new Error('Invalid JSON format for FIREBASE_SERVICE_ACCOUNT environment variable.');
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSec = Math.floor(now / 1000);
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
    scope: SA_SCOPES
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const privateKey = sa.private_key.replace(/\\n/g, '\n');
  const signatureB64 = signer.sign(privateKey, 'base64url');
  const jwt = `${signingInput}.${signatureB64}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google OAuth2 token exchange failed: ${errBody}`);
  }

  const tokenData = await res.json();
  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExp = now + 55 * 60 * 1000;
  return cachedAccessToken;
}

// RTDB REST API Helpers (Supports OAuth2 Access Token and Firebase User ID Token)
async function rtdbGet(path, token) {
  const url = `${FIREBASE_DB_URL}/${path}.json`;
  let res = await fetch(url, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  });
  if (!res.ok && token) {
    res = await fetch(`${url}?auth=${encodeURIComponent(token)}`);
  }
  if (!res.ok) throw new Error(`RTDB GET ${path} failed: ${res.status}`);
  return await res.json();
}

async function rtdbGetWithEtag(path, token) {
  const url = `${FIREBASE_DB_URL}/${path}.json`;
  let res = await fetch(url, {
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      'X-Firebase-ETag': 'true'
    }
  });
  if (!res.ok && token) {
    res = await fetch(`${url}?auth=${encodeURIComponent(token)}`, {
      headers: { 'X-Firebase-ETag': 'true' }
    });
  }
  if (!res.ok) throw new Error(`RTDB GET ${path} failed: ${res.status}`);
  const value = await res.json();
  const etag = res.headers.get('ETag');
  return { value, etag };
}

async function rtdbPutWithEtag(path, data, etag, token) {
  const url = `${FIREBASE_DB_URL}/${path}.json`;
  let res = await fetch(url, {
    method: 'PUT',
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
      'if-match': etag
    },
    body: JSON.stringify(data)
  });
  if (res.status === 412) return false;
  if (!res.ok && token) {
    res = await fetch(`${url}?auth=${encodeURIComponent(token)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'if-match': etag
      },
      body: JSON.stringify(data)
    });
  }
  if (res.status === 412) return false;
  if (!res.ok) throw new Error(`RTDB PUT ${path} failed: ${res.status}`);
  return true;
}

async function rtdbConditionalSet(path, expectedValue, newValue, token) {
  const { value: current, etag } = await rtdbGetWithEtag(path, token);
  if (current !== expectedValue) return false;
  return await rtdbPutWithEtag(path, newValue, etag, token);
}

async function rtdbUpdate(path, data, token) {
  const url = `${FIREBASE_DB_URL}/${path}.json`;
  let res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok && token) {
    res = await fetch(`${url}?auth=${encodeURIComponent(token)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }
  if (!res.ok) throw new Error(`RTDB PATCH ${path} failed: ${res.status}`);
  return await res.json();
}

async function rtdbPush(path, data, token) {
  const url = `${FIREBASE_DB_URL}/${path}.json`;
  let res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  if (!res.ok && token) {
    res = await fetch(`${url}?auth=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }
  if (!res.ok) throw new Error(`RTDB POST ${path} failed: ${res.status}`);
  const result = await res.json();
  return result.name;
}

async function rtdbQuery(path, orderByChild, equalToValue, token) {
  const url = `${FIREBASE_DB_URL}/${path}.json?orderBy="${encodeURIComponent(orderByChild)}"&equalTo="${encodeURIComponent(equalToValue)}"`;
  let res = await fetch(url, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  });
  if (!res.ok && token) {
    res = await fetch(`${url}&auth=${encodeURIComponent(token)}`);
  }
  if (!res.ok) throw new Error(`RTDB query ${path} failed: ${res.status}`);
  return await res.json();
}

module.exports = {
  MIN_DEPOSIT,
  UDDOKTAPAY_API_KEY,
  UDDOKTAPAY_BASE_URL,
  getUddoktaApiUrl,
  FIREBASE_PROJECT_ID,
  FIREBASE_DB_URL,
  AuthError,
  setCorsHeaders,
  handleCors,
  getSiteUrl,
  authenticate,
  getAccessToken,
  rtdbGet,
  rtdbGetWithEtag,
  rtdbPutWithEtag,
  rtdbConditionalSet,
  rtdbUpdate,
  rtdbPush,
  rtdbQuery
};
