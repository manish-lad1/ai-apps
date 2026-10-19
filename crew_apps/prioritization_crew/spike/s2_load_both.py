"""Spike step 3: load the small model and a 12b-class model together; report memory.

Usage: python s2_load_both.py <small alias> <big alias>

Memory is reported three ways because unified memory makes any single number
misleading: system used memory delta, the foundrylocald RSS, and what
`foundry status` calls available memory. GPU-resident weights on Apple silicon
may not show up in RSS at all, so the system delta is the honest one.
"""

import subprocess
import sys
import time

import psutil

from common import foundry_status, load, resolve, save, unload


def daemon_rss_gb() -> float:
    total = 0
    for p in psutil.process_iter(["name", "memory_info"]):
        if p.info["name"] and "foundrylocal" in p.info["name"]:
            total += p.info["memory_info"].rss
    return total / 2**30


def snapshot(label: str) -> dict:
    vm = psutil.virtual_memory()
    st = foundry_status()
    s = {
        "label": label,
        "sys_used_gb": round((vm.total - vm.available) / 2**30, 2),
        "daemon_rss_gb": round(daemon_rss_gb(), 2),
        "foundry_available_gb": round(st["system"]["availableMemoryBytes"] / 2**30, 2),
        "loaded": st["models"]["loaded"],
        "swap_used_gb": round(psutil.swap_memory().used / 2**30, 2),
        "pressure_free_pct": subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True)
        .stdout.strip().splitlines()[-1].split(":")[-1].strip(),
    }
    print(s)
    return s


small_alias, big_alias = sys.argv[1], sys.argv[2]
small, big = resolve(small_alias), resolve(big_alias)
for m in [e["id"] for e in __import__("json").loads(
        subprocess.run(["foundry", "model", "list", "--output", "json"], capture_output=True, text=True).stdout
    )["models"] if e["cached"]]:
    unload(m)  # start from nothing loaded, not just these two
time.sleep(3)

snaps = [snapshot("baseline")]
t_small = load(small)
snaps.append(snapshot(f"after {small_alias} ({t_small:.1f}s)"))
t_big = load(big)
snaps.append(snapshot(f"after {big_alias} ({t_big:.1f}s)"))
print(subprocess.run(["foundry", "cache", "list"], capture_output=True, text=True).stdout)

save(f"s2_load_{small_alias}_{big_alias}", {
    "small": small, "big": big, "load_s": {small_alias: t_small, big_alias: t_big}, "snapshots": snaps,
})
