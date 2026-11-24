#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a one-shot advance script; synchronous Node APIs keep it small.
// D25 rebrands upstream's English source strings, and gt-i18n keys each string by its text, so a
// rebranded string loses upstream's translations. Run after `vp run i18n:generate` at every advance:
// each locale keeps its translation of an unchanged key, and a rebranded key gets upstream's
// translation of the old key with T3 swapped for J5. Keys en.json no longer has are dropped.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import phrases from "./rekey-branded-translations.phrases.json" with { type: "json" };

type Catalog = Record<string, unknown>;

export const APPS = ["apps/web", "apps/mobile", "apps/desktop"] as const;

// Names J5 keeps as upstream's: products J5 doesn't rebrand, and upstream's env names.
const KEPT = [
  { english: "T3 Connect", translated: /T3([ -]?Connect)/g },
  { english: "T3 Chat", translated: /T3( Chat)/g },
  { english: "T3CODE_", translated: /T3(CODE_)/g },
];

interface Phrase {
  readonly upstream: string;
  readonly j5: string;
}

/**
 * Sentences J5 rewrote beyond the brand, with each locale's upstream and J5 wording, so their
 * translations carry over too. Add one when the script reports an upstream string left English.
 */
export const PHRASES: ReadonlyArray<{
  readonly english: Phrase;
  readonly locales: Readonly<Record<string, Phrase>>;
}> = phrases;

const withJ5Phrases = (english: string) =>
  PHRASES.reduce(
    (text, { english: phrase }) => text.replaceAll(phrase.upstream, phrase.j5),
    english,
  );

// "J5 Code" and "J5" both stand for a bare "T3", and `j5 <version>` for `t3@<version>`.
const brandFree = (text: string) =>
  text.replace(
    /npx t3(?:@latest)?|\bt3@|\b[tj][35]code\b|(?:\bT3|\bJ5)(?: Code)?|\bt3\b|\bj5\b/g,
    (match) => (match === "t3@" ? "\u0000 " : "\u0000"),
  );

/** Upstream's key for a J5 English string that differs from upstream's in its brand and `PHRASES`. */
export function upstreamKeyOf(newText: string, upstream: Catalog): string | undefined {
  const target = brandFree(newText);
  const matches = Object.entries(upstream).filter(
    ([, text]) =>
      /t3|T3/.test(JSON.stringify(text)) &&
      brandFree(withJ5Phrases(JSON.stringify(text))) === target,
  );
  return matches.length === 1 ? matches[0]![0] : undefined;
}

/** Swap T3 for J5 in a translation the way the English source changed, keeping the names J5 keeps. */
export function rebrandTranslation(
  translation: string,
  oldEnglish: string,
  newEnglish: string,
  locale?: string,
) {
  const kept: string[] = [];
  let text = translation;
  for (const { english, locales } of PHRASES) {
    const phrase = locale === undefined ? undefined : locales[locale];
    if (phrase === undefined || !oldEnglish.includes(english.upstream)) continue;
    if (newEnglish.includes(english.j5)) text = text.replaceAll(phrase.upstream, phrase.j5);
  }
  for (const { english, translated } of KEPT) {
    if (!newEnglish.includes(english)) continue;
    text = text.replace(translated, (_match, rest: string) => {
      kept.push(`T3${rest}`);
      return `\u0001${kept.length - 1}\u0001`;
    });
  }
  if (oldEnglish.includes("npx t3") && !newEnglish.includes("npx t3")) {
    text = text.replace(/npx t3(?:@latest)?/g, "j5");
  }
  if (/\bt3code\b/.test(oldEnglish) && !/\bt3code\b/.test(newEnglish)) {
    text = text.replace(/\bt3code\b/g, "j5code");
  }
  if (oldEnglish.includes("t3@") && !newEnglish.includes("t3@")) {
    text = text.replaceAll("t3@", "j5 ");
  }
  if (/\bt3\b/.test(oldEnglish) && !/\bt3\b/.test(newEnglish)) {
    // A bare `t3` the English turned into `j5code`, such as a branch prefix, says `j5code` here too.
    const j5 = /\bj5code\b/.test(newEnglish) && !/\bt3code\b/.test(oldEnglish) ? "j5code" : "j5";
    text = text.replace(/\bt3\b/g, j5);
  }
  text = text.replace(/(?<![A-Za-z0-9])T3/g, "J5");
  return text.replace(/\u0001(\d+)\u0001/g, (_match, index: string) => kept[Number(index)]!);
}

const readJson = (file: string): Catalog => JSON.parse(NodeFS.readFileSync(file, "utf8"));
const writeJson = (file: string, catalog: Catalog) =>
  NodeFS.writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);

function gitJson(root: string, ref: string, path: string): Catalog {
  const text = NodeChildProcess.execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(text);
}

/** Rewrite one locale catalog against the regenerated en.json and upstream's catalogs at the pin. */
export function rekeyLocale(input: {
  readonly english: Catalog;
  readonly locale: Catalog;
  readonly upstreamEnglish: Catalog;
  readonly upstreamLocale: Catalog;
  readonly localeName?: string;
}): {
  readonly catalog: Catalog;
  readonly carried: number;
  readonly missing: string[];
  /** Keys whose English fallback stays: J5's own wording, or a rewrite `PHRASES` lacks. */
  readonly leftEnglish: string[];
} {
  const catalog: Catalog = {};
  const missing: string[] = [];
  const leftEnglish: string[] = [];
  let carried = 0;
  for (const [key, english] of Object.entries(input.english)) {
    const newEnglish = JSON.stringify(english);
    // `gt generate` fills a key it has not seen with the English text; that is not a translation.
    const kept =
      Object.hasOwn(input.locale, key) &&
      (Object.hasOwn(input.upstreamLocale, key) ||
        JSON.stringify(input.locale[key]) !== newEnglish);
    if (kept) {
      catalog[key] = input.locale[key];
      continue;
    }
    if (Object.hasOwn(input.upstreamLocale, key)) {
      catalog[key] = input.upstreamLocale[key];
      continue;
    }
    const oldKey = upstreamKeyOf(newEnglish, input.upstreamEnglish);
    if (oldKey === undefined || !Object.hasOwn(input.upstreamLocale, oldKey)) {
      if (Object.hasOwn(input.locale, key)) {
        catalog[key] = input.locale[key];
        leftEnglish.push(key);
      } else missing.push(key);
      continue;
    }
    const translated = rebrandTranslation(
      JSON.stringify(input.upstreamLocale[oldKey]),
      JSON.stringify(input.upstreamEnglish[oldKey]),
      newEnglish,
      input.localeName,
    );
    catalog[key] = JSON.parse(translated);
    carried += 1;
  }
  return { catalog, carried, missing, leftEnglish };
}

/** The pinned upstream release (FORK.md case 59), whose catalogs hold the keys before the rebrand. */
const pinnedUpstreamTag = (root: string) => {
  const source = NodeFS.readFileSync(
    NodePath.join(root, "apps/server/src/j5/upstreamVersion.ts"),
    "utf8",
  );
  const version = /J5_UPSTREAM_T3_CODE_VERSION = "([^"]+)"/.exec(source)?.[1];
  if (version === undefined)
    throw new Error("No J5_UPSTREAM_T3_CODE_VERSION in upstreamVersion.ts");
  return `v${version}`;
};

function main() {
  const args = process.argv.slice(2);
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const refIndex = args.indexOf("--ref");
  const ref = refIndex === -1 ? pinnedUpstreamTag(root) : args[refIndex + 1]!;
  const untranslated: string[] = [];
  const leftInEnglish = new Set<string>();
  for (const app of APPS) {
    const config = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, app, "gt.config.json"), "utf8"),
    );
    const catalogDir = NodePath.join(app, NodePath.dirname(config.files.gt.output));
    const catalogPath = (locale: string) => NodePath.join(catalogDir, `${locale}.json`);
    const english = readJson(NodePath.join(root, catalogPath(config.defaultLocale)));
    const upstreamEnglish = gitJson(root, ref, catalogPath(config.defaultLocale));
    let carried = 0;
    for (const locale of config.locales as string[]) {
      const file = NodePath.join(root, catalogPath(locale));
      const result = rekeyLocale({
        english,
        locale: readJson(file),
        upstreamEnglish,
        upstreamLocale: gitJson(root, ref, catalogPath(locale)),
        localeName: locale,
      });
      writeJson(file, result.catalog);
      carried += result.carried;
      for (const key of result.leftEnglish) {
        leftInEnglish.add(`${app} ${key} ${JSON.stringify(english[key])}`);
      }
      for (const key of result.missing) {
        untranslated.push(`${app} ${locale} ${key} ${JSON.stringify(english[key])}`);
      }
    }
    console.log(`${app}: carried ${carried} rebranded translations from ${ref}`);
  }
  if (leftInEnglish.size > 0) {
    console.warn(
      `Left in English in every locale (J5's own wording, or add a rewrite to PHRASES):\n${[...leftInEnglish].join("\n")}`,
    );
  }
  if (untranslated.length > 0) {
    console.error(`No upstream translation for:\n${untranslated.join("\n")}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
