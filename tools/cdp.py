#!/usr/bin/env python3
"""One action per invocation against a headed Chrome over CDP.

Why this exists: Playwright's text/role locators time out against Stremio's web
UI (React divs, no roles, text on nested nodes), and the browse extension is
often paired-offline. This drives the same browser one verified step at a time.

Start the browser first:

    setsid nohup /opt/google/chrome/chrome --no-sandbox \
      --remote-debugging-port=9334 --remote-allow-origins=* \
      --user-data-dir=/tmp/stremio-headed2 --no-first-run \
      --no-default-browser-check --window-size=1600,950 about:blank \
      >/tmp/chrome-headed2.log 2>&1 </dev/null &

--remote-allow-origins=* is required: without it the CDP websocket upgrade is
rejected with "403 Forbidden ... rejected an incoming WebSocket connection".

Usage:
    uv run --with websocket-client python cdp.py nav https://web.stremio.com/#/addons
    uv run --with websocket-client python cdp.py snap
    uv run --with websocket-client python cdp.py click "Add addon"
    uv run --with websocket-client python cdp.py type "input[placeholder='Paste addon URL']" "https://..."
    uv run --with websocket-client python cdp.py key Enter
    uv run --with websocket-client python cdp.py js "location.hash='#/settings'"
    uv run --with websocket-client python cdp.py shot /tmp/shot.png

Set CDP_PORT to override 9334.
"""

import base64
import json
import os
import sys
import urllib.request

from websocket import create_connection

PORT = int(os.environ.get("CDP_PORT", "9334"))


def page():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json") as fh:
        targets = json.load(fh)
    for target in targets:
        if target.get("type") == "page":
            return target
    raise SystemExit("no page target — is Chrome running with --remote-debugging-port?")


def _call(method, params, timeout=60):
    ws = create_connection(page()["webSocketDebuggerUrl"], timeout=timeout)
    try:
        ws.send(json.dumps({"id": 1, "method": method, "params": params}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == 1:
                return msg.get("result", {})
    finally:
        ws.close()


def evaluate(expr):
    result = _call(
        "Runtime.evaluate",
        {"expression": expr, "awaitPromise": True, "returnByValue": True},
    )
    if result.get("exceptionDetails"):
        return "ERR " + json.dumps(result["exceptionDetails"])[:400]
    return result.get("result", {}).get("value")


# getClientRects().length, not offsetParent: children of a position:fixed modal
# report offsetParent === null while being perfectly visible.
LOCATE = """
(() => {
  const want = %r.toLowerCase();
  const nodes = [...document.querySelectorAll('div,button,a,span')]
    .filter(e => e.getClientRects().length && (e.innerText || '').trim().toLowerCase() === want);
  if (!nodes.length) return 'MISS';
  const node = nodes[%d] || nodes[0];
  const r = node.getBoundingClientRect();
  return Math.round(r.x + r.width / 2) + ',' + Math.round(r.y + r.height / 2);
})()
"""


def mouse(x, y):
    for method, extra in (
        ("mouseMoved", {}),
        ("mousePressed", {"button": "left", "clickCount": 1}),
        ("mouseReleased", {"button": "left", "clickCount": 1}),
    ):
        params = {"type": method, "x": x, "y": y}
        params.update(extra)
        _call("Input.dispatchMouseEvent", params)
    return f"clicked {x},{y}"


def click_text(text, nth=0):
    target = evaluate(LOCATE % (text, nth))
    print("target:", target)
    if isinstance(target, str) and "," in target and target != "MISS":
        print(mouse(*[int(float(v)) for v in target.split(",")]))


def type_into(selector, text):
    # Input.insertText fires a real input event, which React does observe.
    print(evaluate("(() => { const i = document.querySelector(%r);"
                   "if (!i) return 'MISS'; i.focus(); return 'focused'; })()" % selector))
    _call("Input.insertText", {"text": text})
    print("typed", len(text))


def key(code):
    table = {"Enter": (13, "Enter"), "Tab": (9, "Tab"), "Escape": (27, "Escape")}
    vk, name = table.get(code, (0, code))
    for kind in ("keyDown", "char", "keyUp"):
        params = {
            "type": kind,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
            "key": name,
            "text": {"Enter": "\r", "Escape": "\x1b"}.get(code, ""),
        }
        if kind == "keyUp":
            params.pop("text")
        _call("Input.dispatchKeyEvent", params)
    print("key", code)


def shot(path):
    result = _call("Page.captureScreenshot", {"format": "png"}, timeout=90)
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(result["data"]))
    print("saved", path)


def main():
    cmd = sys.argv[1]
    if cmd == "nav":
        _call("Page.navigate", {"url": sys.argv[2]})
        print("nav ok")
    elif cmd == "js":
        print(evaluate(sys.argv[2]))
    elif cmd == "snap":
        print(evaluate("document.body ? document.body.innerText.slice(0, 1500) : 'no body'"))
    elif cmd == "url":
        print(evaluate("location.href"))
    elif cmd == "click":
        click_text(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 0)
    elif cmd == "type":
        type_into(sys.argv[2], sys.argv[3])
    elif cmd == "key":
        key(sys.argv[2])
    elif cmd == "shot":
        shot(sys.argv[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
