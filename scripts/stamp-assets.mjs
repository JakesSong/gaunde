#!/usr/bin/env node
/**
 * 정적 자산에 캐시버스팅 버전을 박는다.
 *
 * GitHub Pages 는 Cache-Control: max-age=600 으로 내려주고, Safari 는 그보다
 * 오래 물고 있는 일이 잦다. 파일명이 그대로면 강제 새로고침을 해도 예전 app.js 를
 * 계속 쓰는 경우가 생긴다.
 *
 * 그래서 index.html 의 <script src> 에 내용 해시를 쿼리로 붙인다.
 *   <script src="./app.js?v=1a2b3c4d"></script>
 * 파일이 바뀌면 URL 이 바뀌므로 브라우저가 캐시를 건너뛸 수밖에 없다.
 * (index.html 자체는 Pages 가 짧게 캐시하므로 그대로 두면 된다)
 *
 *   node scripts/stamp-assets.mjs           바꿀 게 있으면 바꾸고 0 으로 끝
 *   node scripts/stamp-assets.mjs --check   바꿀 게 있으면 1 로 끝 (CI/배포 전 확인용)
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const INDEX = path.join(PUBLIC, 'index.html');

const shortHash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);

const original = fs.readFileSync(INDEX, 'utf8');
const stamped = [];

/* src="./app.js" 또는 src="./app.js?v=..." 를 현재 해시로 맞춘다 */
const next = original.replace(
  /(<script\s+src=")\.\/([\w.-]+\.js)(\?v=[0-9a-f]+)?(")/g,
  (whole, head, file, _old, tail) => {
    const target = path.join(PUBLIC, file);
    if (!fs.existsSync(target)) return whole;      // 없는 파일은 건드리지 않는다
    const v = shortHash(target);
    stamped.push(`${file}?v=${v}`);
    return `${head}./${file}?v=${v}${tail}`;
  },
);

const changed = next !== original;

if (process.argv.includes('--check')) {
  console.log(changed ? '자산 버전이 오래됐습니다. `npm run stamp` 를 실행하세요.' : '자산 버전 최신');
  process.exit(changed ? 1 : 0);
}

if (changed) fs.writeFileSync(INDEX, next);
console.log(`${changed ? '갱신' : '변경 없음'}: ${stamped.join(', ')}`);
