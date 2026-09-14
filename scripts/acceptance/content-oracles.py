"""Authored, deterministic checks for concrete errors in the acceptance outputs.

No generated code is executed. Run from the repository root with Python 3.
"""
import json
from pathlib import Path

result = {"runtime": "Python 3", "checks": []}

records = [(3, "x"), (1, "y"), (2, "x"), (1, "x")]
first = sorted(records, key=lambda row: row[1])
final = sorted(first, key=lambda row: row[0])
assert first == [(3, "x"), (2, "x"), (1, "x"), (1, "y")]
assert final == [(1, "x"), (1, "y"), (2, "x"), (3, "x")]
result["checks"].append({"case": "short-03", "firstPass": first, "final": final,
                         "finding": "The answer key is correct; its intermediate ordering and explanation are wrong."})

records = [(2, "x"), (1, "y"), (2, "y")]
final = sorted(sorted(records, key=lambda row: row[1]), key=lambda row: row[0])
assert final == [(1, "y"), (2, "x"), (2, "y")]
result["checks"].append({"case": "plan-multi-01/sorting", "final": final,
                         "correctIndex": 0, "generatedIndex": 1, "finding": "Wrong answer key."})

def append_default(x, items=[]):
    items.append(x)
    return items

def none_default(x, items=None):
    if items is None:
        items = []
    items.append(x)
    return items

def concat_default(x, items=[]):
    items = items + [x]
    return items

observed = {}
for name, function in [("append", append_default), ("none", none_default), ("concat", concat_default)]:
    observed[name] = [list(function(1)), list(function(2))]
assert observed == {"append": [[1], [1, 2]], "none": [[1], [2]], "concat": [[1], [2]]}
result["checks"].append({"case": "plan-multi-05/default-parameter", "observed": observed,
                         "validIndicesForAvoidingAccumulation": [1, 2],
                         "finding": "Both None and concatenation avoid cross-call mutation in the shown bodies; the distractor explanation falsely claims concatenation accumulates."})

out = Path("test-results/2026-09-06-product-acceptance/content-oracles.json")
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"{len(result['checks'])} content oracles passed; findings saved to {out}")
