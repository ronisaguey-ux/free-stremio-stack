#!/usr/bin/env python3
"""Ensure the Stremio account addon collection stays valid and non-null.

Repairs two recurring failure modes:
1. Addons carrying `"manifest": null` (which crashes Stremio Android/Fire TV
   sync with `AddonsPulledFromApi: Serialization error: ... expected struct Manifest`).
2. Rotating or LAN-IP AIOStream transport URLs replaced with the stable HTTPS URL.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

API = "https://api.strem.io/api/"
DEFAULT_KEY_FILE = os.path.expanduser("~/.local/state/stremio-auth.key")
DEFAULT_BACKUP = os.path.expanduser("~/.local/state/stremio-collection-backup.json")
LOCAL_FALLBACKS = [
    "http://127.0.0.1:11470/local-addon/manifest.json",
    "http://192.168.86.37:11470/local-addon/manifest.json",
]


def post(method, body):
    req = urllib.request.Request(
        API + method,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "aiostrem-guard/1.0"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def fetch_manifest(url, stable_url):
    cands = []
    if "127.0.0.1:11470/local-addon/manifest.json" in url:
        cands.extend(LOCAL_FALLBACKS)
    if url == stable_url:
        cands.extend(["http://127.0.0.1:3819/manifest.json", stable_url])
    else:
        cands.append(url)
    for cand in cands:
        try:
            with urllib.request.urlopen(cand, timeout=10) as r:
                m = json.load(r)
            if isinstance(m, dict) and m.get("id") and m.get("name"):
                return m
        except Exception:
            continue
    return None


def is_aiostrem_entry(entry):
    m = entry.get("manifest") or {}
    u = entry.get("transportUrl", "")
    return (
        m.get("id") == "org.aiostre.am"
        or "trycloudflare.com/manifest.json" in u
        or ":3819/manifest.json" in u
        or "stremio.helpotron.dpdns.org/manifest.json" in u
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-file", default=os.environ.get("STREMIO_AUTH_KEY_FILE", DEFAULT_KEY_FILE))
    ap.add_argument("--stable-url", default=os.environ.get("AIOSTREM_PUBLIC_MANIFEST", "https://stremio.helpotron.dpdns.org/manifest.json"))
    ap.add_argument("--backup-file", default=DEFAULT_BACKUP)
    args = ap.parse_args()

    key = os.environ.get("STREMIO_AUTH_KEY", "").strip()
    if not key and os.path.exists(args.key_file):
        key = open(args.key_file, "r", encoding="utf-8").read().strip()
    if not key:
        print("guard skipped: no authKey file configured", file=sys.stderr)
        return 0

    got = post("addonCollectionGet", {"type": "AddonCollectionGet", "authKey": key, "update": True})
    addons = (got.get("result") or {}).get("addons")
    if not isinstance(addons, list):
        print(f"guard error: unexpected addonCollectionGet response", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(args.backup_file), exist_ok=True)
    if not os.path.exists(args.backup_file):
        with open(args.backup_file, "w", encoding="utf-8") as fh:
            json.dump(got, fh, indent=2)

    changed = False
    seen_urls = set()
    cleaned = []

    for a in addons:
        url = a.get("transportUrl", "")
        manifest = a.get("manifest")
        if is_aiostrem_entry(a):
            if url != args.stable_url:
                url = args.stable_url
                changed = True
            if url in seen_urls:
                changed = True
                continue
            if not isinstance(manifest, dict) or not manifest.get("id"):
                manifest = fetch_manifest(url, args.stable_url)
                changed = True
        elif not isinstance(manifest, dict) or not manifest.get("id"):
            manifest = fetch_manifest(url, args.stable_url)
            changed = True

        if not isinstance(manifest, dict) or not manifest.get("id"):
            print(f"guard warn: skipping unreachable manifest for {url}", file=sys.stderr)
            changed = True
            continue

        if url in seen_urls:
            changed = True
            continue
        seen_urls.add(url)
        cleaned.append({
            "transportUrl": url,
            "transportName": a.get("transportName", ""),
            "manifest": manifest,
            "flags": a.get("flags", {"official": False, "protected": False}),
        })

    if args.stable_url not in seen_urls:
        m = fetch_manifest(args.stable_url, args.stable_url)
        if m:
            cleaned.append({
                "transportUrl": args.stable_url,
                "transportName": "",
                "manifest": m,
                "flags": {"official": False, "protected": False},
            })
            changed = True

    # Order AIOStream immediately before WatchHub so TV default Play uses AIOStream.
    ai_idx = next((i for i, a in enumerate(cleaned) if a["transportUrl"] == args.stable_url), None)
    wh_idx = next((i for i, a in enumerate(cleaned) if "watchhub.strem.io" in a["transportUrl"]), None)
    if ai_idx is not None and wh_idx is not None and ai_idx > wh_idx:
        entry = cleaned.pop(ai_idx)
        cleaned.insert(wh_idx, entry)
        changed = True

    if not changed:
        return 0

    ts_backup = f"{args.backup_file}.{int(time.time())}"
    with open(ts_backup, "w", encoding="utf-8") as fh:
        json.dump(got, fh, indent=2)

    res = post("addonCollectionSet", {"type": "AddonCollectionSet", "authKey": key, "addons": cleaned})
    if not (res.get("result") or {}).get("success"):
        print(f"guard error: addonCollectionSet failed: {json.dumps(res)[:160]}", file=sys.stderr)
        return 1

    verify = post("addonCollectionGet", {"type": "AddonCollectionGet", "authKey": key, "update": True})
    after = (verify.get("result") or {}).get("addons", [])
    nulls = [a.get("transportUrl") for a in after if not isinstance(a.get("manifest"), dict)]
    print(f"guard repaired collection: addons={len(after)} nulls={len(nulls)} backup={ts_backup}")
    return 0 if not nulls else 2


if __name__ == "__main__":
    sys.exit(main())
