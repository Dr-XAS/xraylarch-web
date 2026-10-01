"""Exercise production proxy, independent visitors, example processing and export.

Usage: python3 deploy/digitalocean/smoke_test.py https://larch-web.dr-xas.org
Creates two anonymous test workspaces; never uses an existing browser session.
"""
import http.cookiejar
from http.cookies import SimpleCookie
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

base = sys.argv[1].rstrip("/")
is_https = urllib.parse.urlsplit(base).scheme == "https"


def visitor():
    cookies = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies)), cookies


def request(browser, path, data=None):
    body = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(base + path, data=body,
                                 headers={} if body is None else {"Content-Type": "application/json"})
    try:
        with browser.open(req, timeout=90) as response:
            result = response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        result = error.code, error.headers, error.read()
    if path.startswith("/api/backend/api/"):
        assert "no-store" in result[1].get("Cache-Control", "").lower(), f"Private API response cached: {path}"
    return result


alice, a_cookies = visitor()
bob, b_cookies = visitor()
for browser, cookies in [(alice, a_cookies), (bob, b_cookies)]:
    status, headers, body = request(browser, "/")
    assert status == 200, f"Page: HTTP {status}"
    assert b"Athena" in body
    assert any(cookie.name == "xraylarch_session" for cookie in cookies), "Missing page session cookie"
    response_cookies = SimpleCookie()
    for value in headers.get_all("Set-Cookie", []):
        response_cookies.load(value)
    assert "xraylarch_session" in response_cookies, "Missing page Set-Cookie header"
    session = response_cookies["xraylarch_session"]
    assert session["httponly"], "Session cookie must be HttpOnly"
    assert session["samesite"].lower() == "lax", "Session cookie must use SameSite=Lax"
    assert session["path"] == "/", "Session cookie must cover the application path"
    assert not session["domain"], "Session cookie must be restricted to this hostname"
    if is_https:
        assert session["secure"], "HTTPS session cookie must be Secure"
    assert "no-store" in headers.get("Cache-Control", ""), "Page must not cache private cookies"

api = "/api/backend/api/athena/projects"
status, _, body = request(alice, api, {})
assert status == 200
project = json.loads(body)
status, _, body = request(bob, api)
assert status == 200 and json.loads(body) == [], "Second visitor saw another visitor's project"
status, _, _ = request(bob, api + "/" + project["id"])
assert status == 404, "Second visitor accessed private project"
status, _, _ = request(bob, api + "/" + project["id"] + "/export?format=prj")
assert status == 404, "Second visitor exported private project"
status, _, _ = request(bob, api + "/" + project["id"] + "/command", {
    "version": project["version"], "action": "project", "group_ids": [],
    "options": {"name": "Unauthorized change"},
})
assert status == 404, "Second visitor modified private project"

status, _, body = request(alice, api + "/" + project["id"] + "/command", {
    "version": project["version"], "action": "example", "group_ids": [], "options": {},
})
assert status == 200, f"Example computation: HTTP {status}: {body[:200]!r}"
project = json.loads(body)
assert len(project["groups"]) == 4
assert [group["label"] for group in project["groups"]] == [
    "Cu foil · 10 K", "Cu foil · 50 K", "Cu foil · 300 K", "Cu₂O · room temperature",
]
assert [folder["name"] for folder in project["group_folders"]] == ["Temperature series", "reference"]
assert all(group["result"] for group in project["groups"]), "Example processing missing results"
status, headers, body = request(alice, api + "/" + project["id"] + "/export?format=prj")
assert status == 200 and body and headers.get("Content-Disposition"), "Project export failed"
artemis = "/api/backend/api/artemis"
status, _, body = request(alice, artemis + "/examples/cuprite")
assert status == 200, f"Missing Artemis Cuprite example: HTTP {status}: {body[:200]!r}"
example = json.loads(body)
assert example["amcsd_id"] == 15851 and len(example["paths"]) == 4, "Invalid Artemis Cuprite example"
seed = project["last_operation"]["artemis_example"]
assert seed["group_id"] == project["groups"][3]["id"], "Cuprite model targets the wrong example spectrum"
assert seed["example"]["cif_sha256"] == example["cif_sha256"], "Cuprite example provenance changed"
fit_request = {"version": project["version"], "parameters": example["parameters"],
               "transform": example["transform"], "paths": [
                   {"id": f"cuprite-{index}", "filename": path["filename"],
                    "content": path["content"], "label": f"Cuprite path {index}"}
                   for index, path in enumerate(example["paths"], 1)]}
fit_path = artemis + "/projects/" + project["id"] + "/groups/" + project["groups"][3]["id"] + "/fit"
status, _, _ = request(bob, fit_path, fit_request)
assert status == 404, "Second visitor fitted private project"
status, _, body = request(alice, fit_path, fit_request)
assert status == 200, f"Artemis fit: HTTP {status}: {body[:200]!r}"
fit = json.loads(body)
assert fit["success"] and fit["metadata"]["engine"] == "larch.feffit", "Artemis fit failed"
status, _, body = request(alice, artemis + "/structures?q=13088&limit=1")
assert status == 200 and json.loads(body)["count"] == 1, "AMCSD lookup failed"
status, _, body = request(alice, artemis + "/structures/13088")
assert status == 200 and json.loads(body)["supported"], "AMCSD structure unsupported"
structure = json.loads(body)
analysis_request = {"cif": structure["cif"], "absorber": "Cu", "site_index": 1}
status, _, body = request(alice, artemis + "/structures/first-shell", analysis_request)
assert status == 200, f"CrystalNN first shell: HTTP {status}: {body[:200]!r}"
assert json.loads(body)["coordination_number"] == 12, "Incorrect Cu first-shell coordination"
status, _, body = request(alice, artemis + "/structures/radial-shells", analysis_request)
assert status == 200, f"Radial shells: HTTP {status}: {body[:200]!r}"
assert [shell["coordination_number"] for shell in json.loads(body)["shells"][:3]] == [12, 6, 24], "Incorrect Cu radial shells"
attachments_path = artemis + "/projects/" + project["id"] + "/structures"
status, _, _ = request(bob, attachments_path)
assert status == 404, "Second visitor read private structures"
status, _, _ = request(bob, attachments_path, {"version": project["version"], "amcsd_id": 13088})
assert status == 404, "Second visitor attached a private structure"
status, _, body = request(alice, attachments_path, {"version": project["version"], "amcsd_id": 13088})
assert status == 200, f"Structure attachment: HTTP {status}: {body[:200]!r}"
project = json.loads(body)
status, _, _ = request(bob, artemis + "/feff/jobs", {
    "project_id": project["id"], "attachment_id": project["artemis_structures"][0]["id"],
    "version": project["version"], "absorber": "Cu", "site_index": structure["sites"][0]["index"],
})
assert status == 404, "Second visitor launched a FEFF job on private structure"

status, _, body = request(alice, "/api/backend/health")
assert status == 200 and json.loads(body)["status"] == "ok"
print("PASS: production page, session cookies, independent visitors, access isolation, four example spectra, project export, Artemis fit, CrystalNN first shell, radial shells, AMCSD structure/attachment, private FEFF access, health")
