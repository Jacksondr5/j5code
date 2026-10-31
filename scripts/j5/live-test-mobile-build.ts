// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - part of the standalone live-test CLI.
/**
 * `setup-agent-live-test.ts mobile-build ios|android`: builds the dev client for this checkout's
 * native fingerprint into `mobile:install`'s cache, where `mobile-open` installs it from. Android
 * builds here. iOS builds in a checkout of this commit on the iOS host, which this command keeps.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import {
  IOS_SSH_HOST,
  androidSdk,
  assertIosHostOnline,
  cachedClientPath,
  iosHostSucceeds,
  nativeFingerprint,
  type MobilePlatform,
} from "./live-test-mobile.ts";
import {
  LiveTestRefusal,
  liveTestEnvironment,
  type LiveTestPaths,
} from "./setup-agent-live-test.ts";

/** On the iOS host, relative to its home. Kept between builds, so each build installs and fetches only what changed. */
const IOS_RIG_DIRECTORY = "j5-mobile-rig";
const IOS_CHECKOUT = `${IOS_RIG_DIRECTORY}/checkout`;
const IOS_BUILD_LOCK = `${IOS_RIG_DIRECTORY}/build.lock`;
const UPSTREAM_CLONE_URL = "https://github.com/Jacksondr5/j5code.git";
/** The exit code the remote script uses when another build holds the lock. */
const LOCKED_EXIT = 75;

export function parseMobileBuild(args: ReadonlyArray<string>): MobilePlatform {
  const [platform, ...rest] = args;
  if (rest.length > 0 || (platform !== "ios" && platform !== "android")) {
    throw new LiveTestRefusal(
      "Usage: node scripts/j5/setup-agent-live-test.ts mobile-build ios|android",
    );
  }
  return platform;
}

/**
 * The script the iOS host runs, from stdin: take the build lock (refusing if another build holds
 * it), check out `commit`, install, and build into the cache. The lock goes when the script ends.
 */
export function iosBuildScript(input: { readonly commit: string; readonly owner: string }): string {
  return `set -e
cd "$HOME"
mkdir -p ${IOS_RIG_DIRECTORY}
if ! mkdir ${IOS_BUILD_LOCK} 2>/dev/null; then
  echo "Another iOS build is running on this host: $(cat ${IOS_BUILD_LOCK}/owner 2>/dev/null)" >&2
  echo "Wait for it. If none is running, remove ~/${IOS_BUILD_LOCK} on the iOS host." >&2
  exit ${LOCKED_EXIT}
fi
trap 'rm -rf "$HOME/${IOS_BUILD_LOCK}"' EXIT
# A trap that only cleaned up would let the shell go on to the next step without the lock.
trap 'exit 1' HUP INT TERM
printf '%s since %s\\n' ${shellWord(input.owner)} "$(date)" > ${IOS_BUILD_LOCK}/owner
cd ${IOS_CHECKOUT}
git checkout -q -f --detach ${input.commit}
. "$HOME/.config/vite-plus/env"
vp i
node scripts/mobile-native-client.ts ensure ios --prepare
`;
}

const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Makes the iOS host's checkout hold `commit`: cloned once from GitHub, then pushed to, so an unpushed commit works too. */
function syncIosCheckout(paths: LiveTestPaths, commit: string): void {
  if (!iosHostSucceeds(`test -d ${IOS_CHECKOUT}/.git`)) {
    console.log(`Cloning J5 Code into ~/${IOS_CHECKOUT} on the iOS host (once)...`);
    const clone = NodeChildProcess.spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        IOS_SSH_HOST,
        `mkdir -p ${IOS_RIG_DIRECTORY} && git clone -q ${UPSTREAM_CLONE_URL} ${IOS_CHECKOUT}`,
      ],
      { stdio: "inherit" },
    );
    if (clone.status !== 0) throw new LiveTestRefusal("Cloning on the iOS host failed.");
  }
  const push = NodeChildProcess.spawnSync(
    "git",
    [
      "-C",
      paths.worktree,
      "push",
      "-q",
      "--force",
      `${IOS_SSH_HOST}:${IOS_CHECKOUT}`,
      `${commit}:refs/j5-rig/${NodePath.basename(paths.worktree)}`,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } },
  );
  if (push.status !== 0) {
    throw new LiveTestRefusal(`Pushing ${commit} to the iOS host failed:\n${push.stderr}`);
  }
}

export function mobileBuild(paths: LiveTestPaths, platform: MobilePlatform): void {
  const fingerprint = nativeFingerprint(paths, platform);
  const commandLine = `mobile-build ${platform}`;
  if (platform === "android") {
    const sdk = androidSdk();
    console.log(`Building the Android dev client for fingerprint ${fingerprint} here...`);
    const build = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(paths.worktree, "scripts/mobile-native-client.ts"),
        "ensure",
        "android",
        "--prepare",
      ],
      {
        cwd: paths.worktree,
        env: {
          ...liveTestEnvironment(process.env, paths.worktree),
          ANDROID_HOME: sdk.root,
          ANDROID_SDK_ROOT: sdk.root,
        },
        stdio: "inherit",
      },
    );
    if (build.status !== 0) throw new LiveTestRefusal(`The Android build failed; see above.`);
    return console.log(`The Android dev client is ready. Next: mobile-open.`);
  }
  assertIosHostOnline();
  const commit = NodeChildProcess.spawnSync("git", ["-C", paths.worktree, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  syncIosCheckout(paths, commit);
  console.log(
    `Building the iOS dev client on the iOS host at ${commit.slice(0, 10)} (6-15 minutes when it is not cached)...`,
  );
  // A login shell: the cold iOS build runs `pod install`, and CocoaPods is on Homebrew's PATH.
  const build = NodeChildProcess.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", IOS_SSH_HOST, "/bin/zsh -l -s"],
    {
      input: iosBuildScript({ commit, owner: paths.worktree }),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  if (build.status === LOCKED_EXIT) throw new LiveTestRefusal("Run mobile-build again later.");
  if (build.status !== 0) throw new LiveTestRefusal("The iOS build failed; see above.");
  // The host built for the commit; this worktree may differ from it by uncommitted native changes.
  if (!iosHostSucceeds(`test -d "$HOME"/${shellWord(cachedClientPath("ios", fingerprint))}`)) {
    throw new LiveTestRefusal(
      `The iOS host built ${commit.slice(0, 10)}, but this worktree's native fingerprint ${fingerprint} differs from it: commit the native changes, then run ${commandLine} again.`,
    );
  }
  console.log("The iOS dev client is ready. Next: mobile-open.");
}
