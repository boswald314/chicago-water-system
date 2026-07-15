#!/usr/bin/env python3
"""
Build SOURCES-MANIFEST.md by walking sources/ and joining filenames against
the provenance tables in sources/_hunt/*.md ("hunt ledgers").

Usage:
    python3 scripts/build_sources_manifest.py

Writes /Users/bryanoswald/Documents/Research/ChicagoSewers/SOURCES-MANIFEST.md
and prints a per-folder match-rate summary to stdout (used to help write the
folder-summary table in SOURCES.md).

Why basename-based joins: the hunt ledgers were written by many different
research passes over months, with inconsistent conventions -- some rows give
a full ``sources/<folder>/<file>`` path in backticks, some a bare filename,
some reference the real filename only in the trailing "note" column (e.g.
"file (already held) ... matches already-held `sources/.../foo.pdf`"), and a
handful describe several files in one row with an ellipsis. Folder paths in
the ledgers occasionally don't match where a file ended up on disk (files got
reorganized after the ledger entry was written). The one thing that is
reliably stable is the filename itself, so we index every ledger row by every
filename-shaped token found in its "file" and "note" cells, then look each
real file on disk up by its basename.
"""
import os
import re
import sys
from collections import defaultdict, OrderedDict

REPO_ROOT = "/Users/bryanoswald/Documents/Research/ChicagoSewers"
SOURCES_DIR = os.path.join(REPO_ROOT, "sources")
HUNT_DIR = os.path.join(SOURCES_DIR, "_hunt")
OUTPUT_PATH = os.path.join(REPO_ROOT, "SOURCES-MANIFEST.md")

SKIP_TOP_LEVEL_DIRS = {"_hunt", "_new"}
SKIP_FILENAMES = {".DS_Store"}

FILE_EXT_PATTERN = r"pdf|html?|txt|xlsx?|jpe?g|png|mp3|md|docx?|csv|json|tsv"
FILENAME_TOKEN_RE = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_%.\-]*\.(?:" + FILE_EXT_PATTERN + r")\b",
    re.IGNORECASE,
)
URL_RE = re.compile(r"https?://[^\s<>|`\)]+", re.IGNORECASE)
SEPARATOR_ROW_RE = re.compile(r"^:?-+:?$")


# ---------------------------------------------------------------------------
# Ledger parsing
# ---------------------------------------------------------------------------

def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def is_separator_row(cells):
    nonblank = [c for c in cells if c.strip() != ""]
    if not nonblank:
        return False
    return all(SEPARATOR_ROW_RE.match(c.strip()) for c in nonblank)


def find_header_index(header, *keywords):
    """Return the index of the first header cell containing any keyword."""
    for i, h in enumerate(header):
        hl = h.lower()
        for kw in keywords:
            if kw in hl:
                return i
    return None


def clean_title(text):
    text = text.strip()
    # strip surrounding markdown emphasis/backticks
    text = text.strip("*")
    text = re.sub(r"^`|`$", "", text)
    return text.strip()


def extract_urls(cell):
    return URL_RE.findall(cell)


def extract_filenames(cell):
    return FILENAME_TOKEN_RE.findall(cell)


def parse_ledger_file(path, primary, secondary, stats):
    """Parse one _hunt/*.md ledger file's markdown tables.

    Populates `primary` (filename token found in the "file" column -- high
    confidence) and `secondary` (filename token found only in the "note"
    column -- lower confidence, used as a fallback) dicts of
    basename -> (title, url, ledger_basename).
    """
    ledger_name = os.path.basename(path)
    with open(path, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if not line.lstrip().startswith("|"):
            i += 1
            continue
        header_cells = split_row(line)
        # A real header row is followed by a separator row.
        if i + 1 >= n or not lines[i + 1].lstrip().startswith("|"):
            i += 1
            continue
        sep_cells = split_row(lines[i + 1])
        if not is_separator_row(sep_cells):
            i += 1
            continue

        file_idx = find_header_index(header_cells, "file")
        title_idx = find_header_index(header_cells, "title")
        url_idx = find_header_index(header_cells, "url")
        note_idx = find_header_index(header_cells, "note")

        j = i + 2
        while j < n and lines[j].lstrip().startswith("|"):
            row_cells = split_row(lines[j])
            if is_separator_row(row_cells):
                j += 1
                continue
            stats["rows_seen"] += 1

            title = clean_title(row_cells[title_idx]) if (
                title_idx is not None and title_idx < len(row_cells)
            ) else ""
            urls = (
                extract_urls(row_cells[url_idx])
                if url_idx is not None and url_idx < len(row_cells)
                else []
            )
            url = urls[0] if urls else ""

            file_cell = (
                row_cells[file_idx]
                if file_idx is not None and file_idx < len(row_cells)
                else ""
            )
            note_cell = (
                row_cells[note_idx]
                if note_idx is not None and note_idx < len(row_cells)
                else ""
            )

            file_tokens = extract_filenames(file_cell)
            for tok in file_tokens:
                base = os.path.basename(tok)
                if base not in primary:
                    primary[base] = (title, url, ledger_name)
                    stats["primary_hits"] += 1

            note_tokens = extract_filenames(note_cell)
            for tok in note_tokens:
                base = os.path.basename(tok)
                if base not in secondary:
                    secondary[base] = (title, url, ledger_name)
                    stats["secondary_hits"] += 1

            j += 1
        i = j


def build_ledger_index():
    primary = {}
    secondary = {}
    stats = defaultdict(int)
    ledger_files = sorted(
        f for f in os.listdir(HUNT_DIR) if f.endswith(".md")
    )
    for fname in ledger_files:
        parse_ledger_file(os.path.join(HUNT_DIR, fname), primary, secondary, stats)
    print(
        f"[ledger] parsed {len(ledger_files)} ledger .md files: "
        f"{stats['rows_seen']} table rows, "
        f"{len(primary)} unique basenames from file-column, "
        f"{len(secondary)} additional unique basenames from note-column",
        file=sys.stderr,
    )
    return primary, secondary


# ---------------------------------------------------------------------------
# Filename humanization (fallback when no ledger match)
# ---------------------------------------------------------------------------

DATE_PREFIX_RE = re.compile(r"^(\d{4}(?:-\d{2}(?:-\d{2})?)?|undated)[-_]")

ACRONYM_FIXES = {
    "mwrd": "MWRD", "tarp": "TARP", "ipcb": "IPCB", "usace": "USACE",
    "gao": "GAO", "ijc": "IJC", "epa": "EPA", "uaa": "UAA", "wrp": "WRP",
    "caws": "CAWS", "cso": "CSO", "csos": "CSOs", "isws": "ISWS",
    "idnr": "IDNR", "usgs": "USGS", "naid": "NAID", "acfr": "ACFR",
    "cafr": "CAFR", "eis": "EIS", "npdes": "NPDES", "cwa": "CWA",
    "msdgc": "MSDGC", "waws": "WAWS", "sma": "SMA", "hpwrp": "HPWRP",
    "erdc": "ERDC", "wes": "WES", "dwm": "DWM", "cdot": "CDOT",
    "ceqa": "CEQA", "gdm": "GDM", "safl": "SAFL", "nara": "NARA",
    "loc": "LOC", "wttw": "WTTW", "iepa": "IEPA", "iit": "IIT",
    "uiuc": "UIUC", "uic": "UIC", "cmap": "CMAP", "faq": "FAQ",
    "ms4": "MS4", "swmp": "SWMP", "cip": "CIP", "vs": "vs.",
}


def humanize_filename(filename):
    stem, _ext = os.path.splitext(filename)
    stem = DATE_PREFIX_RE.sub("", stem)
    words = re.split(r"[-_]+", stem)
    words = [w for w in words if w != ""]
    fixed = []
    for w in words:
        wl = w.lower()
        if wl in ACRONYM_FIXES:
            fixed.append(ACRONYM_FIXES[wl])
        elif re.fullmatch(r"\d+", w):
            fixed.append(w)
        else:
            fixed.append(w[:1].upper() + w[1:] if w else w)
    text = " ".join(fixed)
    text = re.sub(r"\s+", " ", text).strip()
    return text or stem


# ---------------------------------------------------------------------------
# Walk sources/ and join
# ---------------------------------------------------------------------------

def walk_sources():
    """Return OrderedDict of folder -> sorted list of relative file paths."""
    folders = OrderedDict()
    top_level = sorted(
        d for d in os.listdir(SOURCES_DIR)
        if os.path.isdir(os.path.join(SOURCES_DIR, d)) and d not in SKIP_TOP_LEVEL_DIRS
    )
    for folder in top_level:
        folder_path = os.path.join(SOURCES_DIR, folder)
        files = []
        for dirpath, _dirnames, filenames in os.walk(folder_path):
            for fn in sorted(filenames):
                if fn in SKIP_FILENAMES or fn.startswith("."):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, REPO_ROOT)
                files.append(rel)
        files.sort()
        folders[folder] = files
    return folders


def escape_md_pipe(text):
    return text.replace("|", "\\|")


def main():
    primary, secondary = build_ledger_index()
    folders = walk_sources()

    total_files = 0
    total_matched_primary = 0
    total_matched_secondary = 0
    total_unmatched = 0
    folder_stats = []

    out_lines = []
    out_lines.append("---")
    out_lines.append('title: "Full source-file manifest"')
    out_lines.append("---")
    out_lines.append("")
    out_lines.append("# Full Source-File Manifest")
    out_lines.append("")
    out_lines.append(
        "Auto-generated by `scripts/build_sources_manifest.py`. One row per file "
        "actually present in `sources/` (excluding the in-progress `_hunt/` and "
        "`_new/` working directories). Titles and source URLs are pulled from the "
        "matching row in `sources/_hunt/*.md` (the hunt ledgers) when a ledger "
        "entry names that exact filename; otherwise the description is a "
        "best-effort humanization of the filename itself and the URL column is "
        "left blank. This file supersedes the old hand-curated \"Downloaded "
        "documents\" tables in [SOURCES.md](SOURCES.md), which could not keep "
        "pace with the archive's growth — see SOURCES.md for the cited-source "
        "bibliography tables (Tiers 1-4) and a per-folder summary."
    )
    out_lines.append("")
    out_lines.append("Regenerate after adding files: `python3 scripts/build_sources_manifest.py`")
    out_lines.append("")
    out_lines.append("STATS_PLACEHOLDER")
    out_lines.append("")

    total_matched_companion = 0

    for folder, files in folders.items():
        if not files:
            continue
        matched_p = matched_s = matched_c = unmatched = 0

        # Resolve each file's (title, url, tier) where tier in {"p","s",None}.
        resolved = {}
        for rel in files:
            fn = os.path.basename(rel)
            if fn in primary:
                title, url, _src = primary[fn]
                resolved[rel] = (title, url, "p")
            elif fn in secondary:
                title, url, _src = secondary[fn]
                resolved[rel] = (title, url, "s")
            else:
                resolved[rel] = (None, None, None)

        # Tier 3: companion files sharing a stem (different extension, e.g. a
        # .txt OCR/text-extract sibling of a matched .pdf) within the SAME
        # folder inherit the matched sibling's title/url.
        by_stem = defaultdict(list)
        for rel in files:
            stem, _ext = os.path.splitext(os.path.basename(rel))
            by_stem[stem].append(rel)
        for stem, group in by_stem.items():
            if len(group) < 2:
                continue
            donor = next(
                ((r, resolved[r]) for r in group if resolved[r][0]), None
            )
            if donor is None:
                continue
            donor_rel, (dtitle, durl, _dtier) = donor
            for r in group:
                if resolved[r][0] is None:
                    resolved[r] = (dtitle, durl, "c")

        out_lines.append(f"## {folder} ({len(files)} files)")
        out_lines.append("")
        out_lines.append("| File | Title / description | Source URL |")
        out_lines.append("|---|---|---|")
        for rel in files:
            fn = os.path.basename(rel)
            title, url, tier = resolved[rel]
            if tier == "p":
                matched_p += 1
            elif tier == "s":
                matched_s += 1
            elif tier == "c":
                matched_c += 1
            else:
                unmatched += 1
            if not title:
                title = humanize_filename(fn)
            title_cell = escape_md_pipe(title)
            url_cell = f"<{url}>" if url else "—"
            out_lines.append(f"| `{rel}` | {title_cell} | {url_cell} |")
        out_lines.append("")

        total_files += len(files)
        total_matched_primary += matched_p
        total_matched_secondary += matched_s
        total_matched_companion += matched_c
        total_unmatched += unmatched
        folder_stats.append((folder, len(files), matched_p, matched_s, matched_c, unmatched))

    matched_total = total_matched_primary + total_matched_secondary + total_matched_companion
    pct = (matched_total / total_files * 100) if total_files else 0.0
    stats_block = (
        f"**Totals:** {total_files} files across {len(folder_stats)} folders — "
        f"{matched_total} ({pct:.0f}%) matched to a ledger row "
        f"({total_matched_primary} via the ledger's file column, "
        f"{total_matched_secondary} via a filename mentioned in its note column, "
        f"{total_matched_companion} inherited from a same-folder, same-stem sibling "
        f"file — e.g. a `.txt` OCR extract matched via its companion `.pdf`), "
        f"{total_unmatched} described from filename only (no ledger match found; "
        f"mostly the pre-July-2026 baseline archive, whose files predate the hunt "
        f"ledgers, plus a few ledger rows that summarize a multi-file series "
        f"without enumerating every filename)."
    )
    out_lines = [stats_block if l == "STATS_PLACEHOLDER" else l for l in out_lines]

    with open(OUTPUT_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out_lines) + "\n")

    print(f"\n[write] {OUTPUT_PATH}", file=sys.stderr)
    print(
        f"[totals] {total_files} files, {matched_total} matched "
        f"({total_matched_primary} primary + {total_matched_secondary} secondary + "
        f"{total_matched_companion} companion), "
        f"{total_unmatched} unmatched ({pct:.1f}% match rate)",
        file=sys.stderr,
    )
    print("\nfolder,files,matched_primary,matched_secondary,matched_companion,unmatched", file=sys.stderr)
    for folder, n, mp, ms, mc, u in folder_stats:
        print(f"{folder},{n},{mp},{ms},{mc},{u}", file=sys.stderr)


if __name__ == "__main__":
    main()
