/*
 * Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/** Files a Run's CLI generates under the sandbox workspace (`<workspace>/outputs/`): the limits,
 * the name rule and the rejection reasons shared by the sandbox, which reads the files out, and
 * the Worker, which checks and reports them. Unlike input names (chosen by the Worker), output
 * names are chosen by the model and shown to the user, so any script is allowed; the rule only
 * keeps a name one harmless path component. */

/** Directory under the sandbox workspace that the CLI writes deliverable files to. */
export const OUTPUT_DIRECTORY = "outputs";
/** Longest name (UTF-16 code units, as the control plane counts them). */
export const OUTPUT_NAME_MAX_LENGTH = 80;

/** Defaults of the sandbox's limits per Run; deployments may lower or (up to the ceilings) raise
 * them. */
export const OUTPUT_MAX_FILES = 10;
export const OUTPUT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const OUTPUT_TOTAL_MAX_BYTES = 30 * 1024 * 1024;
/** Ceilings of the limits: the control plane accepts at most 10 files of 10 MiB per Run, and the
 * whole set is held in memory once on its way out. */
export const OUTPUT_MAX_FILES_CEILING = 10;
export const OUTPUT_FILE_MAX_BYTES_CEILING = 10 * 1024 * 1024;
export const OUTPUT_TOTAL_MAX_BYTES_CEILING = 64 * 1024 * 1024;
/** Rejected entries reported per Run; further ones are dropped (a model that writes hundreds of
 * entries must not turn into hundreds of control plane calls). */
export const OUTPUT_MAX_REJECTED = 32;

/** Why a generated file was not delivered (the control plane's `rejected` codes). */
export const OUTPUT_REJECTIONS = [
  "too_large",
  "too_many",
  "type_not_allowed",
  "content_mismatch",
  "macro",
  "not_regular_file",
  "invalid_name",
  "upload_failed"
] as const;
export type OutputRejection = (typeof OUTPUT_REJECTIONS)[number];

export interface OutputLimits {
  readonly maxFiles: number;
  readonly fileMaxBytes: number;
  readonly totalMaxBytes: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = Object.freeze({
  maxFiles: OUTPUT_MAX_FILES,
  fileMaxBytes: OUTPUT_FILE_MAX_BYTES,
  totalMaxBytes: OUTPUT_TOTAL_MAX_BYTES
});

/** Whether `limits` lie within the ceilings (each at least 1). */
export function validOutputLimits(limits: OutputLimits): boolean {
  const within = (value: unknown, max: number) =>
    Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= max;
  return (
    within(limits.maxFiles, OUTPUT_MAX_FILES_CEILING) &&
    within(limits.fileMaxBytes, OUTPUT_FILE_MAX_BYTES_CEILING) &&
    within(limits.totalMaxBytes, OUTPUT_TOTAL_MAX_BYTES_CEILING)
  );
}

/** Control characters, path separators and the Unicode line/paragraph separators. */
const FORBIDDEN = /[\u0000-\u001f\u007f/\\\u2028\u2029]/;

/** No lone surrogates: the name must survive UTF-8 encoding unchanged. */
function wellFormed(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

/** One path component the user can see: 1..OUTPUT_NAME_MAX_LENGTH code units of well-formed
 * text, no separators or control characters, not hidden or option-like (leading `.` or `-`), no
 * leading or trailing blank and no trailing dot. `.` and `..` are excluded by the leading-dot
 * rule. */
export function isSafeOutputName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= OUTPUT_NAME_MAX_LENGTH &&
    wellFormed(value) &&
    !FORBIDDEN.test(value) &&
    !/^[.\-\s]/.test(value) &&
    !/[.\s]$/.test(value)
  );
}

/** A name that can be shown for a rejected entry whose real name may be unsafe: forbidden
 * characters replaced, cut to the length limit, never empty. Display only, never a path. */
export function reportableOutputName(value: string): string {
  // A lone surrogate does not survive UTF-8 encoding: it becomes U+FFFD.
  const cleaned = Buffer.from(value, "utf8")
    .toString("utf8")
    .replace(new RegExp(FORBIDDEN.source, "g"), "_")
    .trim();
  const cut = [...cleaned].reduce(
    (text, char) => (text.length + char.length <= OUTPUT_NAME_MAX_LENGTH ? text + char : text),
    ""
  );
  return cut || "file";
}

export function isOutputRejection(value: unknown): value is OutputRejection {
  return typeof value === "string" && (OUTPUT_REJECTIONS as readonly string[]).includes(value);
}
