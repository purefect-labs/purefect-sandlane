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
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_OUTPUT_LIMITS,
  isSafeOutputName,
  reportableOutputName
} from "../dist/common/output-files.js";
import {
  LIST_COMMAND,
  archiveCommand,
  archiveLimit,
  collectOutputs,
  decodeOutputs,
  encodeOutputs,
  parseArchive,
  parseListing,
  planOutputs
} from "../dist/sandbox/docker/session-outputs.js";

const MiB = 1024 * 1024;

/** find -printf "%d %y %s %P\0" records. */
function listing(entries, directory = "d") {
  const records = [`1 ${directory} 4096 outputs`];
  for (const [type, size, name] of entries) records.push(`2 ${type} ${size} outputs/${name}`);
  return Buffer.concat(records.map(record => Buffer.from(`${record}\0`)));
}

/** One ustar header block (POSIX magic) for `name` (bytes may be any UTF-8, at most 100). */
function header(name, size, type = "0", { magic = "ustar\u000000", prefix = "" } = {}) {
  const block = Buffer.alloc(512);
  Buffer.from(name).copy(block, 0, 0, 100);
  block.write("0000644\u0000", 100, "ascii");
  block.write("0001750\u0000", 108, "ascii");
  block.write("0001750\u0000", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\u0000`, 124, "ascii");
  block.write("00000000000\u0000", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(type, 156, "ascii");
  block.write(magic, 257, "latin1");
  Buffer.from(prefix).copy(block, 345, 0, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, "ascii");
  return block;
}

function padded(data) {
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([data, Buffer.alloc(pad)]);
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length++;
  return `${length}${body}`;
}

/** An archive of entries {name, data?, type?, pax?}; ends with two zero blocks. */
function archive(entries, options = {}) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    if (entry.pax) {
      const records = Buffer.from(
        Object.entries(entry.pax)
          .map(([key, value]) => paxRecord(key, value))
          .join("")
      );
      parts.push(header("./PaxHeaders/x", records.length, "x"), padded(records));
    }
    parts.push(
      header(entry.name, data.length, entry.type ?? "0", { ...options, prefix: entry.prefix }),
      padded(data)
    );
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

test("output names: one visible component, any script, nothing hidden or traversing", () => {
  for (const good of ["月报.xlsx", "report 2026.pdf", "a", "x".repeat(80), "Q1_销售-汇总.csv"])
    assert.equal(isSafeOutputName(good), true, good);
  for (const bad of [
    "",
    ".",
    "..",
    ".hidden",
    "-rf",
    "a/b",
    "a\\b",
    "../x",
    "x\u0000y",
    "x\ny",
    "tab\there",
    "x.",
    " x",
    "x ",
    "x".repeat(81),
    "\ud800.txt",
    undefined
  ])
    assert.equal(isSafeOutputName(bad), false, JSON.stringify(bad));
  assert.equal(reportableOutputName("../a/b\nc"), ".._a_b_c");
  assert.equal(reportableOutputName(""), "file");
  assert.equal(reportableOutputName("界".repeat(100)).length, 80);
});

test("listing: no directory, a symlinked directory, and invalid or cut records", () => {
  assert.deepEqual(parseListing(Buffer.alloc(0)), { directory: false, entries: [] });
  // outputs -> elsewhere: find -P does not descend it, and nothing is collected.
  assert.equal(parseListing(listing([], "l")).directory, false);
  assert.deepEqual(parseListing(listing([["f", 3, "a.txt"]], "f")).entries, []);
  const parsed = parseListing(
    Buffer.concat([
      listing([
        ["f", 5, "月报.pdf"],
        ["l", 9, "link.pdf"],
        ["d", 4096, "dir"]
      ]),
      Buffer.from("2 f 1 outputs/"),
      Buffer.from([0xff, 0xfe, 0]),
      // A record cut by the byte cap is dropped.
      Buffer.from("2 f 1 outputs/partial")
    ])
  );
  assert.equal(parsed.directory, true);
  assert.deepEqual(
    parsed.entries.map(entry => [entry.name, entry.type, entry.size]),
    [
      ["月报.pdf", "f", 5],
      ["link.pdf", "l", 9],
      ["dir", "d", 4096],
      [undefined, "f", 1]
    ]
  );
  assert.equal(parsed.entries[3].display, "\ufffd\ufffd");
  assert.throws(() => parseListing(Buffer.from("garbage\0")), { code: "OUTPUTS_FAILED" });
  assert.throws(() => parseListing(Buffer.from("2 f 1 inputs/a\0")), { code: "OUTPUTS_FAILED" });
});

test("plan: only safe regular files, within the per-file, count and total limits", () => {
  const limits = { maxFiles: 3, fileMaxBytes: 10 * MiB, totalMaxBytes: 15 * MiB };
  const plan = planOutputs(
    parseListing(
      listing([
        ["f", 1, "a.csv"],
        ["f", 11 * MiB, "b-huge.pdf"],
        ["f", 8 * MiB, "c.pdf"],
        ["f", 8 * MiB, "d.pdf"],
        ["f", 1, "e.txt"],
        ["f", 1, "f.txt"],
        ["l", 1, "g.pdf"],
        ["d", 4096, "h"],
        ["p", 0, "i"],
        ["f", 1, ".hidden"],
        ["f", 1, "-x"]
      ])
    ),
    limits
  );
  assert.deepEqual(plan.selected, [
    { name: "a.csv", size: 1 },
    { name: "c.pdf", size: 8 * MiB },
    { name: "e.txt", size: 1 }
  ]);
  assert.deepEqual(Object.fromEntries(plan.rejected.map(item => [item.name, item.reason])), {
    "-x": "invalid_name",
    ".hidden": "invalid_name",
    "b-huge.pdf": "too_large",
    "d.pdf": "too_large",
    "f.txt": "too_many",
    "g.pdf": "not_regular_file",
    h: "not_regular_file",
    i: "not_regular_file"
  });
  // Hundreds of entries: at most 32 reported.
  const many = planOutputs(
    parseListing(listing(Array.from({ length: 200 }, (_, i) => ["d", 1, `d${i}`]))),
    DEFAULT_OUTPUT_LIMITS
  );
  assert.equal(many.rejected.length, 32);
  assert.ok(archiveLimit(plan) >= 8 * MiB + 2 + 3 * 512);
});

test("commands: no shell, exact names after --, never recursive", () => {
  assert.equal(LIST_COMMAND[0], "find");
  assert.ok(LIST_COMMAND.includes("-maxdepth"));
  const command = archiveCommand(["月报.xlsx", "a b.pdf"]);
  assert.deepEqual(command.slice(0, 9), [
    "tar",
    "-c",
    "-f",
    "-",
    "--format=pax",
    "--no-recursion",
    "-C",
    "/workspace/outputs",
    "--"
  ]);
  assert.deepEqual(command.slice(9), ["月报.xlsx", "a b.pdf"]);
  assert.throws(() => archiveCommand(["../x"]));
  assert.throws(() => archiveCommand([]));
});

test("archive: regular files only; links, directories, devices and foreign paths are refused", () => {
  const long = "季度销售汇总".repeat(10) + ".xlsx";
  const entries = parseArchive(
    archive([
      { name: "a.csv", data: "x,y\n" },
      { name: "./PaxHeaders/ignored", data: "PK", pax: { path: long, mtime: "1.5" } },
      { name: "link.pdf", type: "2" },
      { name: "hard.pdf", type: "1" },
      { name: "dir", type: "5" },
      { name: "dev", type: "3" },
      { name: "../escape.txt", data: "no" },
      { name: "nested.txt", prefix: "sub", data: "no" }
    ])
  );
  assert.deepEqual(
    entries.map(entry => [entry.name, entry.type, entry.data.toString()]),
    [
      ["a.csv", "0", "x,y\n"],
      [long, "0", "PK"],
      ["link.pdf", "2", ""],
      ["hard.pdf", "1", ""],
      ["dir", "5", ""],
      ["dev", "3", ""],
      ["../escape.txt", "0", "no"],
      ["sub/nested.txt", "0", "no"]
    ]
  );
  const plan = {
    selected: [
      { name: "a.csv", size: 4 },
      { name: long, size: 2 },
      { name: "link.pdf", size: 0 },
      { name: "hard.pdf", size: 0 },
      { name: "gone.txt", size: 1 }
    ],
    rejected: []
  };
  const collected = collectOutputs(plan, entries, DEFAULT_OUTPUT_LIMITS);
  assert.deepEqual(
    collected.files.map(file => [file.name, file.data.toString()]),
    [
      ["a.csv", "x,y\n"],
      [long, "PK"]
    ]
  );
  assert.deepEqual(
    collected.rejected.map(item => [item.name, item.reason]),
    [
      ["dir", "invalid_name"],
      ["dev", "invalid_name"],
      [".._escape.txt", "invalid_name"],
      ["sub_nested.txt", "invalid_name"],
      ["link.pdf", "not_regular_file"],
      ["hard.pdf", "not_regular_file"],
      ["gone.txt", "not_regular_file"]
    ]
  );
  // A file grown past the limits after the listing is refused, not returned.
  const grown = collectOutputs(
    { selected: [{ name: "a.csv", size: 1 }], rejected: [] },
    parseArchive(archive([{ name: "a.csv", data: "x".repeat(20) }])),
    { maxFiles: 1, fileMaxBytes: 10, totalMaxBytes: 10 }
  );
  assert.deepEqual(grown, { files: [], rejected: [{ name: "a.csv", reason: "too_large" }] });
});

test("archive: bad checksums, GNU headers, truncation and vendor types fail as a whole", () => {
  const good = archive([{ name: "a.txt", data: "abc" }]);
  const corrupt = Buffer.from(good);
  corrupt[0] ^= 1;
  assert.throws(() => parseArchive(corrupt), { code: "OUTPUTS_FAILED" });
  assert.throws(() => parseArchive(archive([{ name: "a.txt" }], { magic: "ustar  \u0000" })), {
    code: "OUTPUTS_FAILED"
  });
  assert.throws(() => parseArchive(good.subarray(0, 700)), { code: "OUTPUTS_FAILED" });
  assert.throws(() => parseArchive(good.subarray(0, 1024)), { code: "OUTPUTS_FAILED" });
  assert.throws(() => parseArchive(archive([{ name: "././@LongLink", type: "L", data: "x" }])), {
    code: "OUTPUTS_FAILED"
  });
  assert.throws(
    () =>
      parseArchive(
        archive([{ name: "a", data: "x", pax: { path: "\u0000" } }]).fill(0x41, 520, 524)
      ),
    { code: "OUTPUTS_FAILED" }
  );
});

test("archive: the system tar's pax output parses (names with spaces and CJK, symlinks)", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandlane-outputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "outputs");
  await mkdir(dir);
  const long = "季度销售汇总".repeat(10) + ".xlsx";
  await writeFile(path.join(dir, "a b.csv"), "x,y\n");
  await writeFile(path.join(dir, long), Buffer.alloc(70_000, 7));
  await symlink("/etc/passwd", path.join(dir, "link.txt"));
  let tar;
  try {
    tar = execFileSync(
      "tar",
      [
        "-c",
        "-f",
        "-",
        "--format=pax",
        "--no-recursion",
        "-C",
        dir,
        "--",
        "a b.csv",
        long,
        "link.txt"
      ],
      { maxBuffer: 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: "1" } }
    );
  } catch {
    t.skip("tar with pax support not available");
    return;
  }
  const entries = parseArchive(tar);
  assert.deepEqual(
    entries.map(entry => [entry.name, entry.type, entry.data.length]),
    [
      ["a b.csv", "0", 4],
      [long, "0", 70_000],
      ["link.txt", "2", 0]
    ]
  );
  assert.ok(entries[1].data.every(byte => byte === 7));
});

test("reply wire format round-trips; forged headers are refused", () => {
  const outputs = {
    files: [
      { name: "月报.xlsx", data: Buffer.from("PK\u0003\u0004") },
      { name: "empty.txt", data: Buffer.alloc(0) }
    ],
    rejected: [{ name: "link.pdf", reason: "not_regular_file" }]
  };
  const decoded = decodeOutputs(Buffer.concat(encodeOutputs(outputs)));
  assert.deepEqual(
    decoded.files.map(file => [file.name, file.data.toString("latin1")]),
    [
      ["月报.xlsx", "PK\u0003\u0004"],
      ["empty.txt", ""]
    ]
  );
  assert.deepEqual(decoded.rejected, outputs.rejected);
  const forged = (head, data = Buffer.alloc(0)) => {
    const json = Buffer.from(JSON.stringify(head));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([length, json, data]);
  };
  const bad = [
    forged({ files: [{ name: "../x", size: 1 }], rejected: [] }, Buffer.from("x")),
    forged({ files: [{ name: "a", size: 2 }], rejected: [] }, Buffer.from("x")),
    forged({ files: [{ name: "a", size: 1 }], rejected: [] }, Buffer.from("xy")),
    forged({ files: [], rejected: [{ name: "a", reason: "upload_failed" }] }),
    forged({ files: [], rejected: [{ name: "a/b", reason: "too_many" }] }),
    forged({ files: [], rejected: [], extra: 1 }),
    forged({
      files: [
        { name: "a", size: 0 },
        { name: "a", size: 0 }
      ],
      rejected: []
    }),
    forged({
      files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, size: 0 })),
      rejected: []
    }),
    Buffer.from([0, 0])
  ];
  for (const body of bad) assert.throws(() => decodeOutputs(body), { code: "BROKER_PROTOCOL" });
});
