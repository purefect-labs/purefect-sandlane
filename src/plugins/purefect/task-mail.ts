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
/** Mail trigger of a propose_task (platform design assignment-and-scheduled-tasks.md §20, MailTrigger):
 * a light check of the shapes the platform accepts, so that a malformed whitelist is corrected by the
 * model before any request. The platform enforces the same rules again and never relies on this
 * check: a proposed mail plan always waits for the user's confirmation of each mail (no mode is taken
 * from the model) and must name its senders, even for a person's plan. */

/** Fields of a mail trigger, as the request body carries them. */
export const MAIL_KEYS = [
  "mail_senders",
  "mail_subject_contains",
  "mail_folder",
  "poll_minutes"
] as const;
/** Never taken from the model: the execution mode is fixed by the platform (confirm first). */
export const MAIL_REFUSED_KEYS = ["mail_mode", "mode", "event_config"] as const;
/** The only sender entry that is not an address or a domain: the tenant's own members. */
export const MEMBERS = "members";
export const MAX_SENDERS = 50;
export const MIN_POLL_MINUTES = 5;
export const MAX_POLL_MINUTES = 60;
const MAX_SUBJECT_CONTAINS = 100;
const MAX_FOLDER = 200;
const MAX_ENTRY = 254;

/** As the platform's MailTrigger: a domain of dot-separated labels, `@domain` or `local@domain`. */
const DOMAIN = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+";
const DOMAIN_ENTRY = new RegExp(`^@${DOMAIN}$`);
const ADDRESS_ENTRY = new RegExp(`^[^@\\s<>"(),;:]{1,64}@${DOMAIN}$`);
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The mail trigger fields a request carries (as the platform's proposeRequest names them). */
export interface MailTrigger {
  trigger_type: "mail";
  mail_senders: readonly string[];
  mail_subject_contains?: string;
  mail_folder?: string;
  poll_minutes?: number;
}

const present = (value: unknown) =>
  value !== undefined && value !== null && !(typeof value === "string" && !value.trim());

/** One whitelist entry, lower-cased; null when it is not a full address, an @domain or members.
 * Wildcards are refused here although the platform would read `*` as an ordinary address
 * character: a model writing `*` means "anyone", which the whitelist must never become. */
export function senderEntry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const entry = value.trim().toLowerCase();
  if (entry === MEMBERS) return entry;
  if (!entry || entry.length > MAX_ENTRY || /[*?]/.test(entry)) return null;
  return DOMAIN_ENTRY.test(entry) || ADDRESS_ENTRY.test(entry) ? entry : null;
}

function singleLine(value: unknown, max: number): string | null | undefined {
  if (!present(value)) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > max || CONTROL.test(text) ? null : text;
}

/**
 * Check the mail trigger fields of one propose_task call: `others` are the call's other trigger
 * fields (time rules, due_at) that must be absent. Returns the fields to send, the reason for the
 * model, or undefined when the call carries no mail trigger and no mail field.
 */
export function mailArguments(
  args: Readonly<Record<string, unknown>>,
  others: readonly string[]
): { readonly mail: MailTrigger } | { readonly problem: string } | undefined {
  const refused = MAIL_REFUSED_KEYS.filter(key => args[key] !== undefined);
  if (refused.length)
    return {
      problem: `${refused.join(", ")} ${refused.length > 1 ? "are" : "is"} not accepted: a mail-triggered task proposed here always waits for the user to confirm each matching mail before it runs (only the user can choose automatic execution, on the plan page)`
    };
  const given = MAIL_KEYS.filter(key => present(args[key]));
  if (args.trigger_type !== "mail") {
    if (!given.length) return undefined;
    return { problem: `${given.join(", ")} only apply to trigger_type mail` };
  }
  const stray = others.filter(key => present(args[key]));
  if (stray.length)
    return {
      problem: `${stray.join(", ")} ${stray.length > 1 ? "do" : "does"} not apply to trigger_type mail (it runs when a mail arrives, not at a time)`
    };
  const list = args.mail_senders;
  if (!Array.isArray(list) || !list.length)
    return {
      problem:
        "a mail-triggered task needs mail_senders: the sender addresses or @domains the user named in this conversation"
    };
  if (list.length > MAX_SENDERS) return { problem: `at most ${MAX_SENDERS} mail_senders` };
  const senders: string[] = [];
  for (const value of list) {
    const entry = senderEntry(value);
    if (entry === null)
      return {
        problem:
          "each of mail_senders must be a full email address (name@example.com), an @domain (@example.com) or members; no wildcards and no empty entries"
      };
    if (!senders.includes(entry)) senders.push(entry);
  }
  const subject = singleLine(args.mail_subject_contains, MAX_SUBJECT_CONTAINS);
  if (subject === null)
    return {
      problem: `mail_subject_contains must be one line of at most ${MAX_SUBJECT_CONTAINS} characters`
    };
  const folder = singleLine(args.mail_folder, MAX_FOLDER);
  if (folder === null)
    return { problem: `mail_folder must be one line of at most ${MAX_FOLDER} characters` };
  let poll: number | undefined;
  if (present(args.poll_minutes)) {
    const text = String(args.poll_minutes).trim();
    poll = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
    if (!(poll >= MIN_POLL_MINUTES && poll <= MAX_POLL_MINUTES))
      return {
        problem: `poll_minutes must be a whole number from ${MIN_POLL_MINUTES} to ${MAX_POLL_MINUTES}`
      };
  }
  return {
    mail: Object.freeze({
      trigger_type: "mail" as const,
      mail_senders: Object.freeze(senders),
      ...(subject ? { mail_subject_contains: subject } : {}),
      ...(folder ? { mail_folder: folder } : {}),
      ...(poll !== undefined ? { poll_minutes: poll } : {})
    })
  };
}
