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
import { inspect } from "node:util";
import { parseLease, parseLeaseFiles, readLease } from "../dist/plugins/purefect/contract.js";
import { isSafeInputName, INPUT_MANIFEST } from "../dist/common/input-files.js";
import { DownloadError, downloadFile } from "../dist/core/file-download.js";
import { inputManifest, safeInputName, stageInputFiles } from "../dist/core/input-files.js";
import { FrozenInputContext, inputFilesInstructions } from "../dist/core/turn-input.js";
import { MemoryAdmission, parseMemAvailable } from "../dist/core/admission.js";

const MiB = 1024 * 1024;
const SIGNED = "https://oss.example.test/t/file?Signature=signed-secret-" + "s".repeat(40);
const SECRET = "signed-secret-";

function file(changes = {}) {
  return {
    file_id: "9001",
    name: "季度报表.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 5,
    relation: "input",
    loaded: true,
    url: SIGNED,
    expires_at: Date.now() + 300_000,
    ...changes
  };
}

function lease(files) {
  const now = Date.now();
  return {
    job_id: "101",
    generation: 1,
    lease_until: now + 30000,
    deadline_at: now + 600000,
    run: {
      run_id: "201",
      tenant_id: "7",
      conversation_id: "301",
      execution_profile: "sandbox",
      identity: { user_id: "401", tenant_code: "acme", site: "site-a" },
      input: { prompt: "Hello", history: [] },
      input_digest: "a".repeat(64)
    },
    credentials: {
      agent_token: { value: "agent-token-" + "x".repeat(40), expires_at: now + 60000 },
      model_service: {
        base_uri: "https://models.example.test/v1",
        wire_api: "responses",
        model: "gpt-test",
        api_key: "sk-" + "y".repeat(40)
      },
      ...(files !== undefined ? { files } : {})
    }
  };
}

function rejects(value) {
  let error;
  try {
    parseLeaseFiles(value);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "expected a rejection");
  assert.equal(error.code, "CONTROL_PLANE_PROTOCOL");
  // The rejection never carries the signed URL.
  assert.ok(!`${error.message} ${inspect(error)} ${JSON.stringify(error)}`.includes(SECRET));
}

test("lease files: absent, valid, and URLs kept only for loaded files", () => {
  assert.equal(parseLease(lease()).credentials.files, undefined);
  assert.equal(parseLease(lease([])).credentials.files, undefined);
  const parsed = parseLease(
    lease([
      file(),
      file({ file_id: "9002", loaded: false, url: "https://kept.example/never", expires_at: 5 }),
      file({ file_id: "9003", content_type: null, size: null, relation: "output" })
    ])
  ).credentials.files;
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].url, SIGNED);
  assert.deepEqual(Object.keys(parsed[1]).sort(), [
    "content_type",
    "file_id",
    "loaded",
    "name",
    "relation",
    "size"
  ]);
  assert.equal(parsed[2].content_type, undefined);
  assert.equal(parsed[2].size, undefined);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed[0]));
});

test("lease files: invalid entries reject the lease without exposing the URL", () => {
  rejects("files");
  rejects([file({ url: SIGNED.replace("https:", "http:") })]);
  rejects([file({ url: "https://user:pass@oss.example.test/" + SECRET })]);
  rejects([file({ url: "not a url " + SECRET })]);
  rejects([file({ url: undefined })]);
  rejects([file({ expires_at: undefined })]);
  rejects([file({ name: "" })]);
  rejects([file({ name: "n".repeat(513) })]);
  rejects([file({ size: 10 * MiB + 1 })]);
  rejects([file({ size: -1 })]);
  rejects([file({ size: "5" })]);
  rejects([file({ relation: "attachment" })]);
  rejects([file({ loaded: "true" })]);
  rejects([file({ file_id: "../1" })]);
  rejects([file(), file()]);
  rejects(Array.from({ length: 201 }, (_, i) => file({ file_id: String(i) })));
  // Through the control plane port: an invalid file settles as a rejected lease (proof only).
  const raw = lease([file({ url: "http://oss.example.test/" + SECRET })]);
  const read = readLease(raw, "c".repeat(43));
  assert.ok(read.proof && !read.lease);
  assert.ok(!JSON.stringify(read).includes(SECRET));
});

test("lease files: at most the 50 newest entries are kept", () => {
  const files = parseLeaseFiles(
    Array.from({ length: 120 }, (_, i) => file({ file_id: String(i), loaded: false }))
  );
  assert.equal(files.length, 50);
  assert.equal(files[0].file_id, "0");
  assert.equal(files[49].file_id, "49");
});

test("safe names: one conservative path component, extension kept, unique", () => {
  const taken = new Set();
  const names = [
    "report.pdf",
    "report.pdf",
    "REPORT.PDF",
    "../../etc/passwd",
    "a\\b\\c.docx",
    "季度报表.xlsx",
    "季度报表.xlsx",
    "...",
    ".hidden",
    "manifest.json",
    "x".repeat(300) + ".pptx",
    "con tent?.tar.gz",
    "a..b.png",
    "noext."
  ].map(name => safeInputName(name, taken));
  assert.deepEqual(names.slice(0, 10), [
    "report.pdf",
    "report-2.pdf",
    "REPORT-3.PDF",
    "passwd",
    "c.docx",
    "file.xlsx",
    "file-2.xlsx",
    "file",
    "hidden",
    "manifest-2.json"
  ]);
  assert.ok(names[10].endsWith(".pptx") && names[10].length <= 80);
  assert.equal(names[11], "con_tent_.tar.gz");
  assert.equal(names[12], "a.b.png");
  assert.equal(names[13], "noext");
  for (const name of names) {
    assert.ok(isSafeInputName(name), name);
    assert.ok(!name.includes("/") && !name.includes("\\") && !name.includes(".."), name);
  }
  assert.equal(new Set(names.map(name => name.toLowerCase())).size, names.length);
  for (const bad of ["..", ".", "a/b", "a\\b", "-x", "x.", "a..b", "", "é.pdf", "x".repeat(81)])
    assert.equal(isSafeInputName(bad), false, bad);
});

test("manifest: every entry with original name, path or null, and load state", () => {
  const content = inputManifest([
    {
      name: "季度报表.xlsx",
      path: "file.xlsx",
      content_type: "x",
      size: 5,
      relation: "input",
      loaded: true
    },
    {
      name: "big.pdf",
      path: null,
      content_type: null,
      size: null,
      relation: "output",
      loaded: false
    }
  ]);
  const parsed = JSON.parse(content.toString("utf8"));
  assert.equal(parsed[0].name, "季度报表.xlsx");
  assert.equal(parsed[1].path, null);
  assert.equal(parsed[1].loaded, false);
});

/** fetch double: body chunks, headers and status; records the request options. */
function sender({ chunks = [Buffer.from("hello")], status = 200, length, fail, calls = [] } = {}) {
  const send = async (url, init) => {
    calls.push({ url, init });
    if (fail) throw new Error(`connect failed for ${url}`);
    const headers = new Headers();
    if (length !== undefined) headers.set("content-length", String(length));
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      }
    });
    return new Response(body, { status, headers });
  };
  send.calls = calls;
  return send;
}

async function downloadCode(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DownloadError);
    assert.ok(!`${error.message} ${inspect(error)}`.includes(SECRET), "URL leaked");
    assert.equal(error.cause, undefined);
    return error.code;
  }
  assert.fail("expected a download error");
}

test("download: https only, no redirects, byte limits on Content-Length and the stream", async () => {
  const limits = { maxBytes: 10, timeoutMs: 1_000 };
  const signal = new AbortController().signal;
  const ok = sender({ chunks: [Buffer.from("hel"), Buffer.from("lo")] });
  assert.equal(
    (await downloadFile(SIGNED, { ...limits, expectedSize: 5 }, signal, ok)).toString(),
    "hello"
  );
  assert.equal(ok.calls[0].init.redirect, "error");
  assert.equal(
    await downloadCode(downloadFile("http://oss.example.test/" + SECRET, limits, signal, ok)),
    "DOWNLOAD_REJECTED"
  );
  // Declared too large: refused before reading the body.
  assert.equal(
    await downloadCode(downloadFile(SIGNED, limits, signal, sender({ length: 11 }))),
    "DOWNLOAD_TOO_LARGE"
  );
  // No Content-Length, the stream runs over the limit.
  assert.equal(
    await downloadCode(
      downloadFile(SIGNED, limits, signal, sender({ chunks: [Buffer.alloc(6), Buffer.alloc(6)] }))
    ),
    "DOWNLOAD_TOO_LARGE"
  );
  assert.equal(
    await downloadCode(
      downloadFile(SIGNED, { ...limits, expectedSize: 4 }, signal, sender({ length: 5 }))
    ),
    "DOWNLOAD_SIZE_MISMATCH"
  );
  assert.equal(
    await downloadCode(downloadFile(SIGNED, { ...limits, expectedSize: 6 }, signal, sender())),
    "DOWNLOAD_SIZE_MISMATCH"
  );
  assert.equal(
    await downloadCode(downloadFile(SIGNED, limits, signal, sender({ status: 403 }))),
    "DOWNLOAD_STATUS"
  );
  // The transport's own error (which may name the URL) is replaced by a fixed code.
  assert.equal(
    await downloadCode(downloadFile(SIGNED, limits, signal, sender({ fail: true }))),
    "DOWNLOAD_FAILED"
  );
  const stall = (url, init) =>
    new Promise((_, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason))
    );
  assert.equal(
    await downloadCode(downloadFile(SIGNED, { ...limits, timeoutMs: 20 }, signal, stall)),
    "DOWNLOAD_TIMEOUT"
  );
});

test("staging: downloads within budget, failures become not loaded, manifest lists all", async () => {
  const bodies = new Map([
    ["a", Buffer.from("A".repeat(5))],
    ["b", Buffer.from("B".repeat(5))]
  ]);
  const send = async url => {
    const key = new URL(url).pathname.slice(1);
    if (key === "broken") return new Response(null, { status: 500 });
    const data = bodies.get(key) ?? Buffer.alloc(10 * MiB);
    return new Response(new Uint8Array(data), {
      headers: { "content-length": String(data.length) }
    });
  };
  const url = key => `https://oss.example.test/${key}?Signature=${SECRET}${"q".repeat(20)}`;
  const skipped = [];
  const staged = await stageInputFiles(
    [
      file({ file_id: "1", name: "report.pdf", url: url("a") }),
      file({ file_id: "2", name: "report.pdf", url: url("b"), relation: "output" }),
      file({ file_id: "3", name: "broken.docx", url: url("broken") }),
      file({ file_id: "4", name: "old.png", url: url("a"), expires_at: Date.now() - 1 }),
      file({ file_id: "5", name: "listed.pdf", loaded: false, url: undefined, size: 7 }),
      ...[6, 7, 8, 9, 10].map(id =>
        file({ file_id: String(id), name: `big${id}.bin`, url: url("big"), size: 10 * MiB })
      )
    ],
    { signal: new AbortController().signal, send, onSkip: (id, code) => skipped.push([id, code]) }
  );
  const names = staged.files.map(f => f.name);
  assert.deepEqual(names, [
    "report.pdf",
    "report-2.pdf",
    "big6.bin",
    "big7.bin",
    "big8.bin",
    INPUT_MANIFEST
  ]);
  assert.equal(staged.loaded, 5);
  assert.equal(staged.unloaded, 5);
  assert.deepEqual(
    skipped.sort((a, b) => Number(a[0]) - Number(b[0])),
    [
      ["3", "DOWNLOAD_STATUS"],
      ["4", "URL_EXPIRED"],
      // The 40 MiB budget: three 10 MiB files fit after the small ones, the next ones do not.
      ["9", "INPUT_BUDGET_EXCEEDED"],
      ["10", "INPUT_BUDGET_EXCEEDED"]
    ]
  );
  const manifest = JSON.parse(Buffer.from(staged.files.at(-1).data).toString("utf8"));
  assert.equal(manifest.length, 10);
  assert.deepEqual(manifest[1], {
    name: "report.pdf",
    path: "report-2.pdf",
    content_type: file().content_type,
    size: 5,
    relation: "output",
    loaded: true
  });
  assert.deepEqual(
    manifest.filter(entry => !entry.loaded).map(entry => [entry.name, entry.path]),
    [
      ["broken.docx", null],
      ["old.png", null],
      ["listed.pdf", null],
      ["big9.bin", null],
      ["big10.bin", null]
    ]
  );
  assert.ok(!JSON.stringify(manifest).includes(SECRET));
  assert.ok(!JSON.stringify(skipped).includes(SECRET));
});

test("staging rejects only when cancelled; a slow source just stays unloaded", async () => {
  const stall = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error(url))));
  const slow = await stageInputFiles([file()], {
    signal: new AbortController().signal,
    send: stall,
    fileTimeoutMs: 20
  });
  assert.equal(slow.loaded, 0);
  assert.equal(slow.files.length, 1);
  const cancel = new AbortController();
  const pending = stageInputFiles([file()], { signal: cancel.signal, send: stall });
  cancel.abort();
  await assert.rejects(pending, /ABORTED/);
});

test("instructions name the inputs directory and treat file content as untrusted data", async () => {
  assert.equal(inputFilesInstructions(false), undefined);
  const text = inputFilesInstructions(true);
  assert.ok(text.includes("/workspace/inputs") && text.includes("manifest.json"));
  assert.ok(text.includes("不可信") && text.includes("loaded"));
  // Generated files: where to save them, how to link them, what is accepted.
  assert.ok(text.includes("/workspace/outputs/") && text.includes("[文件名](outputs/文件名)"));
  assert.ok(text.includes("最多 10 个") && text.includes("宏"));
  const request = {
    runId: "1",
    conversationId: "2",
    tenantId: "3",
    userId: "4",
    input: { prompt: "看看附件", history: [], instructions: "Be brief." },
    webAccess: { mode: "off", domains: [] },
    confirmOperations: [],
    inputFiles: true
  };
  const business = await new FrozenInputContext("System.").turn(request);
  assert.ok(business.instructions.includes("/workspace/inputs"));
  assert.equal(business.contextData, undefined);
  // Without deployment instructions: one context data item (the Drivers accept three).
  const plain = await new FrozenInputContext().turn(request);
  assert.equal(plain.instructions, undefined);
  assert.equal(plain.contextData.length, 1);
  assert.ok(plain.contextData[0].includes("/workspace/inputs"));
  assert.ok(plain.contextData[0].includes("Be brief."));
  const none = await new FrozenInputContext("System.").turn({ ...request, inputFiles: undefined });
  assert.ok(!none.instructions.includes("/workspace/inputs"));
});

test("memory admission: off by default, low below the threshold, unknown when unreadable", async () => {
  assert.equal(parseMemAvailable("MemTotal:  2000000 kB\nMemAvailable:    1024 kB\n"), 1024 * 1024);
  assert.equal(parseMemAvailable("MemTotal: 1 kB\n"), undefined);
  let reads = 0;
  const read = async () => {
    reads++;
    return 300 * MiB;
  };
  assert.equal(await new MemoryAdmission(0, read).check(), "admit");
  assert.equal(reads, 0);
  assert.equal(await new MemoryAdmission(256 * MiB, read).check(), "admit");
  assert.equal(await new MemoryAdmission(512 * MiB, read).check(), "low");
  assert.equal(await new MemoryAdmission(1, async () => undefined).check(), "unknown");
  assert.equal(
    await new MemoryAdmission(1, async () => {
      throw new Error("EACCES");
    }).check(),
    "unknown"
  );
  assert.throws(() => new MemoryAdmission(-1), /INVALID_ADMISSION_CONFIGURATION/);
});
