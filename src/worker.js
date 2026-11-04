import { DurableObject } from 'cloudflare:workers';
import {
  GameError,
  createState,
  hostAction,
  hostState,
  lookupMine,
  publicState,
  submitEntry,
  submitPrediction,
} from './logic.js';

// 페이지 경로 → 정적 파일
const PAGES = {
  '/': '/index.html',
  '/screen': '/screen.html',
  '/host': '/host.html',
  '/me': '/player.html',
  '/guess': '/player.html',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

async function serveAsset(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  const res = await env.ASSETS.fetch(new Request(url, request));
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  // 오래된 Safari는 'self'에 wss:를 포함하지 않으므로 실시간 연결 주소를 명시한다
  const wsOrigin = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  out.headers.set('Content-Security-Policy', SECURITY_HEADERS['Content-Security-Policy'].replace("connect-src 'self'", `connect-src 'self' ${wsOrigin}`));
  // 수업 중 배포를 고쳐도 바로 반영되도록 캐시하지 않는다
  out.headers.set('Cache-Control', 'no-cache');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/ws' || path.startsWith('/api/')) {
      const stub = env.GAME.get(env.GAME.idFromName('main'));
      return stub.fetch(request);
    }
    if (PAGES[path]) return serveAsset(env, request, PAGES[path]);
    if (/^\/(?:[\w-]+\.(?:css|js|svg|png|ico)|vendor\/[\w.-]+\.js)$/.test(path)) {
      return serveAsset(env, request, path);
    }
    return new Response('Not found', { status: 404 });
  },
};

/** 비밀번호를 길이와 무관하게 상수 시간으로 비교 */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/**
 * 게임 한 판의 상태를 보관하는 Durable Object.
 * 모든 요청이 이 객체 하나로 모이므로 동시 제출에도 순서가 보장되고,
 * 상태는 Durable Object 저장소에 기록돼 재시작해도 유지된다.
 */
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.state = null;
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get('state')) || createState();
    });
  }

  async save() {
    this.state.version += 1;
    await this.ctx.storage.put('state', this.state);
    this.broadcast();
  }

  broadcast() {
    const msg = JSON.stringify({ type: 'state', state: publicState(this.state) });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // 끊긴 소켓은 무시
      }
    }
  }

  async isHost(request) {
    const expected = this.env.HOST_PASSWORD;
    if (!expected) return false;
    const header = request.headers.get('Authorization') || '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    return safeEqual(given, expected);
  }

  async readBody(request) {
    const text = await request.text();
    if (text.length > 4000) throw new GameError('too_large', '요청이 너무 큽니다.');
    try {
      return JSON.parse(text || '{}');
    } catch {
      throw new GameError('bad_json', '잘못된 요청입니다.');
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;

    try {
      if (path === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({ type: 'state', state: publicState(this.state) }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      if (path === '/api/state' && method === 'GET') {
        return json(publicState(this.state));
      }

      if (path === '/api/entry' && method === 'POST') {
        const result = submitEntry(this.state, await this.readBody(request));
        await this.save();
        return json({ ok: true, ...result, gameId: this.state.gameId });
      }

      if (path === '/api/prediction' && method === 'POST') {
        const result = submitPrediction(this.state, await this.readBody(request));
        await this.save();
        return json({ ok: true, ...result, gameId: this.state.gameId });
      }

      if (path === '/api/mine' && method === 'POST') {
        const body = await this.readBody(request);
        return json({ ok: true, gameId: this.state.gameId, ...lookupMine(this.state, body.names) });
      }

      if (path.startsWith('/api/host/')) {
        if (!this.env.HOST_PASSWORD) {
          return json({ ok: false, code: 'no_password', message: '서버에 HOST_PASSWORD가 설정되지 않았습니다.' }, 503);
        }
        if (!(await this.isHost(request))) {
          return json({ ok: false, code: 'unauthorized', message: '비밀번호가 올바르지 않습니다.' }, 401);
        }
        if (path === '/api/host/state' && method === 'GET') return json(hostState(this.state));
        if (path === '/api/host/action' && method === 'POST') {
          hostAction(this.state, await this.readBody(request));
          await this.save();
          return json(hostState(this.state));
        }
      }

      return json({ ok: false, code: 'not_found', message: '없는 주소입니다.' }, 404);
    } catch (err) {
      if (err instanceof GameError) {
        return json({ ok: false, code: err.code, message: err.message, ...(err.extra || {}) }, 400);
      }
      console.error(err);
      return json({ ok: false, code: 'server_error', message: '서버 오류가 발생했습니다.' }, 500);
    }
  }

  webSocketMessage(ws, message) {
    // 클라이언트는 연결 유지용 ping만 보낸다
    if (message === 'ping') ws.send('pong');
  }

  webSocketClose(ws) {
    try {
      ws.close(1000, 'bye');
    } catch {
      // 이미 닫힘
    }
  }

  webSocketError() {}
}
