"""One-off: convert gate_pyq_tracker.xlsx -> data/questions.json (no deps)."""
import json, re, sys, zipfile
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
src, out = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
ss = ["".join(t.text or "" for t in si.iter("{%s}t" % NS["m"]))
      for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]

def rows(name):
    root = ET.fromstring(z.read(f"xl/worksheets/{name}.xml"))
    for r in root.iter("{%s}row" % NS["m"]):
        row = {}
        for c in r.findall("m:c", NS):
            col = re.match(r"[A-Z]+", c.get("r")).group()
            v = c.find("m:v", NS)
            if v is None:
                isv = c.find("m:is", NS)
                val = "".join(t.text or "" for t in isv.iter("{%s}t" % NS["m"])) if isv is not None else None
            else:
                val = ss[int(v.text)] if c.get("t") == "s" else v.text
            row[col] = val
        yield row

tracker = list(rows("sheet2"))
header = tracker[0]
print("Tracker header:", header)
topics = list(rows("sheet3"))
print("Topics header:", topics[0], topics[1])
cols = {v: k for k, v in header.items() if v}
qs = []
for r in tracker[1:]:
    if not r.get(cols["ID"]):
        continue
    g = lambda k: r.get(cols[k]) if k in cols else None
    qs.append({
        "qid": g("ID"), "volume": g("Volume"), "subject": g("Subject"), "topic": g("Topic"),
        "exam": g("Exam"), "pdf_page": int(float(g("PDF page"))) if g("PDF page") else None,
        "difficulty": g("Difficulty"),
        "status": g("Status") or "Unsolved", "important": (g("Important") or "").lower() == "yes",
        "notes": g("Notes") or "",
    })
# fill subject from Topics sheet if missing
th = {v: k for k, v in topics[0].items() if v}
tmap = {}
if "Topic" in th and "Subject" in th:
    for r in topics[1:]:
        tmap[(r.get(th.get("Volume", "")), r.get(th["Topic"]))] = r.get(th["Subject"])
        tmap.setdefault((None, r.get(th["Topic"])), r.get(th["Subject"]))
for q in qs:
    if not q["subject"]:
        q["subject"] = tmap.get((q["volume"], q["topic"])) or tmap.get((None, q["topic"])) or "Other"
json.dump(qs, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(len(qs), "questions;", sorted({q["subject"] for q in qs}))
print("statuses:", {s: sum(q["status"] == s for q in qs) for s in {q["status"] for q in qs}})
