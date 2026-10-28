'use strict';

const http = require('http');
const https = require('https');
const path = require('path');
const { APP_ROOT } = require('./bootstrap');

function loadConfig() {
  return require(path.join(APP_ROOT, 'server', 'config')).loadConfig();
}

function loadAuth() {
  return require(path.join(APP_ROOT, 'server', 'auth'));
}

function baseUrl(cfg = loadConfig()) {
  const host = process.env.OMNISHPILOT_HOST || cfg.host || '127.0.0.1';
  const port = Number(process.env.OMNISHPILOT_PORT || process.env.AGENTBOARD_PORT || cfg.port || 4580);
  return `http://${host}:${port}`;
}

function sessionCookie() {
  const auth = loadAuth();
  const { enabled, secret, sessionMs } = auth.authConfig();
  if (!enabled) return null;
  const token = auth.createSessionToken(secret, sessionMs);
  return `${auth.COOKIE_NAME}=${encodeURIComponent(token)}`;
}

function request(method, apiPath, { body, query, timeoutMs = 30000 } = {}) {
  const cfg = loadConfig();
  const root = baseUrl(cfg);
  const url = new URL(apiPath, root.endsWith('/') ? root : `${root}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {
    Accept: 'application/json',
    'User-Agent': `omnishpilot-cli/${process.platform}`,
  };
  const cookie = sessionCookie();
  if (cookie) headers.Cookie = cookie;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (raw) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }
          }
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            data,
            headers: res.headers,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request_timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function get(apiPath, opts) {
  return request('GET', apiPath, opts);
}

async function post(apiPath, body, opts) {
  return request('POST', apiPath, { ...opts, body });
}

async function patch(apiPath, body, opts) {
  return request('PATCH', apiPath, { ...opts, body });
}

async function del(apiPath, opts) {
  return request('DELETE', apiPath, opts);
}

async function health() {
  try {
    const r = await get('/api/health', { timeoutMs: 2500 });
    return r.ok ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * Ensure API is up. Auto-starts the daemon unless disabled.
 */
async function ensureApi(opts = {}) {
  const autoStart = opts.autoStart !== false;
  const daemon = require('./daemon');
  return daemon.ensureRunning({ autoStart, quiet: opts.quiet });
}

module.exports = {
  baseUrl,
  request,
  get,
  post,
  patch,
  del,
  health,
  ensureApi,
};
