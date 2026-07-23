import { DomainError } from "../domain/errors.js";
import { DEFAULT_PMM_BRAND_PROFILE } from "./profile.js";

const BAIT = [
  "you won't believe",
  "read this",
  "here's the secret"
] as const;

const LINE_CONTROL = /[\r\n\u0085\u2028\u2029]/u;
const SENTENCE_BOUNDARY = /[.!?\r\n\u0085\u2028\u2029]+/u;
const LEADING_LIST_MARKER = /^[\s]*[•‣◦⁃∙\-–—*+]/u;
const URL = /(?:\b(?:https?:\/\/|www\.)\S+|\b[\p{L}\p{N}](?:[\p{L}\p{N}-]*\.)+(?:com|org|net|io|co|ai|app|dev)(?:\/\S*)?)/iu;
const HASHTAG = /#[\p{L}\p{N}_]/u;
const DIGIT = /\p{N}/u;
const EMOJI_CODE_POINT =
  /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}/gu;

type CoverHookReason =
  | "character_count"
  | "emoji_count"
  | "engagement_bait"
  | "hashtag"
  | "list_marker"
  | "numeric_claim"
  | "post_duplicate"
  | "single_line"
  | "url"
  | "word_count";

function fail(reason: CoverHookReason): never {
  throw new DomainError(
    "VALIDATION_ERROR",
    "Cover hook does not meet the brand rules.",
    { field: "coverHook", reason }
  );
}

function normalizeInline(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function comparisonText(value: string): string {
  return normalizeInline(value)
    .replace(/[.!?]+$/u, "")
    .trim()
    .toLowerCase();
}

function normalizedPostSentences(postText: string): readonly string[] {
  return postText
    .normalize("NFC")
    .split(SENTENCE_BOUNDARY)
    .map(normalizeInline)
    .filter((sentence) => sentence.length > 0);
}

export function validateCoverHook(postText: string, rawHook: string): string {
  if (typeof rawHook !== "string" || LINE_CONTROL.test(rawHook)) {
    fail("single_line");
  }

  const hook = normalizeInline(rawHook);
  const rules = DEFAULT_PMM_BRAND_PROFILE.hookRules;
  const characterCount = [...hook].length;
  if (characterCount === 0 || characterCount > rules.maxCharacters) {
    fail("character_count");
  }

  const wordCount = hook.split(" ").length;
  if (wordCount < rules.minWords || wordCount > rules.maxWords) {
    fail("word_count");
  }

  const lowerHook = hook.toLowerCase();
  if (BAIT.some((phrase) => lowerHook.includes(phrase))) {
    fail("engagement_bait");
  }
  if (URL.test(hook)) {
    fail("url");
  }
  if (HASHTAG.test(hook)) {
    fail("hashtag");
  }
  if (LEADING_LIST_MARKER.test(hook)) {
    fail("list_marker");
  }

  const emojiCount = [...hook.matchAll(EMOJI_CODE_POINT)].length;
  if (emojiCount > 2) {
    fail("emoji_count");
  }
  if (DIGIT.test(hook)) {
    fail("numeric_claim");
  }

  const comparableHook = comparisonText(hook);
  const sentences = normalizedPostSentences(
    typeof postText === "string" ? postText : ""
  );
  if (sentences.some((sentence) => comparisonText(sentence) === comparableHook)) {
    fail("post_duplicate");
  }

  return hook;
}

export function normalizeTopicLabel(rawLabel: string): string {
  return normalizeInline(rawLabel).toUpperCase();
}
