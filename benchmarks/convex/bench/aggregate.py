#!/usr/bin/env python3
"""Aggregate r_*.csv resource samples into peak/median stats per (platform, mode)."""
import csv, glob, os, re, sys

def mem_to_mib(s):
    # "1.234GiB / 118.2GiB" -> MiB float
    m = re.match(r"([\d.]+)(GiB|MiB|KiB|B)", s.strip())
    if not m: return None
    v = float(m.group(1))
    return v * 1024 if m.group(2) == "GiB" else v / 1024 if m.group(2) == "KiB" else v if m.group(2) == "MiB" else v / (1024 * 1024)

rows = []
for f in sorted(glob.glob(os.path.join(os.path.dirname(__file__), "r_*.csv"))):
    base = os.path.basename(f)[2:-4]  # r_<platform>_<mode>.csv
    parts = base.split("_", 1)
    if len(parts) != 2: continue
    plat, mode = parts
    samples = {"convex-backend-1": [], "onebase-bench": [], "convex-dashboard-1": []}
    with open(f) as fh:
        for row in csv.reader(fh):
            if len(row) != 4 or row[1] not in samples: continue
            cpu = float(row[2].rstrip("%"))
            mem = mem_to_mib(row[3].split("/")[0]) if "/" in row[3] else None
            if mem is None: continue
            samples[row[1]].append((cpu, mem))
    out = {"file": base}
    for c, arr in samples.items():
        if not arr: continue
        cpus = sorted(a[0] for a in arr); mems = sorted(a[1] for a in arr)
        out[c] = {
            "n": len(arr),
            "cpu_med": cpus[len(cpus) // 2], "cpu_peak": cpus[-1],
            "mem_med": round(mems[len(mems) // 2]), "mem_peak": round(mems[-1]),
        }
    rows.append(out)

for r in rows:
    print(r["file"])
    for c, v in r.items():
        if c == "file": continue
        print(f"  {c:20s} n={v['n']:3d} cpu med={v['cpu_med']:6.1f}% peak={v['cpu_peak']:6.1f}%  ram med={v['mem_med']:6d}MiB peak={v['mem_peak']:6d}MiB")
