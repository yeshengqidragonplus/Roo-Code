---
"qcode": patch
---

- Fix: apply_diff no longer fails to match text that differs only by full-width vs half-width characters (e.g. full-width `（），！？` vs ASCII `(),!?`), Unicode NFC/NFD form, or invisible zero-width/directional-control characters. `normalizeString` now applies NFC normalization, full-width→half-width conversion, and zero-width character stripping before similarity comparison. These affect match detection only; the original bytes are still written back to the file.
