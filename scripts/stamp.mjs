// 배포 때만 실행: public/ 의 HTML·JS가 부르는 파일 주소에 버전(?v=커밋)을 붙인다.
// GitHub Pages가 파일을 최대 10분 캐시해서, 배포 직후 휴대폰이 옛 파일과 새 파일을 섞어 받는 일을 막는다.
//   node scripts/stamp.mjs <버전>
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = (process.argv[2] || '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 12);
if (!version) {
  console.error('버전을 넣어 주세요. 예: node scripts/stamp.mjs abc1234');
  process.exit(1);
}
const root = new URL('../public/', import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(html|js)$/.test(f) && !p.includes('/vendor/')) files.push(p);
  }
};
walk(root);

let count = 0;
for (const p of files) {
  const before = readFileSync(p, 'utf8');
  let s = before;
  if (p.endsWith('.html')) {
    // <script src="../x.js">, <link href="../style.css">
    s = s.replace(/((?:src|href)=")((?:\.\.\/|\.\/)?[\w./-]+\.(?:js|css))(")/g, `$1$2?v=${version}$3`);
  } else {
    // import ... from './x.js'
    s = s.replace(/(from\s+')(\.\/[\w-]+\.js)(')/g, `$1$2?v=${version}$3`);
  }
  if (s !== before) {
    writeFileSync(p, s);
    count += 1;
  }
}
console.log(`버전 ${version}: 파일 ${count}개에 표시를 붙였습니다.`);
