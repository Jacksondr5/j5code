import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def required(env, name):
    if not env.get(name):
        raise ValueError(f"{name} is required")
    return env[name]


def render_template(value, env):
    if isinstance(value, dict):
        return {key: render_template(item, env) for key, item in value.items()}
    if isinstance(value, list):
        return [render_template(item, env) for item in value]
    if isinstance(value, str) and value.startswith("$"):
        return required(env, value[1:])
    return value


def validate(config, provider, env):
    if env.get("DEX_SESSIONS_ENABLED") != "false" or "sessions" in config:
        raise ValueError("Dex sessions must be disabled")
    grants = config["oauth2"].get("grantTypes", [])
    if sorted(grants) != ["authorization_code", "refresh_token"]:
        raise ValueError("Dex must allow only authorization_code and refresh_token grants")
    refresh = config["expiry"]["refreshTokens"]
    if refresh.get("reuseInterval") != "0s" or refresh.get("disableRotation", False):
        raise ValueError("Dex refresh must rotate tokens with zero reuse interval")

    connector, = config["connectors"]
    if connector["type"] != provider:
        raise ValueError("Dex connector type must match J5_CONNECT_PROVIDER")
    scopes = connector["config"].get("scopes", [])
    if provider == "oidc" and "offline_access" not in scopes:
        raise ValueError("OIDC requires the upstream offline_access scope")


def render_config(env):
    issuer = required(env, "J5_CONNECT_ISSUER")
    if not re.fullmatch(r"https://[a-zA-Z0-9.-]+(?::[0-9]+)?", issuer):
        raise ValueError("J5_CONNECT_ISSUER must be an HTTPS origin without a trailing slash")
    provider = env.get("J5_CONNECT_PROVIDER", "oidc")
    if provider not in ("oidc", "github", "google"):
        raise ValueError("J5_CONNECT_PROVIDER must be oidc, github or google")
    try:
        clients = json.loads(required(env, "J5_CONNECT_CLIENTS"))
    except json.JSONDecodeError:
        raise ValueError("J5_CONNECT_CLIENTS must be valid JSON") from None
    if not isinstance(clients, list) or not clients:
        raise ValueError("J5_CONNECT_CLIENTS requires at least one registered client")
    ids = set()
    for client in clients:
        if not isinstance(client, dict) or not all(
            isinstance(client.get(key), str) and client[key] for key in ("id", "name", "secret")
        ):
            raise ValueError("Each J5 client requires a nonempty id, name and secret")
        if set(client) - {"id", "name", "secret", "redirectURIs"}:
            raise ValueError("J5 clients may only set id, name, secret and redirectURIs")
        if client["secret"] == "replace-with-a-random-secret":
            raise ValueError("Replace the example J5 client secret with a generated secret")
        redirects = client.get("redirectURIs")
        if not isinstance(redirects, list) or not redirects or not all(
            isinstance(uri, str) and uri for uri in redirects
        ):
            raise ValueError("Each J5 client requires at least one explicit redirect URI")
        if client["id"] in ids:
            raise ValueError("Each J5 client must have a unique id")
        ids.add(client["id"])

    values = dict(env, J5_CONNECT_CALLBACK=issuer + "/callback")
    config = render_template(json.loads((ROOT / "dex.json").read_text()), values)
    connector = json.loads((ROOT / "connectors" / f"{provider}.json").read_text())
    connector = render_template(connector, values)
    if provider == "oidc":
        upstream = connector["config"]["issuer"]
        parsed = urlsplit(upstream)
        fixture = env.get("J5_CONNECT_TEST_PROFILE") == "true" and re.fullmatch(
            r"http://upstream\.localhost:[0-9]+", upstream
        )
        if not fixture and (parsed.scheme != "https" or not parsed.hostname):
            raise ValueError("J5_CONNECT_UPSTREAM_ISSUER must use HTTPS")
        connector["id"] = "oidc-" + hashlib.sha256(upstream.encode()).hexdigest()
        if env.get("J5_CONNECT_OIDC_SCOPES"):
            connector["config"]["scopes"] = env["J5_CONNECT_OIDC_SCOPES"].split()
    config["connectors"] = [connector]
    config["staticClients"] = clients
    validate(config, provider, env)
    return config


def run_processes(commands):
    processes = []

    def stop(_signal, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for command, env in commands:
            processes.append(subprocess.Popen(command, env=env))
        pid, status = os.wait()
        exited = next(process for process in processes if process.pid == pid)
        exited.returncode = os.waitstatus_to_exitcode(status)
        raise SystemExit(f"{exited.args[0]} exited ({exited.returncode})")
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            process.wait()


def main():
    try:
        config = render_config(os.environ)
    except (ValueError, KeyError) as error:
        raise SystemExit(f"Invalid J5 Connect config: {error}") from None
    caddy_env = {
        "J5_CONNECT_HOST": urlsplit(config["issuer"]).hostname,
        "XDG_DATA_HOME": os.environ["XDG_DATA_HOME"],
        "XDG_CONFIG_HOME": os.environ["XDG_CONFIG_HOME"],
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as dex_config:
        json.dump(config, dex_config)
        dex_config.flush()
        run_processes(
            [
                (["dex", "serve", dex_config.name], os.environ),
                (["/usr/bin/caddy", "run", "--config", str(ROOT / "Caddyfile")], caddy_env),
            ],
        )


if __name__ == "__main__":
    main()
