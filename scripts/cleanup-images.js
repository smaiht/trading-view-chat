#!/usr/bin/env node
/**
 * Cleanup images older than N days in IMAGES_DIR (default: ./data/images)
 * ENV:
 *  - IMAGES_DIR: directory to clean (default: CWD/data/images)
 *  - IMAGE_RETENTION_DAYS: days to keep (default: 1)
 *  - EXTRA_IMAGE_DIRS: optional comma-separated extra dirs to clean
 */
const fs = require('fs');
const path = require('path');

function listFilesRec(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const p = stack.pop();
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) out.push(full);
    }
  }
  return out;
}

(async () => {
  const days = parseInt(process.env.IMAGE_RETENTION_DAYS || '1', 10);
  const maxAgeMs = Math.max(days,1) * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const primary = process.env.IMAGES_DIR || path.join(process.cwd(), 'data', 'images');
  const extra = (process.env.EXTRA_IMAGE_DIRS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const dirs = Array.from(new Set([primary, ...extra]));

  let deleted = 0;
  for (const dir of dirs) {
    const files = listFilesRec(dir);
    for (const f of files) {
      try {
        const st = fs.statSync(f);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(f);
          deleted++;
        }
      } catch {}
    }
    // Optional: prune empty subdirectories
    const prune = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) if (e.isDirectory()) prune(path.join(d, e.name));
      try {
        const left = fs.readdirSync(d);
        if (left.length === 0 && d !== dir) fs.rmdirSync(d);
      } catch {}
    };
    prune(dir);
  }
  console.log(`cleanup-images: deleted ${deleted} files older than ${days} day(s) in: ${dirs.join(', ')}`);
})();
