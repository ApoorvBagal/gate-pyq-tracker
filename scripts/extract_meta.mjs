// Extract per-question crop regions, answer keys, and GateOverflow URLs from volume1.pdf & volume2.pdf.
// Outputs data/question_meta.json keyed by `${volume}|${qid}`.
import * as pdfjs from "../node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const questions = JSON.parse(fs.readFileSync(path.join(root, "data/questions.json"), "utf8"));

const byVol = { "Vol 1": new Map(), "Vol 2": new Map() };
for (const q of questions) byVol[q.volume].set(q.qid, q);

const QID_RE = /^\d+\.\d+\.\d+$/;
const ANS_SKIP = new Set(["Answer Keys", "Answer", "Keys", "key", "☟"]);

async function processVolume(volName, pdfFile) {
  const data = new Uint8Array(fs.readFileSync(path.join(root, pdfFile)));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const want = byVol[volName];
  const starts = []; // { qid, page, yTop, url }
  const answers = new Map();
  let inAnswerKeys = false;

  for (let pn = 1; pn <= doc.numPages; pn++) {
    const page = await doc.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const [tc, anns] = await Promise.all([page.getTextContent(), page.getAnnotations()]);

    const goLinks = anns
      .filter((a) => a.subtype === "Link" && a.url && /^https:\/\/gateoverflow\.in\/\d+/.test(a.url) && a.rect)
      .map((a) => ({ url: a.url, x: a.rect[0], y: a.rect[1] }));

    const items = tc.items.filter((it) => it.str && it.str.trim());
    const hasAnswerKeyBtn = items.some((it) => it.str.trim() === "Answer key");

    // Only leave Answer Keys mode when we hit a page with actual question "Answer key" buttons (and before any new "Answer Keys" heading)
    if (hasAnswerKeyBtn && !items.some((it) => it.str.trim() === "Answer Keys")) inAnswerKeys = false;

    let pendingQid = null;
    for (let idx = 0; idx < items.length; idx++) {
      const s = items[idx].str.trim();
      const x = items[idx].transform[4];
      const y = items[idx].transform[5];

      if (s === "Answer Keys") {
        inAnswerKeys = true;
        pendingQid = null;
        continue;
      }
      if (s === "Answer key") {
        inAnswerKeys = false;
        pendingQid = null;
        continue;
      }

      if (inAnswerKeys) {
        if (y < 45) continue; // page number footer
        if (QID_RE.test(s)) {
          pendingQid = s;
        } else if (pendingQid && !ANS_SKIP.has(s)) {
          if (!answers.has(pendingQid)) answers.set(pendingQid, s);
          pendingQid = null;
        }
        continue;
      }

      // Question header: qid on left margin (x < 75) with a GateOverflow link on the same row
      if (x < 75 && QID_RE.test(s) && want.has(s) && goLinks.length > 0) {
        const link = goLinks.find((l) => Math.abs(l.y - y) < 18 && l.x > 65 && l.x < 220)
          || goLinks.find((l) => Math.abs(l.y - y) < 38);
        if (!link) continue;
        const yTop = Math.max(0, (vp.height - (y + 16)) / vp.height);
        starts.push({ qid: s, page: pn, yTop, url: link.url });
      }
    }
  }

  starts.sort((a, b) => a.page - b.page || a.yTop - b.yTop);
  const seen = new Set();
  const uniq = starts.filter((s) => (seen.has(s.qid) ? false : (seen.add(s.qid), true)));

  const meta = {};
  for (let i = 0; i < uniq.length; i++) {
    const cur = uniq[i];
    const next = uniq[i + 1];
    const crops = [];
    if (next && next.page === cur.page) {
      const y1 = Math.max(cur.yTop + 0.04, Math.min(0.94, next.yTop - 0.005));
      crops.push([cur.page, +cur.yTop.toFixed(4), +y1.toFixed(4)]);
    } else if (next && next.page === cur.page + 1 && next.yTop > 0.14) {
      crops.push([cur.page, +cur.yTop.toFixed(4), 0.94]);
      crops.push([next.page, 0.055, +Math.min(0.94, next.yTop - 0.005).toFixed(4)]);
    } else {
      crops.push([cur.page, +cur.yTop.toFixed(4), 0.94]);
    }
    meta[`${volName}|${cur.qid}`] = {
      c: crops,
      a: answers.get(cur.qid) || null,
      u: cur.url,
    };
  }

  const withAns = uniq.filter((u) => answers.has(u.qid)).length;
  console.log(`${volName}: found ${uniq.length}/${want.size} crops, ${withAns}/${uniq.length} answers`);
  return meta;
}

const m1 = await processVolume("Vol 1", "volume1.pdf");
const m2 = await processVolume("Vol 2", "volume2.pdf");
const all = { ...m1, ...m2 };
fs.writeFileSync(path.join(root, "data/question_meta.json"), JSON.stringify(all));
console.log("Total meta entries:", Object.keys(all).length, "size KB:", Math.round(fs.statSync(path.join(root, "data/question_meta.json")).size / 1024));
for (const k of ["Vol 2|1.3.14", "Vol 2|1.3.15", "Vol 2|1.1.5", "Vol 2|1.1.7", "Vol 1|1.1.1", "Vol 1|1.2.8"]) {
  console.log(k, all[k]);
}
