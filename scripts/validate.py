"""Independent check: load DXF files with ezdxf and run its auditor.

Usage: .venv/Scripts/python -I scripts/validate.py file.dxf [...]
Exit code 1 if any file fails to load or has unfixable audit errors.
"""
import sys
from collections import Counter

import ezdxf
from ezdxf import recover

bad = 0
for path in sys.argv[1:]:
    try:
        doc = ezdxf.readfile(path)
    except Exception as e:  # strict loader failed: report what recover() sees
        print(f"FAIL {path}: strict load error: {e}")
        bad += 1
        try:
            doc, auditor = recover.readfile(path)
            for err in auditor.errors[:10]:
                print("   ", err.message)
        except Exception as e2:
            print("    recover failed:", e2)
        continue
    auditor = doc.audit()
    counts = Counter(e.dxftype() for e in doc.modelspace())
    status = "OK  " if not auditor.has_errors else "FAIL"
    if auditor.has_errors:
        bad += 1
    print(f"{status} {path}: {doc.dxfversion} {sum(counts.values())} entities, "
          f"{len(auditor.errors)} errors, {len(auditor.fixes)} fixes")
    for err in auditor.errors[:10]:
        print("    error:", err.message)
    for fix in auditor.fixes[:5]:
        print("    fix:", fix.message)
sys.exit(1 if bad else 0)
