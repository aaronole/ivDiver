"""
IV Deep Diver - core logic (no Streamlit imports, so it can be tested alone).

Runs single_analyzer.js (which downloads the latest PvPoke files live) for one
Pokemon against the whole 1500 rankings, then turns the raw results into the
same breakpoint / bulkpoint entries the Word report used.
"""

import html
import json
import os
import re
import shutil
import subprocess
import tempfile

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
ANALYZER = os.path.join(APP_DIR, "single_analyzer.js")

# PVPOKE_BASE is only for testing against a mirror; normally pvpoke.com.
BASE = os.environ.get("PVPOKE_BASE", "https://pvpoke.com").rstrip("/")
RANKINGS_URL = BASE + "/data/rankings/all/overall/rankings-1500.json"

PROGRESS_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s+analyzed")


class AnalysisError(Exception):
    pass


# -------------------------------------
# Pokemon list for the search box
# -------------------------------------

def fetch_pokemon_options():
    """[(speciesId, speciesName), ...] in rankings order, from live rankings."""
    try:
        res = requests.get(RANKINGS_URL, timeout=30)
        res.raise_for_status()
        data = res.json()
    except Exception as err:
        raise AnalysisError(
            f"Couldn't load the Pokémon list from PvPoke ({err})."
        )

    return [(e["speciesId"], e["speciesName"]) for e in data]


# -------------------------------------
# Run the analysis
# -------------------------------------

def run_analysis(species_id, on_progress=None):
    """
    Analyze species_id against the whole live rankings.
    on_progress(done, total) is called as matchups complete.
    Returns (results, failures).
    """
    node = shutil.which("node")

    if not node:
        raise AnalysisError(
            "Node.js isn't installed on this server, so the analysis can't run."
        )

    out_fd, out_path = tempfile.mkstemp(suffix=".json")
    os.close(out_fd)

    stderr_lines = []

    try:
        proc = subprocess.Popen(
            [node, ANALYZER, species_id, "ALL", out_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

        for line in proc.stderr:
            line = line.rstrip()
            stderr_lines.append(line)

            m = PROGRESS_RE.search(line)

            if m and on_progress:
                on_progress(int(m.group(1)), int(m.group(2)))

        proc.wait()

        if proc.returncode != 0:
            detail = next(
                (l for l in reversed(stderr_lines) if l.startswith("ERROR")),
                "\n".join(stderr_lines[-3:]),
            )
            raise AnalysisError(f"The analysis failed. {detail}")

        with open(out_path, encoding="utf-8") as f:
            payload = json.load(f)

    finally:
        if os.path.exists(out_path):
            os.remove(out_path)

    if not payload["results"]:
        raise AnalysisError(
            "No matchups could be analyzed for that Pokémon."
        )

    return payload["results"], payload["failures"]


# -------------------------------------
# Same logic as ivDiverSingle.py
# -------------------------------------

def build_flips(shield_tiers):
    """(confirmed, possible): shield scenarios that flip / may flip."""
    confirmed = []
    possible = []

    for shield in ["0s", "1s", "2s"]:
        tier = shield_tiers.get(shield, 4)

        if tier in [1, 2]:
            confirmed.append(shield)
        elif tier == 3:
            possible.append(shield)

    return confirmed, possible


def build_report(results):
    breakpoints = []
    bulkpoints = []
    breakpoint_move = None

    for data in results:
        bp = data["breakpoint"]
        bk = data["bulkpoint"]

        if bp["exists"] and bp["overallTier"] < 4:
            if breakpoint_move is None:
                breakpoint_move = bp["fastMove"]

            confirmed, possible = build_flips(bp["shieldTiers"])

            if bp["guaranteedBP"] > 0:
                detail = (
                    f"around {bp['defaultBP']:.2f} atk, "
                    f"guaranteed at {bp['guaranteedBP']:.2f} atk"
                )
            else:
                detail = (
                    f"around {bp['defaultBP']:.2f} atk, "
                    f"cannot be guaranteed"
                )

            breakpoints.append({
                "opponent": data["pokeB"],
                "move": None,
                "detail": detail,
                "confirmed": confirmed,
                "possible": possible,
            })

        if bk["exists"] and bk["overallTier"] < 4:
            confirmed, possible = build_flips(bk["shieldTiers"])

            if bk["likelyBK"] > 0:
                detail = (
                    f"around {bk['highrankBK']:.2f}"
                    f"-{bk['likelyBK']:.2f} def"
                )
            else:
                detail = (
                    f"around {bk['highrankBK']:.2f} def, "
                    f"only reachable vs. high rank"
                )

            bulkpoints.append({
                "opponent": data["pokeB"],
                "move": bk["fastMove"],
                "detail": detail,
                "confirmed": confirmed,
                "possible": possible,
            })

    return {
        "pokemon": results[0]["pokeA"] if results else "",
        "breakpoint_move": breakpoint_move,
        "breakpoints": breakpoints,
        "bulkpoints": bulkpoints,
        "analyzed": len(results),
    }


# -------------------------------------
# HTML rendering
# -------------------------------------

def render_entries(entries, empty_text):
    if not entries:
        return f'<div class="empty">{html.escape(empty_text)}</div>'

    rows = []

    for e in entries:
        move = (
            f'<span class="move">{html.escape(e["move"])}</span>'
            if e["move"]
            else ""
        )

        chips = "".join(
            f'<span class="chip on">{html.escape(s)}</span>'
            for s in e["confirmed"]
        ) + "".join(
            f'<span class="chip maybe">may flip {html.escape(s)}</span>'
            for s in e["possible"]
        )

        rows.append(
            '<div class="entry">'
            '<div class="entry-main">'
            f'<div class="opp">{html.escape(e["opponent"])}{move}</div>'
            f'<div class="detail">{html.escape(e["detail"])}</div>'
            "</div>"
            f'<div class="chips">{chips}</div>'
            "</div>"
        )

    return '<div class="entries">' + "".join(rows) + "</div>"


def render_section(title, subtitle, count, entries_html):
    return (
        '<div class="section">'
        '<div class="section-head">'
        f'<h2>{html.escape(title)}</h2>'
        f'<span class="count">{count}</span>'
        "</div>"
        f'<div class="section-sub">{html.escape(subtitle)}</div>'
        f"{entries_html}"
        "</div>"
    )
