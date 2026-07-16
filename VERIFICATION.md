---
title: "Verification Report"
---

# Claim-level verification of this archive

*Verification pass completed July 16, 2026. 1,777 cited claims machine-checked against the 158,000-page source corpus; all 199 machine-flagged contradictions adjudicated against primary sources; 14 confirmed errors corrected (16 edit sites including duplicated sentences).*

## Why and how

Every detail document in this archive cites its sources inline. This pass asked a harder question: **does each cited sentence actually match what its sources say?** The archetype error that motivated it was directional: an early draft placed the North Branch Pumping Station "just upstream" of the North Branch Dam when it is in fact downstream (river miles increase upstream). Errors of that class — inverted relations, transposed digits, conflated dates — survive ordinary proofreading because the sentence *looks* fine.

The pipeline (all local, on the project's own hardware):

1. **Claim extraction** — every sentence and table row carrying a citation marker in the 16 detail documents plus the overview: **1,777 claims**.
2. **Evidence retrieval** — for each claim, hybrid semantic + keyword search (Qwen3-Embedding-4B vectors in sqlite-vec, plus FTS5 BM25) over the full extracted corpus, prioritizing the claim's own cited source files.
3. **Local judging** — qwen3.5:27b compared each claim against its retrieved passages, instructed to be strict and to attend specifically to numbers and directional/spatial relations. Verdicts: SUPPORTED / PARTIAL / NOT_FOUND / CONTRADICTED.
4. **Adjudication** — every CONTRADICTED flag was then re-examined by a frontier-model review agent with full access to the documents, the source PDFs (including rendering scanned pages visually where OCR was garbled at the disputed digits), and the live web — ruling each flag a REAL_ERROR (with a proposed correction) or a FALSE_FLAG, with the reasoning recorded.
5. **Correction** — each REAL_ERROR ruling was reviewed and applied; the corrections are listed below and in the git history.

## Results

| Verdict | Claims | Share | Meaning |
|---|---|---|---|
| SUPPORTED | 164 | 9% | Retrieved passages directly confirm the claim |
| PARTIAL | 484 | 27% | Passages confirm part of the claim; remainder not found in top passages |
| NOT_FOUND | 930 | 52% | Top retrieved passages neither confirm nor refute |
| CONTRADICTED | 199 | 11% | A passage appeared to refute the claim → all adjudicated |

**Reading this honestly:** NOT_FOUND and PARTIAL are dominated by *retrieval misses*, not errors — broad summary sentences, claims citing web sources whose text is not in the local corpus, and passages that exist but did not rank in the top results. They are the cost of a strict, fully-local checker. The meaningful signal is the CONTRADICTED set, which was adjudicated exhaustively:

- **14 real errors (7% of flags)** — confirmed against primary sources and corrected.
- **177 false flags (89%)** — the document was right; the judge misread, retrieval pulled an irrelevant passage, or sources legitimately disagree and the document already presents the disagreement.
- **1 uncertain** — an unsourceable "5 billion gallons in-channel storage" figure; removed from the document pending a direct MWRD operational statement.

## The 14 confirmed errors (all corrected)

| Doc | Class | Error → correction |
|---|---|---|
| 01 | inversion | "two Michigan Ave mains with outlets into the lake" → one of the two outlets went to the river (Chesbrough 1855, p.12–13) |
| 01 | date | 1852 drainage act "June 23" → **June 28** (1891 DPW report, p.573) |
| 01 | number | I&M Canal costs $5,189,402.03 / $1,420,606.21 → **$5,139,492.03 / $1,429,606.21** (Brown 1894 p.252, verified by visual inspection of the scanned table) |
| 04 | inversion | "pumps push water by gravity through tunnels to stations" → water reaches stations by gravity; pumps lift it *into the mains* (1956 report pp.17–19) |
| 04 | date | Chesbrough born "July 8, 1813" → **July 6** (1933 booklet) |
| 04 | date | "July 20, 1867 first-pump milestone" → no such date in any source; table says **early 1869** |
| 05 | number | North West Land Tunnel "10.8-ft diameter" → **10-ft main bore, 8-ft branches** (the source table's comma misread as a decimal point) |
| 06 (+07) | date | Sanitary & Ship Canal "completed January 2, 1900" → construction completed 1898; opened January 1900, full flow January 16–17 via Lockport |
| 13 | inversion | "Higgins Creek joins the Des Plaines" → Higgins joins **Willow Creek**, which reaches the Des Plaines near Rosemont (USGS WRI 79-111) — independently confirmed by this project's map tracing |
| 13 ×2 | inversion | "Lemont digests solids on-site" → Lemont only gravity-concentrates; digestion happens downstream (MWRD Annual Biosolids Reports, multiple years) |
| 14 | number | TARP "an $8 billion program" → **$3.86 billion** (MWRD TARP Status Report, Dec. 2024) |
| 16 | status | Calumet contract 23-379-3E "Under construction" → **Design** (MWRD 2026 Budget Book, p.434) |
| 16 | date | 17-273-4P "October 2024 completion, already finished" → awarded Oct. 2024, substantial completion target **May 2026** |

Five of the fourteen are the directional/relational archetype the pass was designed to catch. Two required rendering the original scanned pages at high resolution because the OCR text was garbled at exactly the disputed digits.

## Limitations and next steps

- The local judge's false-flag rate (89% of CONTRADICTED) is the price of strictness; every flag was human/frontier-adjudicated, so no false flag resulted in a change.
- The 484 PARTIAL verdicts carry the judge's specific complaint per claim and are queued for a lighter triage pass.
- Figures and maps in the corpus are being made retrievable via a vision-model captioning pass (26,142 candidate pages); future verification rounds will benefit from figure-level evidence that pure-text retrieval cannot see.
- Verification tooling: `rag/verify.py` (extraction, retrieval, judging), adjudication records in the project archive. Corrections are individually attributable in git history.
