// 로컬 확인용 정적 서버: public/ 을 http://localhost:8080 으로 띄운다.
// public/config.js 가 없으면 환경 변수 SUPABASE_URL, SUPABASE_KEY 로 설정을 만들어 준다.
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_KEY=sb_publishable_... npm run serve
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../public/', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path.includes('..')) return res.writeHead(400).end();
  if (path.endsWith('/')) path += 'index.html';
  let file = join(ROOT, path);
  try {
    if ((await stat(file)).isDirectory()) {
      res.writeHead(301, { Location: `${req.url}/` });
      return res.end();
    }
  } catch {
    if (path === '/config.js' && process.env.SUPABASE_URL) {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      return res.end(`window.MBTI_CONFIG = ${JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL, supabaseKey: process.env.SUPABASE_KEY })};\n`);
    }
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(await readFile(file));
}).listen(PORT, () => console.log(`http://localhost:${PORT}/`));
