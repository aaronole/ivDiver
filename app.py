import html
import os
import threading
import time

import streamlit as st

import ivdiver_core as core

APP_DIR = os.path.dirname(os.path.abspath(__file__))

# Results are cached per Pokemon for this long, then re-run from fresh
# PvPoke data. (Short enough to pick up updates, long enough to be instant
# for repeat lookups.)
CACHE_TTL_SECONDS = 6 * 60 * 60

st.set_page_config(
    page_title="IV Deep Diver",
    page_icon="◆",
    layout="centered",
)

with open(os.path.join(APP_DIR, "style.css"), encoding="utf-8") as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)


# -------------------------------------
# Shared state / caching
# -------------------------------------

@st.cache_resource
def get_store():
    # One analysis at a time (each runs a Node process), plus a results cache
    return {"lock": threading.Lock(), "cache": {}}


@st.cache_data(ttl=3600, show_spinner=False)
def load_options():
    return core.fetch_pokemon_options()


def fresh_entry(species_id):
    entry = get_store()["cache"].get(species_id)

    if entry and time.time() - entry["ts"] < CACHE_TTL_SECONDS:
        return entry

    return None


def get_results(species_id, force=False):
    store = get_store()

    if not force:
        entry = fresh_entry(species_id)
        if entry:
            return entry

    notice = st.empty()
    lock = store["lock"]

    if not lock.acquire(blocking=False):
        notice.info(
            "Another analysis is running. Yours will start as soon as it finishes."
        )
        lock.acquire()

    notice.empty()

    try:
        # Someone else may have just analyzed this Pokemon while we waited
        if not force:
            entry = fresh_entry(species_id)
            if entry:
                return entry

        bar = st.progress(0.0, text="Downloading the latest PvPoke data…")

        def on_progress(done, total):
            bar.progress(
                min(done / total, 1.0),
                text=f"Analyzing matchups… {done:,} of {total:,}",
            )

        results, failures = core.run_analysis(species_id, on_progress)
        bar.empty()

        entry = {
            "ts": time.time(),
            "results": results,
            "failures": failures,
        }
        store["cache"][species_id] = entry

        return entry

    finally:
        lock.release()


# -------------------------------------
# Header
# -------------------------------------

st.markdown(
    '<h1 class="app-title">IV Deep Diver</h1>'
    '<p class="app-sub">Pick a Pokémon to see every breakpoint and bulkpoint '
    "that matters against the full Great League meta, using live PvPoke "
    "rankings and its battle simulator.</p>",
    unsafe_allow_html=True,
)

try:
    options = load_options()
except core.AnalysisError as err:
    st.error(str(err))
    st.stop()

names = dict(options)

species_id = st.selectbox(
    "Pokémon",
    options=[sid for sid, _ in options],
    format_func=lambda sid: names[sid],
    index=None,
    placeholder="Start typing a Pokémon name…",
    label_visibility="collapsed",
)


# -------------------------------------
# Results
# -------------------------------------

if species_id:
    force = st.session_state.pop("force_refresh", False)

    try:
        entry = get_results(species_id, force=force)
    except core.AnalysisError as err:
        st.error(str(err))
        st.stop()

    report = core.build_report(entry["results"])

    age_min = int((time.time() - entry["ts"]) / 60)
    age = "just now" if age_min < 1 else f"{age_min} min ago"

    st.markdown(
        '<div class="result-head">'
        f'<h2 class="result-name">{html.escape(report["pokemon"])}</h2>'
        f'<div class="result-meta">Analyzed against {report["analyzed"]:,} '
        f"Pokémon · live PvPoke data, {age}</div>"
        '<div class="stats">'
        f'<div class="stat"><div class="stat-num">{len(report["breakpoints"])}</div>'
        '<div class="stat-label">Breakpoints</div></div>'
        f'<div class="stat"><div class="stat-num">{len(report["bulkpoints"])}</div>'
        '<div class="stat-label">Bulkpoints</div></div>'
        "</div></div>",
        unsafe_allow_html=True,
    )

    query = st.text_input(
        "Filter",
        placeholder="Filter by opponent…",
        label_visibility="collapsed",
    ).strip().lower()

    def visible(entries):
        if not query:
            return entries
        return [e for e in entries if query in e["opponent"].lower()]

    bps = visible(report["breakpoints"])
    bks = visible(report["bulkpoints"])

    bp_title = (
        f'{report["breakpoint_move"]} Breakpoints'
        if report["breakpoint_move"]
        else "Breakpoints"
    )

    st.markdown(
        core.render_section(
            bp_title,
            "Attack needed for your Fast Move to deal 1 more damage.",
            len(bps),
            core.render_entries(bps, "None" if not query else "No matches"),
        )
        + core.render_section(
            "Bulkpoints",
            "Defense needed for the opponent's Fast Move to deal 1 less damage.",
            len(bks),
            core.render_entries(bks, "None" if not query else "No matches"),
        )
        + '<div class="legend">'
        '<span class="chip on">1s</span> flips in that shield scenario'
        '<span class="chip maybe" style="margin-left:0.8rem">may flip 1s</span> '
        "might flip, depending on the matchup"
        "</div>",
        unsafe_allow_html=True,
    )

    if entry["failures"]:
        st.caption(
            f'{len(entry["failures"])} Pokémon couldn\'t be analyzed and were skipped.'
        )

    if st.button("Re-run with the latest data"):
        st.session_state["force_refresh"] = True
        st.rerun()
