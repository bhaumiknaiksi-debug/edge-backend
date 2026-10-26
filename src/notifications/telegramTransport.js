'use strict';

const https = require('node:https');

class TelegramError extends Error {
  constructor(code, {retryAfterMs = 0, ambiguous = false, permanent = false} = {}) {
    super(code); this.code = code; this.retryAfterMs = retryAfterMs;
    this.ambiguous = ambiguous; this.permanent = permanent;
  }
}

function createTelegramTransport(token, request = https.request) {
  return async function call(method, parameters) {
    if (!['getChat','sendMessage'].includes(method)) throw new TelegramError('UNSUPPORTED_METHOD',{permanent:true});
    const sending = method === 'sendMessage';
    const body = JSON.stringify(parameters);
    return new Promise((resolve,reject) => {
      let settled = false, deadline;
      const done = (error,value) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) reject(error); else resolve(value);
      };
      const unavailable = () => done(new TelegramError('TRANSPORT_UNAVAILABLE',{ambiguous:sending}));
      // A fixed host, no redirects and no raw error/body logging: URL paths contain the token.
      let req;
      try { req = request({hostname:'api.telegram.org',port:443,path:'/bot'+token+'/'+method,method:'POST',
        headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}}, response => {
        let chunks = [], length = 0, ended = false;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 65536) req.destroy(new Error('RESPONSE_TOO_LARGE'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('error',unavailable);
        response.on('aborted',unavailable);
        response.on('close',()=>{if(!ended)unavailable();});
        response.on('end',()=>{
          ended = true;
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (_) { return done(new TelegramError('INVALID_TELEGRAM_RESPONSE',{ambiguous:sending})); }
          if (!result || typeof result !== 'object' || Array.isArray(result)) return done(new TelegramError('INVALID_TELEGRAM_RESPONSE',{ambiguous:sending}));
          if (response.statusCode === 200 && result.ok === true) return done(null,result.result);
          const code = Number(result.error_code || response.statusCode);
          if (code === 429 && result.ok === false) {
            const seconds = Number(result.parameters?.retry_after);
            return done(new TelegramError('TELEGRAM_RATE_LIMIT',{retryAfterMs:Number.isFinite(seconds)?Math.max(1000,Math.min(3600000,seconds*1000)):30000}));
          }
          if ([400,401,403].includes(code) && result.ok === false) return done(new TelegramError('TELEGRAM_REQUEST_REJECTED',{permanent:true}));
          done(new TelegramError('TELEGRAM_UNAVAILABLE',{ambiguous:sending}));
        });
      }); } catch (_) {unavailable(); return;}
      req.setTimeout(7000,()=>req.destroy(new Error('TIMEOUT')));
      deadline = setTimeout(()=>{unavailable();req.destroy(new Error('TIMEOUT'));},7000);
      deadline.unref?.();
      req.on('error',unavailable);
      try { req.end(body); } catch (_) {unavailable();req.destroy();}
    });
  };
}

module.exports = { createTelegramTransport,TelegramError };
