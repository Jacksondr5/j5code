// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - part of the standalone live-test CLI.
/**
 * `setup-agent-live-test.ts --mobile ios|android`: the live-test server plus what a device needs
 * to reach it. Metro on a port of this worktree's own, an SSH tunnel to the iOS host, and one
 * device slot claimed from a fixed pool. The Device panel boots the device; `mobile-open`
 * installs the dev client, opens it against Metro and pairs it as the home's owner.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { J5_BRANDING, mobileNativeProjectName } from "../lib/j5-branding.ts";
import {
  LiveTestRefusal,
  cwdOf,
  currentServerState,
  listenerOn,
  liveTestEnvironment,
  mintPairingUrl,
  printRunning,
  processGroupOf,
  readManifest,
  readServerLog,
  selfCommand,
  startServer,
  startTimeOf,
  stopGroup,
  type LiveTestPaths,
} from "./setup-agent-live-test.ts";

export const MOBILE_PLATFORMS = ["ios", "android"] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

/** The tailnet ACL's dev range (decision D3), so a phone on the tailnet can reach both ports later. */
export const MOBILE_PORT_RANGE = { first: 5774, last: 8733 } as const;
/** Simulators the iOS host's device hub already lists. The hub fixes its list when it starts, so new ones stay invisible until then. */
const IOS_POOL_NAME = /^j5-tester-\d+$/;
/**
 * Booted Simulators the iOS host takes at once. The 16 GB MacBook is also in daily use, and with
 * two booted it swapped until agent-device timed out. A dedicated host can raise this.
 */
const IOS_BOOTED_CAP = 1;
/** One AVD per slot: two emulators cannot share an AVD while the Device panel opens it read-write. */
export const ANDROID_SLOTS = ["j5-tester-1", "j5-tester-2", "j5-tester-3"] as const;
const ANDROID_DEVICE_PROFILE = "pixel_8";
/** How each device reaches this machine's loopback: through the tunnel on iOS, the emulator's alias on Android. */
const DEVICE_LOOPBACK: Record<MobilePlatform, string> = { ios: "127.0.0.1", android: "10.0.2.2" };
const IOS_SSH_HOST = process.env.J5_MOBILE_IOS_SSH_HOST?.trim() || "macbook";
const BUNDLE_TIMEOUT_MS = 120_000;
const TUNNEL_TIMEOUT_MS = 20_000;
const EMULATOR_EXIT_TIMEOUT_MS = 30_000;
const PAIR_TIMEOUT_MS = 60_000;
/** Long enough for the app to finish adding the environment, so a link it is using is not sent twice. */
const PAIR_REOPEN_MS = 10_000;

/** A process this script spawned detached, so its pid is also its group. */
interface ProcessRecord {
  readonly pid: number;
  readonly startTime: string;
}

/** What `mobile.json` in the live-test root says. Written as soon as a slot is claimed, so `stop` can release it. */
export interface MobileRecord {
  readonly platform: MobilePlatform;
  /** The Simulator's or the AVD's name. */
  readonly slot: string;
  /** iOS only: the claimed Simulator. */
  readonly udid?: string;
  readonly serverPort: number;
  readonly metroPort: number;
  readonly metro?: ProcessRecord;
  readonly tunnel?: ProcessRecord;
  /** Android only: the emulator this script booted, and its console port (serial `emulator-<port>`). */
  readonly emulator?: ProcessRecord & { readonly port: number };
}

const mobileFiles = (paths: LiveTestPaths) => ({
  record: NodePath.join(paths.root, "mobile.json"),
  metroLog: NodePath.join(paths.root, "metro.log"),
  tunnelLog: NodePath.join(paths.root, "tunnel.log"),
  emulatorLog: NodePath.join(paths.root, "emulator.log"),
});

export function readMobileRecord(paths: LiveTestPaths): MobileRecord | undefined {
  const file = mobileFiles(paths).record;
  return NodeFS.existsSync(file)
    ? (JSON.parse(NodeFS.readFileSync(file, "utf8")) as MobileRecord)
    : undefined;
}

function writeMobileRecord(paths: LiveTestPaths, record: MobileRecord): void {
  NodeFS.mkdirSync(paths.root, { recursive: true });
  NodeFS.writeFileSync(mobileFiles(paths).record, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * The backend and Metro ports for `worktree`: a pair inside the D3 range, starting from a point
 * the worktree path picks so that each worktree keeps its own pair across restarts.
 */
export function chooseMobilePorts(input: {
  readonly worktree: string;
  /** Ports already taken by this server, such as the dev runner's web port. */
  readonly avoid: ReadonlyArray<number>;
  readonly isFree: (port: number) => boolean;
}): { readonly serverPort: number; readonly metroPort: number } {
  const pairs = Math.floor((MOBILE_PORT_RANGE.last - MOBILE_PORT_RANGE.first + 1) / 2);
  const start =
    NodeCrypto.createHash("sha256").update(input.worktree).digest().readUInt32BE(0) % pairs;
  for (let step = 0; step < pairs; step += 1) {
    const serverPort = MOBILE_PORT_RANGE.first + 2 * ((start + step) % pairs);
    const metroPort = serverPort + 1;
    const usable = (port: number) => !input.avoid.includes(port) && input.isFree(port);
    if (usable(serverPort) && usable(metroPort)) return { serverPort, metroPort };
  }
  throw new LiveTestRefusal(
    `No free pair of ports is left in ${MOBILE_PORT_RANGE.first}-${MOBILE_PORT_RANGE.last}.`,
  );
}

/** Where claims live: shared by every worktree on this machine, so it is outside all of them. */
export const claimsDirectory = (home: string) =>
  NodePath.join(home, ".cache", "j5-mobile-rig", "claims");

const ownerOf = (claim: string): string | undefined => {
  try {
    return NodeFS.readFileSync(NodePath.join(claim, "owner"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Claims the first free slot for `worktree`, or the one it already holds. A claim is a directory
 * made with one atomic `mkdir`, holding the owner's worktree path. A full pool is refused, never queued.
 */
export function claimSlot(input: {
  readonly directory: string;
  readonly platform: MobilePlatform;
  readonly slots: ReadonlyArray<string>;
  readonly worktree: string;
}): string {
  NodeFS.mkdirSync(input.directory, { recursive: true });
  const claimOf = (slot: string) => NodePath.join(input.directory, `${input.platform}-${slot}`);
  const held = input.slots.find((slot) => ownerOf(claimOf(slot)) === input.worktree);
  if (held !== undefined) return held;
  for (const slot of input.slots) {
    try {
      NodeFS.mkdirSync(claimOf(slot));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
    NodeFS.writeFileSync(NodePath.join(claimOf(slot), "owner"), `${input.worktree}\n`);
    return slot;
  }
  const holders = input.slots.map((slot) => {
    const owner = ownerOf(claimOf(slot));
    const gone = owner !== undefined && !NodeFS.existsSync(owner);
    return `  ${slot}: ${owner ?? "being claimed"}${gone ? ` (that worktree is gone: rm -r ${claimOf(slot)})` : ""}`;
  });
  throw new LiveTestRefusal(
    `All ${input.slots.length} ${input.platform === "ios" ? "iOS" : "Android"} test devices are in use:\n${holders.join("\n")}\nTry again when one is free; each holder releases its device with \`stop\`.`,
  );
}

/** Releases a claim this worktree holds. Someone else's claim is left alone. */
export function releaseSlot(input: {
  readonly directory: string;
  readonly platform: MobilePlatform;
  readonly slot: string;
  readonly worktree: string;
}): void {
  const claim = NodePath.join(input.directory, `${input.platform}-${input.slot}`);
  if (ownerOf(claim) === input.worktree) NodeFS.rmSync(claim, { recursive: true, force: true });
}

export interface Simulator {
  readonly name: string;
  readonly udid: string;
  readonly booted: boolean;
}

/** Every available Simulator in `xcrun simctl list devices --json` output. */
export function simulatorsFromSimctl(json: string): ReadonlyArray<Simulator> {
  const { devices } = JSON.parse(json) as {
    readonly devices: Record<
      string,
      ReadonlyArray<{ name: string; udid: string; state: string; isAvailable?: boolean }>
    >;
  };
  return Object.values(devices)
    .flat()
    .filter((device) => device.isAvailable !== false)
    .map((device) => ({ name: device.name, udid: device.udid, booted: device.state === "Booted" }));
}

/** The test pool: Simulators named `j5-tester-<n>`, in name order. */
export const iosPool = (simulators: ReadonlyArray<Simulator>) =>
  simulators
    .filter((simulator) => IOS_POOL_NAME.test(simulator.name))
    .toSorted((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

/**
 * The Simulators besides `mine` that count against the iOS host's limit: every other pool
 * Simulator another worktree has claimed, booted or not yet, and any booted one outside the pool.
 */
export function iosBusy(input: {
  readonly simulators: ReadonlyArray<Simulator>;
  readonly mine: string;
  readonly claimed: (name: string) => boolean;
}): ReadonlyArray<string> {
  const pool = new Set(iosPool(input.simulators).map((simulator) => simulator.udid));
  return input.simulators
    .filter(
      (simulator) =>
        simulator.udid !== input.mine &&
        (pool.has(simulator.udid)
          ? simulator.booted || input.claimed(simulator.name)
          : simulator.booted),
    )
    .map((simulator) => simulator.name);
}

/** A string as one word for a POSIX shell: the remote login shell over SSH, or `adb shell`. */
export const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The URL that opens the dev client against Metro without the launcher's onboarding and overlays. */
export function devClientUrl(platform: MobilePlatform, metroPort: number): string {
  const query = new URLSearchParams({
    url: `http://${DEVICE_LOOPBACK[platform]}:${metroPort}`,
    disableOnboarding: "1",
    disableAutoLaunch: "1",
    disableFab: "1",
  });
  return `${J5_BRANDING.mobile.development.scheme}://expo-development-client/?${query}`;
}

/**
 * The app's Add Environment route for a pairing link from `pair`. The token is moved onto the
 * backend origin the device reaches, as `buildPairingUrl` in apps/server/src/startupAccess.ts does.
 */
export function pairingDeepLink(input: {
  readonly platform: MobilePlatform;
  readonly serverPort: number;
  readonly pairingUrl: string;
}): string {
  const token = new URLSearchParams(new URL(input.pairingUrl).hash.slice(1)).get("token");
  if (token === null) throw new LiveTestRefusal(`No token in the pairing URL ${input.pairingUrl}.`);
  const pairing = new URL(`http://${DEVICE_LOOPBACK[input.platform]}:${input.serverPort}/pair`);
  pairing.hash = new URLSearchParams([["token", token]]).toString();
  const query = new URLSearchParams({ pairingUrl: pairing.toString(), autoConnect: "1" });
  return `${J5_BRANDING.mobile.development.scheme}://connections/new?${query}`;
}

/** How many bundles Metro's log says it has served or failed, as `iOS Bundled 812ms ...`. */
export function metroBundles(log: string): { readonly served: number; readonly failed: number } {
  const plain = log.replaceAll(/\u001B\[[0-9;]*m/g, "");
  return {
    served: [...plain.matchAll(/\b(iOS|Android) Bundled\b/g)].length,
    failed: [...plain.matchAll(/\b(iOS|Android) Bundling failed\b/g)].length,
  };
}

/**
 * `expo/fingerprint` exactly as scripts/mobile-native-client.ts runs it, so the rig finds the
 * client that `mobile:install` caches. A test keeps the two in step.
 */
export const FINGERPRINT_EVAL = `const f = require('expo/fingerprint'); f.createFingerprintAsync(process.cwd(), { platforms: [process.argv[1]], silent: true, ignorePaths: ['android/**', 'ios/**'], sourceSkips: f.DEFAULT_SOURCE_SKIPS | f.SourceSkips.ExpoConfigExtraSection }).then(fp => console.log('T3_NATIVE_FINGERPRINT=' + fp.hash)).catch(e => { console.error(e); process.exitCode = 1; });`;
export const FINGERPRINT_ENV = {
  APP_VARIANT: "development",
  MOBILE_VERSION_POLICY: "appVersion",
  T3CODE_IOS_PERSONAL_TEAM: "0",
  CI: "1",
  EXPO_NO_GIT_STATUS: "1",
  COPYFILE_DISABLE: "1",
} as const;

/** Where `mobile:install` caches the client for a fingerprint, relative to the home directory. */
export const cachedClientPath = (platform: MobilePlatform, fingerprint: string) =>
  platform === "ios"
    ? `.cache/t3code/native-clients/artifacts/ios/development/${fingerprint}/${mobileNativeProjectName(J5_BRANDING.mobile.development.appName)}.app`
    : `.cache/t3code/native-clients/artifacts/android/development-x86_64/${fingerprint}/app-debug.apk`;

function nativeFingerprint(paths: LiveTestPaths, platform: MobilePlatform): string {
  const run = NodeChildProcess.spawnSync(process.execPath, ["--eval", FINGERPRINT_EVAL, platform], {
    cwd: NodePath.join(paths.worktree, "apps/mobile"),
    env: { ...process.env, ...FINGERPRINT_ENV },
    encoding: "utf8",
    timeout: 120_000,
  });
  const hash = /T3_NATIVE_FINGERPRINT=([a-f0-9]{40,64})/.exec(run.stdout ?? "")?.[1];
  if (hash === undefined) {
    throw new LiveTestRefusal(`Expo did not return a native fingerprint:\n${run.stderr}`);
  }
  return hash;
}

/** Labels of the pairing links the test server has issued and nobody has used yet. */
function activePairingLabels(paths: LiveTestPaths): ReadonlyArray<string> {
  const list = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "apps/server/src/bin.ts"),
      "auth",
      "pairing",
      "list",
      "--base-dir",
      paths.home,
      "--json",
    ],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (list.status !== 0) throw new LiveTestRefusal(`Listing pairing links failed:\n${list.stderr}`);
  return (JSON.parse(list.stdout) as ReadonlyArray<{ readonly label?: string }>).flatMap((link) =>
    link.label === undefined ? [] : [link.label],
  );
}

/** A command over SSH on the iOS host. Its stdout, or a refusal naming what failed. */
function onIosHost(command: string, timeoutMs = 60_000): string {
  const run = NodeChildProcess.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", IOS_SSH_HOST, command],
    { encoding: "utf8", timeout: timeoutMs },
  );
  if (run.status !== 0) {
    throw new LiveTestRefusal(
      `On the iOS host (${IOS_SSH_HOST}), \`${command}\` failed: ${(run.stderr || String(run.error ?? "")).trim() || `exit ${run.status}`}`,
    );
  }
  return run.stdout;
}

function assertIosHostOnline(): void {
  const probe = NodeChildProcess.spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", IOS_SSH_HOST, "xcrun simctl help"],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (probe.status !== 0) {
    throw new LiveTestRefusal(
      `iOS host offline; Android is available (--mobile android).\n\`ssh ${IOS_SSH_HOST}\` said: ${(probe.stderr || String(probe.error ?? "")).trim() || `exit ${probe.status}`}`,
    );
  }
}

const iosSimulators = () => simulatorsFromSimctl(onIosHost("xcrun simctl list devices --json"));

/** The Android SDK's tools, or a refusal naming what is missing. */
function androidSdk() {
  const home = NodeOS.homedir();
  const root = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    NodePath.join(home, "Android", "Sdk"),
    NodePath.join(home, "Android", "sdk"),
  ].find((candidate) => candidate && NodeFS.existsSync(NodePath.join(candidate, "platform-tools")));
  if (root === undefined) {
    throw new LiveTestRefusal(
      "No Android SDK found: set ANDROID_HOME, or install it in ~/Android/Sdk.",
    );
  }
  const tools = {
    root,
    adb: NodePath.join(root, "platform-tools", "adb"),
    avdmanager: NodePath.join(root, "cmdline-tools", "latest", "bin", "avdmanager"),
    emulator: NodePath.join(root, "emulator", "emulator"),
  };
  for (const tool of [tools.adb, tools.avdmanager, tools.emulator]) {
    if (!NodeFS.existsSync(tool)) throw new LiveTestRefusal(`The Android SDK has no ${tool}.`);
  }
  return tools;
}

/** The first x86_64 system image installed, as avdmanager names a package. */
function androidSystemImage(root: string): string {
  const images = NodePath.join(root, "system-images");
  for (const api of NodeFS.existsSync(images)
    ? NodeFS.readdirSync(images).toSorted().toReversed()
    : []) {
    for (const tag of NodeFS.readdirSync(NodePath.join(images, api))) {
      if (NodeFS.existsSync(NodePath.join(images, api, tag, "x86_64"))) {
        return `system-images;${api};${tag};x86_64`;
      }
    }
  }
  throw new LiveTestRefusal(`No x86_64 system image is installed under ${images}.`);
}

function assertKvm(): void {
  try {
    NodeFS.accessSync("/dev/kvm", NodeFS.constants.R_OK | NodeFS.constants.W_OK);
  } catch {
    throw new LiveTestRefusal(
      "This user cannot use /dev/kvm, so the Android emulator cannot run. Ask the developer to add it to the kvm group.",
    );
  }
}

const runAsync = (command: string, args: ReadonlyArray<string>, input?: string) =>
  new Promise<{ readonly status: number | null; readonly output: string }>((resolve) => {
    const child = NodeChildProcess.spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (cause) => resolve({ status: null, output: String(cause) }));
    child.on("exit", (status) => resolve({ status, output }));
    child.stdin.end(input ?? "");
  });

async function createAvd(slot: string): Promise<void> {
  const sdk = androidSdk();
  const created = await runAsync(
    sdk.avdmanager,
    [
      "create",
      "avd",
      "--force",
      "-n",
      slot,
      "-k",
      androidSystemImage(sdk.root),
      "-d",
      ANDROID_DEVICE_PROFILE,
    ],
    "no\n",
  );
  if (created.status !== 0) {
    throw new LiveTestRefusal(`Creating the AVD ${slot} failed:\n${created.output.trim()}`);
  }
}

function avdExists(slot: string): boolean {
  const avdHome =
    process.env.ANDROID_AVD_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".android", "avd");
  return NodeFS.existsSync(NodePath.join(avdHome, `${slot}.ini`));
}

/** Emulator serials in `adb devices` output, including ones still booting or gone offline. */
export const emulatorSerials = (devices: string) =>
  devices.match(/^emulator-\d+(?=\s+(device|offline)\b)/gm) ?? [];

/**
 * The pid of whatever runs `avd`, from the lock file the emulator holds while it runs, even
 * one adb cannot see: a lock left by a killed emulator names a pid that is gone.
 */
function avdRunner(avd: string): number | undefined {
  const avdHome =
    process.env.ANDROID_AVD_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".android", "avd");
  try {
    // The emulator writes its pid with a trailing byte that is not whitespace.
    const pid = Number(
      /\d+/.exec(
        NodeFS.readFileSync(NodePath.join(avdHome, `${avd}.avd`, "hardware-qemu.ini.lock"), "utf8"),
      )?.[0],
    );
    return Number.isInteger(pid) && startTimeOf(pid) !== undefined ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The serial of the running emulator whose AVD is `avd`, if any. */
function emulatorSerial(avd: string): string | undefined {
  const { adb } = androidSdk();
  const devices = NodeChildProcess.spawnSync(adb, ["devices"], { encoding: "utf8" }).stdout ?? "";
  for (const serial of emulatorSerials(devices)) {
    const name = NodeChildProcess.spawnSync(adb, ["-s", serial, "emu", "avd", "name"], {
      encoding: "utf8",
      timeout: 10_000,
    }).stdout;
    if (name?.split(/\r?\n/)[0]?.trim() === avd) return serial;
  }
  return undefined;
}

/**
 * Emulator console ports: even, each with its adb port above it. 5554 is left out: the Device
 * panel boots every AVD there, so an AVD it boots can never land on a rig emulator's port.
 */
const EMULATOR_PORTS = Array.from({ length: 15 }, (_, index) => 5556 + 2 * index);

/**
 * Boots the slot's AVD here, on a free console port, headless. The Device panel attaches to a
 * running emulator by its serial; asked to boot an AVD while another emulator runs, it opens
 * the running one instead.
 */
async function startEmulator(
  paths: LiveTestPaths,
  record: MobileRecord,
  deadline: number,
): Promise<void> {
  const sdk = androidSdk();
  if (isOurs(paths, record.emulator)) return waitForBoot(sdk.adb, record.emulator!, deadline);
  const port = EMULATOR_PORTS.find(
    (candidate) => listenerOn(candidate) === undefined && listenerOn(candidate + 1) === undefined,
  );
  if (port === undefined) throw new LiveTestRefusal("No emulator console port is free.");
  const log = mobileFiles(paths).emulatorLog;
  const emulator = {
    ...spawnRecorded(
      sdk.emulator,
      [
        "-avd",
        record.slot,
        "-port",
        String(port),
        "-no-window",
        "-no-audio",
        "-no-boot-anim",
        "-no-snapshot",
        "-gpu",
        "auto",
      ],
      {
        cwd: paths.worktree,
        env: { ...process.env, ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root },
        log,
      },
    ),
    port,
  };
  writeMobileRecord(paths, { ...readMobileRecord(paths)!, emulator });
  await waitForBoot(sdk.adb, emulator, deadline, log);
}

/** Waits until Android has booted: the Device panel lists an emulator only after that. */
async function waitForBoot(
  adb: string,
  emulator: ProcessRecord & { readonly port: number },
  deadline: number,
  log?: string,
): Promise<void> {
  const serial = `emulator-${emulator.port}`;
  for (;;) {
    const booted = NodeChildProcess.spawnSync(
      adb,
      ["-s", serial, "shell", "getprop", "sys.boot_completed"],
      { encoding: "utf8", timeout: 10_000 },
    );
    if (booted.stdout?.trim() === "1") return;
    if (startTimeOf(emulator.pid) !== emulator.startTime) {
      throw new LiveTestRefusal(
        `The emulator exited while booting.${log === undefined ? "" : `\n${tail(log)}`}`,
      );
    }
    if (Date.now() > deadline) {
      throw new LiveTestRefusal(
        `The emulator ${serial} is still booting; it has been left running. Run the same command again to wait for it.`,
      );
    }
    await NodeTimersPromises.setTimeout(1_000);
  }
}

function spawnRecorded(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly log: string },
): ProcessRecord {
  const log = NodeFS.openSync(options.log, "w");
  const child = NodeChildProcess.spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  NodeFS.closeSync(log);
  const startTime = child.pid === undefined ? undefined : startTimeOf(child.pid);
  if (child.pid === undefined || startTime === undefined) {
    throw new LiveTestRefusal(`${command} could not be spawned.`);
  }
  child.unref();
  return { pid: child.pid, startTime };
}

/** Whether a recorded process is still the one this script spawned from this worktree. */
const isOurs = (paths: LiveTestPaths, record: ProcessRecord | undefined) => {
  if (record === undefined || startTimeOf(record.pid) !== record.startTime) return false;
  const cwd = cwdOf(record.pid);
  if (cwd === undefined) return false;
  const relative = NodePath.relative(NodeFS.realpathSync(paths.worktree), cwd);
  return !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

const tail = (file: string) =>
  NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").split("\n").slice(-30).join("\n")
    : "";

async function startMetro(
  paths: LiveTestPaths,
  record: MobileRecord,
  deadline: number,
): Promise<ProcessRecord> {
  const { metroLog } = mobileFiles(paths);
  const metro = isOurs(paths, record.metro)
    ? record.metro!
    : spawnRecorded(
        NodePath.join(paths.worktree, "apps/mobile/node_modules/.bin/expo"),
        [
          "start",
          "--dev-client",
          "--scheme",
          J5_BRANDING.mobile.development.scheme,
          "--port",
          String(record.metroPort),
        ],
        {
          cwd: NodePath.join(paths.worktree, "apps/mobile"),
          env: {
            ...liveTestEnvironment(process.env, paths.worktree),
            APP_VARIANT: "development",
            // The host the manifest's bundle URL names, as the device reaches Metro.
            REACT_NATIVE_PACKAGER_HOSTNAME: DEVICE_LOOPBACK[record.platform],
            BROWSER: "none",
          },
          log: metroLog,
        },
      );
  writeMobileRecord(paths, { ...readMobileRecord(paths)!, metro });
  for (;;) {
    const listener = listenerOn(record.metroPort);
    if (listener !== undefined && processGroupOf(listener) === metro.pid) return metro;
    if (startTimeOf(metro.pid) !== metro.startTime) {
      throw new LiveTestRefusal(
        `Metro exited while starting. Last lines of ${metroLog}:\n${tail(metroLog)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new LiveTestRefusal(
        `Metro was not listening on ${record.metroPort} in time; it has been left running. See ${metroLog}, then run the same command again.`,
      );
    }
    await NodeTimersPromises.setTimeout(250);
  }
}

/** Opens the reverse tunnel that puts the backend and Metro on the iOS host's loopback, which the Simulator shares. */
async function startTunnel(paths: LiveTestPaths, record: MobileRecord): Promise<ProcessRecord> {
  const { tunnelLog } = mobileFiles(paths);
  const forward = (port: number) => ["-R", `127.0.0.1:${port}:127.0.0.1:${port}`];
  const tunnel = isOurs(paths, record.tunnel)
    ? record.tunnel!
    : spawnRecorded(
        "ssh",
        [
          "-N",
          "-o",
          "BatchMode=yes",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=15",
          ...forward(record.serverPort),
          ...forward(record.metroPort),
          IOS_SSH_HOST,
        ],
        { cwd: paths.worktree, env: process.env, log: tunnelLog },
      );
  writeMobileRecord(paths, { ...readMobileRecord(paths)!, tunnel });
  const check = `curl -fsS -o /dev/null http://127.0.0.1:${record.serverPort}/.well-known/t3/environment && curl -fsS http://127.0.0.1:${record.metroPort}/status`;
  const until = Date.now() + TUNNEL_TIMEOUT_MS;
  for (;;) {
    if (startTimeOf(tunnel.pid) !== tunnel.startTime) {
      throw new LiveTestRefusal(`The SSH tunnel to ${IOS_SSH_HOST} exited:\n${tail(tunnelLog)}`);
    }
    const probe = NodeChildProcess.spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", IOS_SSH_HOST, check],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (probe.status === 0) return tunnel;
    if (Date.now() > until) {
      throw new LiveTestRefusal(
        `The iOS host cannot reach the backend and Metro through the tunnel: ${probe.stderr.trim()}`,
      );
    }
    await NodeTimersPromises.setTimeout(500);
  }
}

/**
 * The web port the dev runner derives for this worktree, which the mobile pair must not take.
 * With both ports explicit, its dry run prints that port and searches nothing.
 */
function devRunnerWebPort(paths: LiveTestPaths): number {
  const dryRun = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.join(paths.worktree, "scripts/dev-runner.ts"),
      "dev",
      "--dry-run",
      "--home-dir",
      paths.home,
      "--port",
      "1",
      "--dev-url",
      "http://localhost:1",
    ],
    {
      cwd: paths.worktree,
      env: liveTestEnvironment(process.env, paths.worktree),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  const webPort = readServerLog(`${dryRun.stdout}${dryRun.stderr}`).webPort;
  if (webPort === undefined) {
    throw new LiveTestRefusal(`The dev runner did not report its web port:\n${dryRun.stderr}`);
  }
  return webPort;
}

/** Claims a device slot, recording it before anything else so `stop` can release it. */
function claim(paths: LiveTestPaths, platform: MobilePlatform): MobileRecord {
  const existing = readMobileRecord(paths);
  if (existing !== undefined) {
    if (existing.platform !== platform) {
      throw new LiveTestRefusal(
        `This worktree's live test is set up for ${existing.platform}. Stop it first: ${selfCommand(paths, "stop")}`,
      );
    }
    return existing;
  }
  const { serverPort, metroPort } = chooseMobilePorts({
    worktree: paths.worktree,
    avoid: [devRunnerWebPort(paths)],
    isFree: (port) => listenerOn(port) === undefined,
  });
  // Nothing that can fail sits between a claim and its record, so `stop` always finds it.
  const directory = claimsDirectory(NodeOS.homedir());
  let slot: string;
  let udid: string | undefined;
  const simulators = platform === "ios" ? iosSimulators() : [];
  if (platform === "ios") {
    const pool = iosPool(simulators);
    if (pool.length === 0) {
      throw new LiveTestRefusal(
        `The iOS host has no Simulators named j5-tester-<n>, the test pool. See the Mobile section of the j5-live-test skill.`,
      );
    }
    slot = claimSlot({
      directory,
      platform,
      slots: pool.map((s) => s.name),
      worktree: paths.worktree,
    });
    const mine = pool.find((simulator) => simulator.name === slot)!;
    const busy = iosBusy({
      simulators,
      mine: mine.udid,
      claimed: (name) => ownerOf(NodePath.join(directory, `ios-${name}`)) !== undefined,
    });
    if (busy.length >= IOS_BOOTED_CAP) {
      releaseSlot({ directory, platform, slot, worktree: paths.worktree });
      throw new LiveTestRefusal(
        `The iOS host already runs or has promised ${busy.length} Simulators (${busy.join(", ")}), its limit. Try again when one is free.`,
      );
    }
    udid = mine.udid;
  } else {
    slot = claimSlot({ directory, platform, slots: ANDROID_SLOTS, worktree: paths.worktree });
  }
  const record: MobileRecord = {
    platform,
    slot,
    ...(udid === undefined ? {} : { udid }),
    serverPort,
    metroPort,
  };
  writeMobileRecord(paths, record);
  return record;
}

/**
 * Starts the backend on its mobile port, Metro, and the device side, joining any part that is
 * already running. A failure leaves what was started recorded; `stop` removes it.
 */
export async function startMobile(
  paths: LiveTestPaths,
  platform: MobilePlatform,
  deadline: number,
): Promise<void> {
  if (readMobileRecord(paths) === undefined && currentServerState(paths).kind !== "stopped") {
    throw new LiveTestRefusal(
      `A live-test server is already running here without --mobile. Stop it first: ${selfCommand(paths, "stop")}`,
    );
  }
  if (platform === "ios") assertIosHostOnline();
  else {
    androidSdk();
    assertKvm();
  }
  const record = claim(paths, platform);
  const stopHint = `\nTo undo what was set up: ${selfCommand(paths, "stop")}`;
  try {
    console.log(`Starting the dev server, Metro and the ${platform} device slot ${record.slot}...`);
    const backend = startServer(paths, "dev", {}, deadline, ["--port", String(record.serverPort)]);
    backend.catch(() => undefined);
    const avd =
      platform === "android"
        ? (avdExists(record.slot) ? Promise.resolve() : createAvd(record.slot)).then(() =>
            startEmulator(paths, record, deadline),
          )
        : Promise.resolve();
    avd.catch(() => undefined);
    await startMetro(paths, record, deadline);
    const facts = await backend;
    await avd;
    if (platform === "ios") await startTunnel(paths, readMobileRecord(paths)!);
    printRunning(paths, facts, undefined);
    console.log(formatMobile(paths, readMobileRecord(paths)!));
  } catch (cause) {
    if (cause instanceof LiveTestRefusal) throw new LiveTestRefusal(`${cause.message}${stopHint}`);
    throw cause;
  }
}

export function formatMobile(paths: LiveTestPaths, record: MobileRecord): string {
  const host = DEVICE_LOOPBACK[record.platform];
  const device =
    record.platform === "ios"
      ? `hostId: the MacBook host in device_list; deviceId "${record.udid}" (${record.slot})`
      : record.emulator === undefined
        ? `${record.slot}: its emulator has not started; run ${selfCommand(paths, "--mobile android")}`
        : `hostId "local"; deviceId "emulator-${record.emulator.port}" (${record.slot})`;
  return `Mobile (${record.platform}), device slot ${record.slot}:
  Device panel  ${device}
  Backend       http://${host}:${record.serverPort} from the device
  Metro         http://${host}:${record.metroPort} from the device, log ${mobileFiles(paths).metroLog}${
    record.platform === "ios"
      ? `\n  Tunnel        ssh ${IOS_SSH_HOST}, log ${mobileFiles(paths).tunnelLog}`
      : ""
  }

Next:
  1. device_open with the ids above.${record.platform === "ios" ? " It boots the Simulator." : ""}
  2. ${selfCommand(paths, "mobile-open")}
     installs the dev client, opens it against Metro and pairs it as the home's owner.
When you finish: device_close, then ${selfCommand(paths, "stop")}
(it ${record.platform === "ios" ? "shuts down and erases the Simulator" : "shuts down and deletes the AVD"} and releases the slot).
`;
}

/** Installs the dev client on the booted device, opens it against Metro and pairs it as the owner. */
export async function mobileOpen(paths: LiveTestPaths): Promise<void> {
  const record = readMobileRecord(paths);
  if (record === undefined) {
    throw new LiveTestRefusal(
      `No mobile live test is set up here. Start one: ${selfCommand(paths, "--mobile ios|android")}`,
    );
  }
  const server = currentServerState(paths);
  if (server.kind !== "running" || !isOurs(paths, record.metro)) {
    throw new LiveTestRefusal(
      `The backend or Metro is not running. Check with ${selfCommand(paths, "status")}, or start again with ${selfCommand(paths, `--mobile ${record.platform}`)}`,
    );
  }
  if (record.platform === "ios" && !isOurs(paths, record.tunnel)) {
    throw new LiveTestRefusal(
      `The SSH tunnel is down. Start it again with ${selfCommand(paths, "--mobile ios")}`,
    );
  }
  const openHint = `Open it first: device_open with the ids \`${selfCommand(paths, "status")}\` prints.`;

  const fingerprint = nativeFingerprint(paths, record.platform);
  const client = cachedClientPath(record.platform, fingerprint);
  let openUrl: (url: string) => void;
  if (record.platform === "ios") {
    const udid = record.udid!;
    const simulator = iosSimulators().find((s) => s.udid === udid);
    if (simulator?.booted !== true)
      throw new LiveTestRefusal(`${record.slot} is not booted. ${openHint}`);
    const remoteClient = `"$HOME"/${shellQuote(client)}`;
    const cached = NodeChildProcess.spawnSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", IOS_SSH_HOST, `test -d ${remoteClient}`],
      { timeout: 30_000 },
    );
    if (cached.status !== 0) {
      throw new LiveTestRefusal(
        `The iOS host has no dev client for this checkout's native fingerprint ${fingerprint}. Build it there from a checkout of this commit: vp run mobile:install ios --prepare`,
      );
    }
    console.log(`Installing the dev client on ${record.slot}...`);
    onIosHost(`xcrun simctl install ${udid} ${remoteClient}`, 120_000);
    // Without this, iOS asks "Open in J5 Code Dev?" for every link simctl opens. The device
    // hub's serve-sim writes the same approval before it opens a URL.
    const { scheme, appId } = J5_BRANDING.mobile.development;
    onIosHost(
      `xcrun simctl spawn ${udid} defaults write com.apple.launchservices.schemeapproval ${shellQuote(`com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`)} -string ${appId}`,
    );
    // openurl gives a launch 10 seconds. An app's first launch on a freshly erased Simulator,
    // with another booted beside it, can take longer; simctl launch waits for it.
    onIosHost(`xcrun simctl launch ${udid} ${appId}`, 120_000);
    openUrl = (url) => void onIosHost(`xcrun simctl openurl ${udid} ${shellQuote(url)}`);
  } else {
    if (!isOurs(paths, record.emulator)) {
      throw new LiveTestRefusal(
        `The emulator for ${record.slot} is not running. Start it again with ${selfCommand(paths, "--mobile android")}`,
      );
    }
    const serial = `emulator-${record.emulator!.port}`;
    const { adb } = androidSdk();
    const apk = NodePath.join(NodeOS.homedir(), client);
    if (!NodeFS.existsSync(apk)) {
      throw new LiveTestRefusal(
        `There is no Android dev client for this checkout's native fingerprint ${fingerprint}. Build it (about 15 minutes the first time): vp run mobile:install android --prepare`,
      );
    }
    const adbRun = (args: ReadonlyArray<string>, what: string) => {
      const run = NodeChildProcess.spawnSync(adb, ["-s", serial, ...args], {
        encoding: "utf8",
        timeout: 180_000,
      });
      if (run.status !== 0)
        throw new LiveTestRefusal(`${what} failed: ${run.stderr || run.stdout}`);
    };
    adbRun(
      [
        "wait-for-device",
        "shell",
        'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done',
      ],
      "Waiting for the emulator to boot",
    );
    console.log(`Installing the dev client on ${record.slot} (${serial})...`);
    adbRun(["install", "-r", "-d", apk], "Installing the dev client");
    openUrl = (url) =>
      adbRun(
        ["shell", `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`],
        "Opening a link",
      );
  }

  const { metroLog } = mobileFiles(paths);
  const before = metroBundles(NodeFS.readFileSync(metroLog, "utf8"));
  console.log("Opening the dev client against Metro (the first bundle takes about 30 seconds)...");
  openUrl(devClientUrl(record.platform, record.metroPort));
  const until = Date.now() + BUNDLE_TIMEOUT_MS;
  for (;;) {
    const now = metroBundles(NodeFS.readFileSync(metroLog, "utf8"));
    if (now.failed > before.failed) {
      throw new LiveTestRefusal(`Metro failed to bundle the app:\n${tail(metroLog)}`);
    }
    if (now.served > before.served) break;
    if (Date.now() > until) {
      throw new LiveTestRefusal(
        `Metro served no bundle within ${BUNDLE_TIMEOUT_MS / 1000} seconds of opening the dev client. Take a screenshot, read ${metroLog}, then run mobile-open again.`,
      );
    }
    await NodeTimersPromises.setTimeout(500);
  }

  const manifest = readManifest(paths);
  const owner = "ownerName" in manifest ? manifest.ownerName : undefined;
  if (owner === undefined)
    throw new LiveTestRefusal("The test home's owner has no name to pair as.");
  const label = `mobile-open ${record.slot} ${Date.now()}`;
  const pairingUrl = mintPairingUrl(paths, owner, label);
  if (pairingUrl === undefined) throw new LiveTestRefusal("Minting a pairing link failed.");
  const link = pairingDeepLink({
    platform: record.platform,
    serverPort: record.serverPort,
    pairingUrl,
  });
  // A link that arrives before the app has mounted is dropped, and nothing on the device says
  // when it has. The server does: a used link leaves its active list. So open until it is used.
  console.log(`Pairing as ${owner}...`);
  const pairUntil = Date.now() + PAIR_TIMEOUT_MS;
  let lastOpen = 0;
  while (activePairingLabels(paths).includes(label)) {
    if (Date.now() > pairUntil) {
      throw new LiveTestRefusal(
        `The app did not use the pairing link within ${PAIR_TIMEOUT_MS / 1000} seconds. Take a screenshot, then run mobile-open again.`,
      );
    }
    if (Date.now() - lastOpen >= PAIR_REOPEN_MS) {
      openUrl(link);
      lastOpen = Date.now();
    }
    await NodeTimersPromises.setTimeout(1_000);
  }
  console.log(`Opened the dev client and paired it as ${owner}.
Take a screenshot: the app should list the project "${"project" in manifest ? manifest.project.title : "the test project"}".
If it does not, run mobile-open again.${
    record.platform === "android"
      ? '\nOn a first launch Android may show "Could not import shared content"; press Retry.'
      : ""
  }`);
}

/**
 * Takes down everything `startMobile` recorded: Metro, the tunnel, the device (reset for the next
 * tester) and the claim. A step that fails keeps the record, so running `stop` again finishes it.
 */
export async function stopMobile(paths: LiveTestPaths): Promise<void> {
  const record = readMobileRecord(paths);
  if (record === undefined) return;
  for (const [name, process_] of [
    ["Metro", record.metro],
    ["SSH tunnel", record.tunnel],
  ] as const) {
    if (!isOurs(paths, process_)) continue;
    await stopGroup(process_!.pid);
    console.log(`${name}: STOPPED`);
  }
  if (record.platform === "ios") {
    const udid = record.udid!;
    // Shutting down a Simulator that is already shut down is an error simctl reports; erase is not.
    NodeChildProcess.spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        IOS_SSH_HOST,
        `xcrun simctl shutdown ${udid}`,
      ],
      { timeout: 60_000 },
    );
    try {
      onIosHost(`xcrun simctl erase ${udid}`);
    } catch (cause) {
      const { metro: _metro, tunnel: _tunnel, ...rest } = record;
      writeMobileRecord(paths, rest);
      throw new LiveTestRefusal(
        `${record.slot} was not reset, so it is still claimed. ${(cause as Error).message}\nRun stop again when the iOS host is back.`,
      );
    }
    console.log(`Simulator ${record.slot}: SHUT DOWN AND ERASED`);
  } else {
    const { adb, avdmanager } = androidSdk();
    if (isOurs(paths, record.emulator)) await stopGroup(record.emulator!.pid);
    // One the Device panel booted from this AVD is not ours to signal, but it can be asked to quit.
    const serial = emulatorSerial(record.slot);
    if (serial !== undefined) {
      NodeChildProcess.spawnSync(adb, ["-s", serial, "emu", "kill"], { timeout: 15_000 });
      const until = Date.now() + EMULATOR_EXIT_TIMEOUT_MS;
      while (emulatorSerial(record.slot) !== undefined) {
        if (Date.now() > until) {
          throw new LiveTestRefusal(
            `The emulator ${serial} (${record.slot}) is still running. Close it with device_close, then run stop again.`,
          );
        }
        await NodeTimersPromises.setTimeout(500);
      }
    }
    const runner = avdRunner(record.slot);
    if (runner !== undefined) {
      // Kept claimed: deleting an AVD under a running emulator would hand the next tester a broken slot.
      throw new LiveTestRefusal(
        `Process ${runner}, which this script did not start, still runs the AVD ${record.slot}, so the slot stays claimed. Close it with device_close, then run stop again.`,
      );
    }
    const deleted = NodeChildProcess.spawnSync(avdmanager, ["delete", "avd", "-n", record.slot], {
      encoding: "utf8",
    });
    if (deleted.status !== 0 && !/no avd/i.test(`${deleted.stdout}${deleted.stderr}`)) {
      throw new LiveTestRefusal(`Deleting the AVD ${record.slot} failed:\n${deleted.stderr}`);
    }
    console.log(`Emulator ${record.slot}: SHUT DOWN AND DELETED`);
  }
  releaseSlot({
    directory: claimsDirectory(NodeOS.homedir()),
    platform: record.platform,
    slot: record.slot,
    worktree: paths.worktree,
  });
  NodeFS.rmSync(mobileFiles(paths).record, { force: true });
}

export function mobileStatus(paths: LiveTestPaths): string | undefined {
  const record = readMobileRecord(paths);
  if (record === undefined) return undefined;
  const state = (running: boolean) => (running ? "RUNNING" : "STOPPED");
  return `${formatMobile(paths, record)}
  Metro: ${state(isOurs(paths, record.metro))}${
    record.platform === "ios"
      ? `   Tunnel: ${state(isOurs(paths, record.tunnel))}`
      : `   Emulator: ${state(isOurs(paths, record.emulator))}`
  }`;
}
