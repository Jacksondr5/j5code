import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { J5_RELEASE_METADATA_FILE } from "@t3tools/shared/j5/databaseMigrations";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as NpmRelease from "../../cloud/npmRelease.ts";

const ReleaseIndex = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.optional(Schema.Boolean) }),
);
const ReleaseMetadata = Schema.Struct({
  databaseMigration: Schema.Int,
  j5DatabaseMigrations: Schema.Record(Schema.String, Schema.Int),
});
const decodeIndex = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseIndex));
const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(ReleaseMetadata));
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

const REQUEST_TIMEOUT = Duration.seconds(15);
const INDEX_MAX_PAGES = 10;

/** Upstream's `NpmRelease` answered from J5's GitHub releases: J5 never publishes `t3` to npm.
 * A release without J5's metadata file predates database checks, so it carries no migrations. */
export const make = Effect.fn("J5ReleaseLookup.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const environment = yield* HostProcess.Environment;
  const token = environment.GH_TOKEN?.trim() || environment.GITHUB_TOKEN?.trim() || undefined;
  const unreachable = new ServerNpmReleaseError({ reason: "GitHub could not be reached." });

  /** The body, or none for a 404. */
  const fetchText = Effect.fn("J5ReleaseLookup.fetch")(function* (url: string, api: boolean) {
    const request = api
      ? HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader("Accept", "application/vnd.github+json"),
          token === undefined
            ? (request) => request
            : HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
        )
      : HttpClientRequest.get(url);
    // The timeout covers the body too: GitHub can send headers and then stall.
    return yield* Effect.gen(function* () {
      const response = yield* http.execute(request).pipe(Effect.mapError(() => unreachable));
      if (response.status === 404) return Option.none<string>();
      if (response.status < 200 || response.status >= 300) {
        return yield* new ServerNpmReleaseError({ reason: `GitHub answered ${response.status}.` });
      }
      return Option.some(yield* response.text.pipe(Effect.mapError(() => unreachable)));
    }).pipe(
      Effect.timeoutOrElse({ duration: REQUEST_TIMEOUT, orElse: () => Effect.fail(unreachable) }),
    );
  });

  const newestVersion = Effect.fn("J5ReleaseLookup.newestVersion")(function* (
    channel: "stable" | "nightly",
  ) {
    for (let page = 1; page <= INDEX_MAX_PAGES; page += 1) {
      const body = yield* fetchText(cliReleaseIndexPageUrl(page), true);
      if (Option.isNone(body)) return undefined;
      const releases = Option.getOrUndefined(decodeIndex(body.value));
      if (releases === undefined) {
        return yield* new ServerNpmReleaseError({ reason: "The release index was invalid." });
      }
      const version = newestCliReleaseVersion(releases, channel);
      if (version !== undefined || releases.length === 0) return version;
    }
    return undefined;
  });

  const lookup = Effect.fn("J5ReleaseLookup.lookup")(function* (spec: string) {
    const version =
      spec === "latest" || spec === "nightly"
        ? yield* newestVersion(spec === "latest" ? "stable" : "nightly")
        : // Every published release carries its checksums.
          Option.isSome(
              yield* fetchText(cliReleaseAssetUrl(spec, CLI_RELEASE_CHECKSUMS_FILE), false),
            )
          ? spec
          : undefined;
    if (version === undefined) return null;
    const metadata = yield* fetchText(cliReleaseAssetUrl(version, J5_RELEASE_METADATA_FILE), false);
    if (Option.isNone(metadata)) return { version } satisfies ServerNpmRelease;
    const decoded = Option.getOrUndefined(decodeMetadata(metadata.value));
    if (decoded === undefined) {
      return yield* new ServerNpmReleaseError({
        reason: `${version}'s ${J5_RELEASE_METADATA_FILE} was invalid.`,
      });
    }
    return { version, ...decoded } satisfies ServerNpmRelease;
  });

  const cache = yield* Cache.make({ capacity: 32, timeToLive: Duration.minutes(1), lookup });
  return NpmRelease.NpmRelease.of({
    get: Effect.fn("J5ReleaseLookup.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease.NpmRelease, make()).pipe(
  Layer.provide(FetchHttpClient.layer),
);
