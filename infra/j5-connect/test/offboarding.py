"""Exercise the Docker Compose test profile with generated OIDC state and PKCE."""

import base64
import hashlib
import json
import secrets
import subprocess
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

CALLBACK = "http://localhost/callback"
CLIENT = "j5-fixture"
SECRET = "fixture-j5-secret"


class LoginForm(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.action = None
        self.inputs = {}
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.action = attrs.get("action", "")
        if tag == "input" and "name" in attrs:
            self.inputs[attrs["name"]] = attrs.get("value", "")


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} exited with status {result.returncode}")
    return result.stdout.strip()


def test_offboarding(compose, directory):
    subprocess.run(
        [*compose, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "connect", "-d", "upstream"],
        input=Path(__file__).with_name("upstream-user.sql").read_text(),
        stdout=subprocess.DEVNULL,
        text=True,
        check=True,
    )
    issuer = run(*compose, "exec", "-T", "connect", "printenv", "J5_CONNECT_ISSUER")
    upstream = run(*compose, "exec", "-T", "connect", "printenv", "J5_CONNECT_UPSTREAM_ISSUER")
    ca = directory / "root.crt"
    ca.write_text(run(*compose, "exec", "-T", "connect", "cat", "/data/caddy/pki/authorities/local/root.crt") + "\n")
    cookies = directory / "cookies"
    body = directory / "body"

    def request(url, data=None, basic=None):
        if not url.startswith((issuer + "/", upstream + "/")):
            raise RuntimeError("Unexpected redirect outside the fixture")
        args = [
            "curl", "--silent", "--show-error", "--max-time", "15", "--noproxy", "*",
            "--cacert", str(ca), "--cookie", str(cookies), "--cookie-jar", str(cookies),
            "--output", str(body), "--write-out", "%{http_code}\n%{redirect_url}",
        ]
        if data is not None:
            args += ["--data", urlencode(data)]
        if basic:
            args += ["--user", basic]
        status, _, redirect = run(*args, url).partition("\n")
        return int(status), body.read_text(), redirect

    def token(grant_type, **fields):
        status, payload, _ = request(
            issuer + "/token", dict(fields, grant_type=grant_type), f"{CLIENT}:{SECRET}"
        )
        return status, json.loads(payload)

    status, payload, _ = request(issuer + "/.well-known/openid-configuration")
    assert status == 200 and json.loads(payload)["issuer"] == issuer, "Issuer discovery failed"
    print("OIDC discovery over Caddy TLS: HTTP 200, issuer matches")

    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    url = issuer + "/auth?" + urlencode(dict(
        client_id=CLIENT, redirect_uri=CALLBACK, response_type="code",
        scope="openid email profile offline_access", state=state, nonce=nonce,
        code_challenge=challenge, code_challenge_method="S256",
    ))
    for _ in range(12):
        status, html, redirect = request(url)
        if status == 200:
            form = LoginForm(html)
            fields = form.inputs
            if "password" in fields and url.startswith(upstream + "/"):
                fields.update(login="ada@example.test", password="fixture-password")
            elif "approval" in fields:
                fields["approval"] = "approve"
            else:
                raise RuntimeError(f"Unexpected form at {urlsplit(url).path}")
            status, _, redirect = request(urljoin(url, form.action), fields)
        assert redirect, f"Sign-in did not redirect (HTTP {status})"
        if redirect.startswith(CALLBACK + "?"):
            callback = parse_qs(urlsplit(redirect).query)
            assert callback.get("state") == [state] and "code" in callback, "Invalid OIDC callback"
            break
        url = redirect
    else:
        raise RuntimeError("Sign-in did not reach the callback")

    status, tokens = token(
        "authorization_code", code=callback["code"][0], redirect_uri=CALLBACK, code_verifier=verifier
    )
    assert status == 200 and tokens.get("id_token") and tokens.get("refresh_token"), "Code exchange failed"
    print("Upstream password sign-in and PKCE code exchange: HTTP 200 (tokens redacted)")

    status, refreshed = token("refresh_token", refresh_token=tokens["refresh_token"])
    assert status == 200 and refreshed.get("refresh_token"), "Initial refresh failed"
    assert refreshed["refresh_token"] != tokens["refresh_token"], "Refresh token did not rotate"
    print("Refresh with upstream account present: HTTP 200 (rotated token redacted)")

    deleted = run(
        *compose, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1",
        "-U", "connect", "-d", "upstream", "-c", "DELETE FROM password WHERE email = 'ada@example.test'",
    )
    assert deleted == "DELETE 1", "Fixture account was not deleted"
    print("Deleted one account from the upstream Dex password store")

    status, payload = token("refresh_token", refresh_token=refreshed["refresh_token"])
    assert status == 500 and payload == {"error": "invalid_request"}, "Unexpected offboarding response"
    print('Refresh after deletion: HTTP 500 {"error":"invalid_request"}')
    status, _, _ = request(upstream + "/.well-known/openid-configuration")
    assert status == 200, "Upstream stopped responding during offboarding"
    print("Upstream OIDC discovery after deletion: HTTP 200")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as directory:
        test_offboarding(sys.argv[1:], Path(directory))
