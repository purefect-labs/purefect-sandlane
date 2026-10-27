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
/** Conversation files staged into a sandbox's workspace (`<workspace>/inputs/`): the limits and
 * the file name rule shared by the Worker, which names and downloads the files, and the sandbox,
 * which checks them again before writing. A safe name is one path component of a conservative
 * ASCII charset, so it can never traverse, hide or address another directory. */

/** Directory under the sandbox workspace that receives the files. */
export const INPUT_DIRECTORY = "inputs";
/** Reserved name of the manifest (original names, types, load state) inside the directory. */
export const INPUT_MANIFEST = "manifest.json";
/** One file. */
export const INPUT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** All files of one Run together, the manifest excluded. */
export const INPUT_TOTAL_MAX_BYTES = 40 * 1024 * 1024;
/** Manifest entries (loaded or not) of one Run. */
export const INPUT_MAX_FILES = 50;
export const INPUT_MANIFEST_MAX_BYTES = 256 * 1024;
/** Longest safe name (it must also fit a 100-byte tar name with the directory prefix). */
export const INPUT_NAME_MAX_LENGTH = 80;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One path component: starts with a letter or digit, then letters, digits, `.`, `_`, `-`; no
 * `..`, no trailing dot, at most INPUT_NAME_MAX_LENGTH characters. */
export function isSafeInputName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= INPUT_NAME_MAX_LENGTH &&
    SAFE_NAME.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".")
  );
}
