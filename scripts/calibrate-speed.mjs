#!/usr/bin/env node
/**
 * 노선등급별 주행시간 배율(SPEED_FACTOR) 보정기.
 *
 * build-graph.mjs 의 REFERENCES(공표 전구간 소요시간)와
 * 현재 그래프가 계산한 소요시간을 비교해 등급별 배율을 산출한다.
 *
 *   사용법: node scripts/build-graph.mjs && node scripts/calibrate-speed.mjs
 *   출력된 값을 build-graph.mjs 의 SPEED_FACTOR 에 반영한 뒤 다시 빌드한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetroGraph } from '../server/graph.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const graph = new MetroGraph(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')));
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'build-report.json'), 'utf8'));

const curClass = graph.meta.model.speedFactorClass;
const curLine = graph.meta.model.speedFactorLine;
const cur = (line) => curLine[line] ?? curClass[graph.lines[line].class] ?? 1;
console.log('현재 등급배율:', curClass);
console.log('현재 노선배율:', curLine, '\n');
console.log('노선     구간                     공표     모델    비율   현재배율 → 권장배율');
console.log('─'.repeat(78));

const byClass = new Map();
const lineSuggest = {};
for (const ref of report.references) {
  const a = graph.findStations(ref.from)[0];
  const b = graph.findStations(ref.to)[0];
  if (!a || !b) { console.log(`  !! ${ref.line}: 역 미발견 (${ref.from}/${ref.to})`); continue; }

  /* 해당 노선만 사용하도록 제한한 소요시간을 얻기 위해, 전체 그래프에서 계산하되
     환승 없이 같은 노선으로만 이어지는지 확인한다. */
  const r = graph.dijkstra(a.id);
  const path_ = graph.buildPath(r, a.id, b.id);
  const modelMin = r.stationTime[b.id] / 60;
  const onlyLine = path_ && path_.legs.every((l) => l.line === ref.line);

  const cls = graph.lines[ref.line].class;
  const ratio = ref.minutes / modelMin;
  const suggested = +(cur(ref.line) * ratio).toFixed(3);
  if (onlyLine) {
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls).push(suggested);
    lineSuggest[ref.line] = suggested;
  }
  console.log(
    `${ref.line.padEnd(8)} ${(ref.from + '→' + ref.to).padEnd(22)} ` +
    `${String(ref.minutes).padStart(4)}분 ${modelMin.toFixed(1).padStart(7)}분 ` +
    `${ratio.toFixed(3).padStart(7)}   ${String(cur(ref.line)).padStart(5)} → ${suggested}` +
    (onlyLine ? '' : '   [경유노선 혼합 — 배율 산출 제외]'),
  );
}

console.log('\n권장 등급 기본값 (기준점 있는 노선의 평균):');
const out = { ...curClass };
for (const [cls, vals] of byClass) out[cls] = +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3);
console.log(JSON.stringify(out, null, 2));
console.log('\n비율이 1.000 에 가까우면 현재 배율이 공표치를 잘 재현하고 있다는 뜻.');

/* --apply : build-graph.mjs 의 배율 상수를 권장값으로 덮어쓴다.
 * 정차시간(dwell)은 배율의 영향을 받지 않는 고정비용이라 한 번에 수렴하지 않는다.
 * build → calibrate --apply 를 비율이 1.000 에 붙을 때까지 반복한다. */
if (process.argv.includes('--apply')) {
  const src = path.join(ROOT, 'scripts', 'build-graph.mjs');
  let text = fs.readFileSync(src, 'utf8');
  const fmt = (v) => v.toFixed(3);

  text = text.replace(/(const SPEED_FACTOR_CLASS = \{)([\s\S]*?)(\n\};)/, (_m, head, body, tail) => {
    const patched = body.replace(/^(\s*)(\w+):\s*[\d.]+,/gm, (line, sp, key) =>
      out[key] !== undefined ? `${sp}${key}: ${fmt(out[key])},` : line);
    return head + patched + tail;
  });
  text = text.replace(/(const SPEED_FACTOR_LINE = \{)([\s\S]*?)(\n\};)/, (_m, head, body, tail) => {
    const patched = body.replace(/^(\s*)'([^']+)':\s*[\d.]+,/gm, (line, sp, key) =>
      lineSuggest[key] !== undefined ? `${sp}'${key}': ${fmt(lineSuggest[key])},` : line);
    return head + patched + tail;
  });
  fs.writeFileSync(src, text);
  console.log('\nbuild-graph.mjs 배율 상수를 갱신했습니다. 다시 빌드하세요.');
}
