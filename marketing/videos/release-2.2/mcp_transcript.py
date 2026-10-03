#!/usr/bin/env python3
"""
Drive the capture instance's real MCP endpoint and save the REAL exchange for the scenes to render.

⚠️ EVERY NUMBER AND NAME ON SCREEN COMES FROM THIS FILE. The scenes restyle the transcript, they do
not author it: a hook that shows an invented answer is a lie that happens to look like a demo. The
question text is the prompt a person would type; the tool calls and the returned data are the
instance's own.
"""
import json, os, urllib.request, urllib.error

BASE = "http://localhost:3011/mcp"
HERE = os.path.dirname(os.path.abspath(__file__))
TOK  = open(os.path.join(HERE, ".apitoken")).read().strip()
_id  = [0]

def rpc(method, params=None):
    _id[0] += 1
    body = {"jsonrpc": "2.0", "id": _id[0], "method": method}
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(BASE, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"httpError": e.code, "body": e.read().decode()[:400]}

def tool(name, args=None):
    r = rpc("tools/call", {"name": name, "arguments": args or {}})
    out = {"tool": name, "arguments": args or {}, "raw": r}
    res = r.get("result") or {}
    out["isError"] = bool(res.get("isError"))
    texts = [c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"]
    out["text"] = "\n".join(texts)
    return out

T = {"init": rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "video-capture", "version": "1"}})}
T["tools_full"] = [t["name"] for t in rpc("tools/list")["result"]["tools"]]
T["calls"] = []

# Scene 01 — the hook. One question, one tool, a real answer.
T["calls"].append({"q": "Which of my screens are offline?", "steps": [tool("fleet_status")]})

# Scene 05 — asking for WORK. The real four-step a model makes to change what a screen shows.
content = tool("list_content")
T["calls"].append({"q": "Put the autumn campaign on the lobby screen.", "steps": [
    tool("list_displays"),
    content,
    tool("create_playlist", {"name": "Autumn Campaign"}),
]})

# Scene 05b — a report question, which is what found the date-range bug.
T["calls"].append({"q": "How much uptime did each screen have this week?",
                   "steps": [tool("uptime_report", {"days": 7})]})

with open(os.path.join(HERE, "transcript.json"), "w") as f:
    json.dump(T, f, indent=2)

print(f"tools (full token): {len(T['tools_full'])}")
for c in T["calls"]:
    print(f"\nQ: {c['q']}")
    for s in c["steps"]:
        flag = "ERROR" if s["isError"] else "ok"
        print(f"  [{flag}] {s['tool']}({json.dumps(s['arguments'])})")
        print("      " + (s["text"][:300].replace("\n", "\n      ") if s["text"] else "(no text)"))
