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
/** Time rules of a scheduled or recurring propose_task (platform TaskSchedule, design §5.1/§8.1/§11):
 * a light check of the same shapes the platform accepts, so that a malformed rule is corrected by the
 * model before any request; the platform still validates fully (cron syntax, the 15-minute minimum
 * interval, a next run existing) and answers task_plan_schedule_invalid. */

export const TRIGGER_TYPES = ["once", "recurring"] as const;
export const REPEAT_RULES = ["daily", "weekdays", "weekly", "monthly", "cron"] as const;
/** Fields of a schedule, as the request body carries them. */
export const SCHEDULE_KEYS = [
  "trigger_type",
  "run_at",
  "repeat_rule",
  "time_of_day",
  "weekdays",
  "month_days",
  "cron",
  "timezone",
  "end_at",
  "max_runs"
] as const;
/** Zone the times are shown in when the request names none (the platform's default zone). */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
/** Shortest interval between two runs the platform allows. */
export const MIN_INTERVAL_MINUTES = 15;

/** The schedule fields a request carries (as the platform's proposeRequest names them). */
export interface Schedule {
  trigger_type?: (typeof TRIGGER_TYPES)[number];
  run_at?: number | string;
  repeat_rule?: (typeof REPEAT_RULES)[number];
  time_of_day?: string;
  weekdays?: string;
  month_days?: string;
  cron?: string;
  timezone?: string;
  end_at?: number | string;
  max_runs?: number;
}

/** Fields each kind of rule takes; any other schedule field is a mistake the model must fix. */
const ONCE_KEYS: readonly string[] = ["trigger_type", "run_at", "timezone"];
const RECURRING_KEYS: Readonly<Record<(typeof REPEAT_RULES)[number], readonly string[]>> = {
  daily: ["time_of_day"],
  weekdays: ["time_of_day"],
  weekly: ["time_of_day", "weekdays"],
  monthly: ["time_of_day", "month_days"],
  cron: ["cron"]
};
const RECURRING_COMMON = ["trigger_type", "repeat_rule", "timezone", "end_at", "max_runs"];

const TIME_OF_DAY = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DAY_LIST = /^\s*\d{1,2}\s*(,\s*\d{1,2}\s*)*$/;
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$|^[+-]\d{2}:\d{2}$/;
const CRON_FIELD = /^[0-9A-Za-z*?/,\-#LW]{1,32}$/;
const MAX_RUNS = /^[1-9]\d{0,8}$/;

const present = (value: unknown) =>
  value !== undefined && value !== null && !(typeof value === "string" && !value.trim());

function days(value: unknown, max: number): boolean {
  if (typeof value !== "string" || !DAY_LIST.test(value)) return false;
  return value.split(",").every(part => {
    const day = Number(part.trim());
    return day >= 1 && day <= max;
  });
}

/** A cron minute field that obviously fires more often than every MIN_INTERVAL_MINUTES minutes (the
 * platform checks the actual runs). */
function tooFrequent(minute: string): boolean {
  if (minute === "*" || minute === "?") return true;
  const step = /^(?:\*|\d{1,2}(?:-\d{1,2})?)\/(\d{1,2})$/.exec(minute);
  if (step) return Number(step[1]) < MIN_INTERVAL_MINUTES;
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(minute);
  if (range) return Number(range[2]) > Number(range[1]);
  if (/^\d{1,2}(,\d{1,2})+$/.test(minute)) {
    const sorted = minute
      .split(",")
      .map(Number)
      .sort((a, b) => a - b);
    return sorted.some((value, i) => i > 0 && value - sorted[i - 1]! < MIN_INTERVAL_MINUTES);
  }
  return false;
}

function cronProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 64)
    return "cron must be 5 fields (minute hour day month weekday) or 6 (with seconds first)";
  const fields = value.trim().split(/\s+/);
  if ((fields.length !== 5 && fields.length !== 6) || !fields.every(f => CRON_FIELD.test(f)))
    return "cron must be 5 fields (minute hour day month weekday) or 6 (with seconds first)";
  if (fields.length === 6 && !/^\d{1,2}$/.test(fields[0]!))
    return "the seconds field of a 6-field cron must be one number";
  if (tooFrequent(fields.length === 6 ? fields[1]! : fields[0]!))
    return `runs must be at least ${MIN_INTERVAL_MINUTES} minutes apart`;
  return null;
}

/**
 * Check the schedule fields of one propose_task call. `parseTime` reads run_at / end_at (13-digit
 * milliseconds or `yyyy-MM-dd HH:mm`). Returns the fields to send, the reason for the model, or
 * undefined when the call has no schedule (an ordinary task).
 */
export function scheduleArguments(
  args: Readonly<Record<string, unknown>>,
  parseTime: (value: unknown) => number | string | null
): { readonly schedule: Schedule } | { readonly problem: string } | undefined {
  const given = SCHEDULE_KEYS.filter(key => present(args[key]));
  if (!given.length) return undefined;
  const type = args.trigger_type;
  if (!present(type))
    return {
      problem: `${given.join(", ")} need trigger_type (once for one future time, recurring for a repeating rule)`
    };
  if (!(TRIGGER_TYPES as readonly string[]).includes(type as string))
    return { problem: `trigger_type must be ${TRIGGER_TYPES.join(" or ")}` };
  let allowed: readonly string[];
  if (type === "once") {
    allowed = ONCE_KEYS;
    if (!present(args.run_at)) return { problem: "a once task needs run_at" };
  } else {
    const rule = args.repeat_rule;
    if (!(REPEAT_RULES as readonly string[]).includes(rule as string))
      return { problem: `a recurring task needs repeat_rule: one of ${REPEAT_RULES.join(", ")}` };
    allowed = [...RECURRING_COMMON, ...RECURRING_KEYS[rule as (typeof REPEAT_RULES)[number]]];
  }
  const stray = given.filter(key => !allowed.includes(key));
  if (stray.length)
    return {
      problem: `${stray.join(", ")} ${stray.length > 1 ? "do" : "does"} not apply to ${type === "once" ? "a once task" : `repeat_rule ${String(args.repeat_rule)}`}`
    };
  const schedule: Schedule = { trigger_type: type as (typeof TRIGGER_TYPES)[number] };
  for (const key of ["run_at", "end_at"] as const) {
    if (!present(args[key])) continue;
    const time = parseTime(args[key]);
    if (time === null)
      return {
        problem: `${key} must be yyyy-MM-dd HH:mm (e.g. 2026-10-31 18:00) or a 13-digit millisecond timestamp`
      };
    schedule[key] = time;
  }
  if (type === "recurring") {
    const rule = args.repeat_rule as (typeof REPEAT_RULES)[number];
    schedule.repeat_rule = rule;
    if (rule === "cron") {
      const problem = cronProblem(args.cron);
      if (problem) return { problem };
      schedule.cron = (args.cron as string).trim();
    } else {
      if (typeof args.time_of_day !== "string" || !TIME_OF_DAY.test(args.time_of_day.trim()))
        return { problem: "time_of_day must be HH:mm (24-hour, e.g. 09:00)" };
      schedule.time_of_day = args.time_of_day.trim();
    }
    if (rule === "weekly") {
      if (!days(args.weekdays, 7))
        return {
          problem: "weekdays must list days 1-7 separated by commas (1 = Monday, 7 = Sunday)"
        };
      schedule.weekdays = (args.weekdays as string).replace(/\s+/g, "");
    }
    if (rule === "monthly") {
      if (!days(args.month_days, 31))
        return { problem: "month_days must list days 1-31 separated by commas" };
      schedule.month_days = (args.month_days as string).replace(/\s+/g, "");
    }
    if (present(args.max_runs)) {
      const runs = String(args.max_runs).trim();
      if (!MAX_RUNS.test(runs)) return { problem: "max_runs must be a whole number of at least 1" };
      schedule.max_runs = Number(runs);
    }
  }
  if (present(args.timezone)) {
    if (typeof args.timezone !== "string" || !TIMEZONE.test(args.timezone.trim()))
      return { problem: "timezone must be an IANA time zone such as Asia/Shanghai" };
    schedule.timezone = args.timezone.trim();
  }
  return { schedule: Object.freeze(schedule) };
}

/** `millis` as `yyyy-MM-dd HH:mm` in `timezone` (DEFAULT_TIMEZONE when absent or unknown here), with
 * the zone named. */
export function formatFireTime(millis: number, timezone: string | undefined): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(new Date(millis))
      .reduce<Record<string, string>>((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  let zone = timezone ?? DEFAULT_TIMEZONE;
  let parts: Record<string, string>;
  try {
    parts = format(zone);
  } catch {
    zone = DEFAULT_TIMEZONE;
    parts = format(zone);
  }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${zone})`;
}
