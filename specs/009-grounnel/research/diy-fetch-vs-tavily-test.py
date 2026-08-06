"""
Research script backing D021 (docs/decisions/021-hybrid-search-diy-fetch-with-fallback.md).

Tests: for each claim, does Gemini's google_search tool (used for URL discovery only,
per D019 §3's disqualification of it for content/verdicts) + a plain DIY fetch+parse of
the cited URLs succeed often enough to make Tavily a fallback rather than the primary
SearchProvider? Only calls Tavily when DIY fails for a claim.

Run with GEMINI_API_KEY and TAVILY_API_KEY set in the environment (see .env).
This is the exact script that produced the batch-2 (obscure UCR/Hackel claims) results
in D021 — CLAIMS below is that batch. Batch 1 (5 famous claims: Eiffel Tower, Everest,
Great Wall, bananas, Bukowski) used the same functions with a different CLAIMS list;
its results are saved alongside this file as results-batch1-famous-claims.json.
"""

import json, os, time, requests
from bs4 import BeautifulSoup

GEMINI_KEY = os.environ["GEMINI_API_KEY"]
TAVILY_KEY = os.environ["TAVILY_API_KEY"]
MODEL = "gemini-2.5-flash-lite"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

CLAIMS = [
    ("Steven Hackel is a History Professor at UC Riverside.", True),
    ("Raymond Holguin serves as the Dean of UC Riverside's College of Humanities, Arts, and Social Sciences.", False),
    ("The Early California Population Project database documents more than 110,000 Californians between 1769 and 1850.", True),
    ("UC Riverside's Early California Population Project received a $1.2 million grant from the National Science Foundation.", False),
    ("The Early California Population Project draws on records from California's 21 missions.", True),
    ("The Early California Population Project database documents more than 250,000 Californians between 1769 and 1850.", False),
    ("Clifford Trafzer, a Distinguished Professor of History, is a collaborator on the Early California Population Project.", True),
    ("The Early California Population Project's expansion is funded through a Ford Foundation grant to add approximately 20,000 immigrant records.", False),
    ("UC Riverside's Early California Population Project received a $350,000 grant from the National Endowment for the Humanities.", True),
    ("Steven Hackel is a History Professor at UCLA.", False),
]

def gemini_search(claim):
    prompt = f'Use the google_search tool to search the web and check this claim: "{claim}"'
    body = {"contents": [{"parts": [{"text": prompt}]}], "tools": [{"google_search": {}}]}
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_KEY}"
    r = requests.post(url, json=body, timeout=30)
    r.raise_for_status()
    data = r.json()
    cand = data["candidates"][0]
    gm = cand.get("groundingMetadata", {})
    chunks = gm.get("groundingChunks", [])
    return [(c.get("web", {}).get("title"), c.get("web", {}).get("uri")) for c in chunks if c.get("web", {}).get("uri")]

def fetch_and_parse(url):
    try:
        r = requests.get(url, headers={"User-Agent": UA}, timeout=12, allow_redirects=True)
        final_url = r.url
        if r.status_code != 200:
            return final_url, r.status_code, 0, ""
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()
        text = soup.get_text(separator=" ", strip=True)
        return final_url, r.status_code, len(text), text
    except Exception as e:
        return url, f"ERR:{type(e).__name__}", 0, ""

def tavily_search(claim):
    r = requests.post(
        "https://api.tavily.com/search",
        headers={"Authorization": f"Bearer {TAVILY_KEY}", "Content-Type": "application/json"},
        json={"query": claim, "max_results": 2, "include_raw_content": True},
        timeout=20,
    )
    r.raise_for_status()
    data = r.json()
    return [(res["url"], len(res.get("raw_content") or res.get("content") or "")) for res in data.get("results", [])]

results = []
for claim, ground_truth in CLAIMS:
    row = {"claim": claim, "ground_truth": ground_truth}
    try:
        chunks = gemini_search(claim)
    except Exception as e:
        chunks = []
        row["gemini_error"] = str(e)
    row["num_chunks"] = len(chunks)

    RELEVANCE_TERMS = ["hackel", "early california population project", "ecpp", "neh"]
    diy_success = False
    diy_detail = []
    for title, redirect_url in chunks[:3]:
        final_url, status, textlen, fulltext = fetch_and_parse(redirect_url)
        relevant = any(t in fulltext.lower() for t in RELEVANCE_TERMS) if fulltext else False
        diy_detail.append({"title": title, "final_url": final_url, "status": status, "textlen": textlen, "relevant": relevant})
        if isinstance(status, int) and status == 200 and textlen > 800 and relevant:
            diy_success = True

    row["diy_success"] = diy_success
    row["diy_detail"] = diy_detail

    if not diy_success:
        try:
            tv = tavily_search(claim)
            row["fallback_used"] = "tavily"
            row["fallback_detail"] = tv
        except Exception as e:
            row["fallback_used"] = "tavily_failed"
            row["fallback_detail"] = str(e)
    else:
        row["fallback_used"] = "none"

    results.append(row)
    time.sleep(1)

print(json.dumps(results, indent=2))
