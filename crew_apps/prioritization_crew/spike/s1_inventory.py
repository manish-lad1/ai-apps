"""Spike step 1: list Foundry Local chat models, sizes, tool-calling support, cache state."""

import json
import subprocess
import time

from common import save

t = time.perf_counter()
raw = subprocess.run(["foundry", "model", "list", "--output", "json"], capture_output=True, text=True).stdout
models = [m for m in json.loads(raw)["models"] if m["type"] in ("Chat", "Multimodal")]
models.sort(key=lambda m: m["fileSizeMb"])

print(f"{'alias':32} {'size GB':>8} {'tools':>6} {'cached':>7}")
for m in models:
    print(f"{m['alias']:32} {m['fileSizeMb'] / 1024:8.1f} {'yes' if m['supportsToolCalling'] else 'no':>6} "
          f"{'yes' if m['cached'] else 'no':>7}")
elapsed = time.perf_counter() - t
print(f"\n{len(models)} chat/multimodal models, listed in {elapsed:.1f}s")
save("s1_inventory", {"elapsed_s": elapsed, "models": models})
