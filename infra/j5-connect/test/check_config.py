import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from connect import main, render_config, validate

ENV = {
    "J5_CONNECT_ISSUER": "https://connect.example.test",
    "J5_CONNECT_UPSTREAM_ISSUER": "https://identity.example.test",
    "J5_CONNECT_UPSTREAM_CLIENT_ID": "fixture",
    "J5_CONNECT_UPSTREAM_CLIENT_SECRET": "fixture-$-upstream",
    "POSTGRES_PASSWORD": "fixture-$-database",
    "J5_CONNECT_CLIENTS": '[{"id":"client","name":"J5","secret":"fixture-$-client",'
    '"redirectURIs":["https://server.example.test/callback"]}]',
    "DEX_SESSIONS_ENABLED": "false",
}


class ConfigTest(unittest.TestCase):
    def test_templates_render(self):
        for provider in ("oidc", "google", "github"):
            with self.subTest(provider=provider):
                config = render_config(dict(ENV, J5_CONNECT_PROVIDER=provider))
                connector, = config["connectors"]
                self.assertEqual(connector["config"]["redirectURI"], ENV["J5_CONNECT_ISSUER"] + "/callback")
                self.assertEqual(connector["config"]["clientSecret"], ENV["J5_CONNECT_UPSTREAM_CLIENT_SECRET"])
                self.assertEqual(config["storage"]["config"]["password"], ENV["POSTGRES_PASSWORD"])
                self.assertEqual(config["staticClients"][0]["secret"], "fixture-$-client")

    def test_oidc_issuer_namespaces_subjects(self):
        first = render_config(ENV)["connectors"][0]["id"]
        self.assertEqual(first, render_config(ENV)["connectors"][0]["id"])
        other = render_config(dict(ENV, J5_CONNECT_UPSTREAM_ISSUER="https://other.example.test"))
        self.assertNotEqual(first, other["connectors"][0]["id"])

    def test_plaintext_upstream_requires_isolated_fixture(self):
        env = dict(ENV, J5_CONNECT_UPSTREAM_ISSUER="http://upstream.localhost:5557")
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            render_config(env)
        env["J5_CONNECT_TEST_PROFILE"] = "true"
        render_config(env)
        env["J5_CONNECT_UPSTREAM_ISSUER"] = "http://identity.example.test"
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            render_config(env)

    def test_rejects_extra_grants(self):
        config = render_config(ENV)
        config["oauth2"]["grantTypes"].append("urn:ietf:params:oauth:grant-type:token-exchange")
        with self.assertRaisesRegex(ValueError, "only authorization_code and refresh_token"):
            validate(config, "oidc", ENV)

    def test_rejects_unsupported_client_fields_and_example_secret(self):
        client, = json.loads(ENV["J5_CONNECT_CLIENTS"])
        for overrides, error in (
            ({"trustedPeers": ["another-client"]}, "may only set"),
            ({"secret": "replace-with-a-random-secret"}, "Replace the example"),
        ):
            with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, error):
                render_config(dict(ENV, J5_CONNECT_CLIENTS=json.dumps([dict(client, **overrides)])))

    def test_caddy_environment_excludes_credentials(self):
        paths = {"XDG_DATA_HOME": "/data", "XDG_CONFIG_HOME": "/config"}
        with patch.dict(os.environ, dict(ENV, **paths)), patch("connect.run_processes") as run:
            main()
        commands, = run.call_args.args
        _, caddy_env = commands[1]
        self.assertEqual(caddy_env, dict(paths, J5_CONNECT_HOST="connect.example.test"))

    def test_rejects_sessions(self):
        with self.assertRaisesRegex(ValueError, "sessions must be disabled"):
            render_config(dict(ENV, DEX_SESSIONS_ENABLED="true"))

    def test_rejects_nonzero_reuse_interval(self):
        config = render_config(ENV)
        config["expiry"]["refreshTokens"]["reuseInterval"] = "5s"
        with self.assertRaisesRegex(ValueError, "zero reuse interval"):
            validate(config, "oidc", ENV)

    def test_rejects_missing_oidc_offline_scope(self):
        with self.assertRaisesRegex(ValueError, "requires the upstream offline_access"):
            render_config(dict(ENV, J5_CONNECT_OIDC_SCOPES="profile email"))


if __name__ == "__main__":
    unittest.main()
