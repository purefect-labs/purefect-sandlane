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
import { deflateRawSync } from "node:zlib";
import {
  checkOutputFile,
  deliverOutputs,
  neutralizeCsv,
  zipEntryNames
} from "../dist/core/output-files.js";
import { ControlPlaneError } from "../dist/spi/control-plane.js";
import { parseLease, parseOutputResponse } from "../dist/plugins/purefect/contract.js";
import { PapiControlPlane } from "../dist/plugins/purefect/control-plane.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A stored (uncompressed) ZIP with the given entry names: local headers, central directory and
 * end record, as Office and python-docx/openpyxl write them. */
function zip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const file = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file);
    centrals.push(central, file);
    offset += local.length + file.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const workbook = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/worksheets/sheet1.xml"
];

test("types: extension allow-list and matching magic numbers", () => {
  const ok = (name, data, contentType) =>
    assert.equal(checkOutputFile(name, Buffer.from(data)).contentType, contentType, name);
  const refused = (name, data, reason) =>
    assert.deepEqual(checkOutputFile(name, Buffer.from(data)), { rejected: reason }, name);
  ok("月报.pdf", "%PDF-1.7\n", "application/pdf");
  ok("a.PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "image/png");
  ok("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg");
  ok("a.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xdb]), "image/jpeg");
  ok("a.gif", "GIF89a", "image/gif");
  ok("a.webp", "RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "image/webp");
  ok("a.txt", "你好", "text/plain");
  ok("a.md", "# 标题", "text/markdown");
  ok("a.json", '\uFEFF{"a":1}', "application/json");
  ok("a.xlsx", zip(workbook), XLSX);
  // A PDF named .xlsx, an HTML page named .png, a ZIP that is not this kind of package.
  refused("a.xlsx", "%PDF-1.7", "content_mismatch");
  refused("a.png", "<html><script>", "content_mismatch");
  refused("a.docx", zip(workbook), "content_mismatch");
  refused("a.xlsx", zip(["xl/workbook.xml"]), "content_mismatch");
  refused(
    "a.xlsx",
    Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(40)]),
    "content_mismatch"
  );
  refused("a.pdf", "", "content_mismatch");
  refused("a.txt", Buffer.from([0x61, 0xff, 0xfe]), "content_mismatch");
  refused("a.txt", "a\u0000b", "content_mismatch");
  refused("a.json", "{not json", "content_mismatch");
  // Executables, scripts, archives, markup that renders: not on the list at all.
  for (const name of [
    "run.exe",
    "x.sh",
    "x.py",
    "x.js",
    "x.html",
    "x.svg",
    "x.zip",
    "x.7z",
    "noext"
  ])
    refused(name, "MZ\u0090\u0000", "type_not_allowed");
  for (const name of ["a.xlsm", "a.docm", "a.pptm", "a.xlsb"])
    refused(name, zip(workbook), "macro");
  refused("../a.pdf", "%PDF-", "invalid_name");
  assert.deepEqual(checkOutputFile("a.pdf", Buffer.from("%PDF-1234"), 4), {
    rejected: "too_large"
  });
});

test("macros: an Office package with a VBA project, macro sheet or ActiveX is refused", () => {
  for (const part of [
    "xl/vbaProject.bin",
    "word/vbaProject.bin",
    "ppt/VBAPROJECT.BIN",
    "xl/macrosheets/sheet1.xml",
    "word/activeX/activeX1.xml",
    "xl\\vbaProject.bin"
  ])
    assert.deepEqual(
      checkOutputFile("a.xlsx", zip([...workbook, part])),
      { rejected: "macro" },
      part
    );
  assert.deepEqual(zipEntryNames(zip(["a", "b/c"])), ["a", "b/c"]);
  assert.equal(zipEntryNames(Buffer.from("PK")), undefined);
  const truncated = zip(workbook);
  truncated.writeUInt32LE(truncated.length, truncated.length - 6);
  assert.equal(zipEntryNames(truncated), undefined);
});

/** A ZIP whose entries carry content, stored or deflated (`[name, content, deflate?]`). */
function zipWith(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, deflate] of entries) {
    const file = Buffer.from(name);
    const plain = Buffer.from(content);
    const body = deflate ? deflateRawSync(plain) : plain;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file, body);
    centrals.push(central, file);
    offset += local.length + file.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** `[Content_Types].xml` declaring the workbook part with `type`, and `extra` entries. */
const contentTypes = (type, extra = "") =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  `<Override PartName="/xl/workbook.xml" ContentType="${type}"/>${extra}</Types>`;
const WORKBOOK_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

test("macros: content types declaring a VBA project or a macro-enabled part are refused", () => {
  const book = (types, deflate = true) =>
    zipWith([
      ["[Content_Types].xml", types, deflate],
      ["_rels/.rels", "<Relationships/>"],
      ["xl/workbook.xml", "<workbook/>", deflate]
    ]);
  const check = (...args) => checkOutputFile("a.xlsx", book(...args));
  // A plain workbook, stored or deflated.
  assert.equal(check(contentTypes(WORKBOOK_TYPE)).contentType, XLSX);
  assert.equal(check(contentTypes(WORKBOOK_TYPE), false).contentType, XLSX);
  // A macro-enabled workbook renamed .xlsx, a VBA project under an innocent part name, Excel 4.0
  // macro sheets, ActiveX: refused by declared type, whatever the part names.
  for (const types of [
    contentTypes("application/vnd.ms-excel.sheet.macroEnabled.main+xml"),
    contentTypes(
      WORKBOOK_TYPE,
      '<Override PartName="/xl/data.bin" ContentType="application/vnd.ms-office.vbaProject"/>'
    ),
    contentTypes(
      WORKBOOK_TYPE,
      '<Default Extension="dat" ContentType="application/vnd.ms-office.vbaProject"/>'
    ),
    contentTypes(
      WORKBOOK_TYPE,
      '<Override PartName="/xl/s.xml" ContentType="application/vnd.ms-excel.macrosheet+xml"/>'
    ),
    contentTypes(
      WORKBOOK_TYPE,
      '<Default Extension="ax" ContentType="application/vnd.ms-office.activeX+xml"/>'
    ),
    // Escaped as character references: still the same type for Office.
    contentTypes("application/vnd.ms-excel.sheet.macro&#69;nabled.main+xml"),
    contentTypes("application/vnd.ms-excel.sheet.macro&#x45;nabled.main+xml")
  ]) {
    assert.deepEqual(check(types), { rejected: "macro" }, types);
    assert.deepEqual(check(types, false), { rejected: "macro" }, types);
  }
  // UTF-16 (with BOM) is read as such.
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(contentTypes("application/vnd.ms-excel.sheet.macroEnabled.main+xml"), "utf16le")
  ]);
  assert.deepEqual(check(utf16), { rejected: "macro" });
  // A second spelling of the part (OPC names are case-insensitive) is checked too.
  const twice = zipWith([
    ["[Content_Types].xml", contentTypes(WORKBOOK_TYPE)],
    ["[CONTENT_TYPES].XML", contentTypes("application/vnd.ms-office.vbaProject"), true],
    ["xl/workbook.xml", "<workbook/>"]
  ]);
  assert.deepEqual(checkOutputFile("a.xlsx", twice), { rejected: "macro" });
  // Unreadable content types (a DTD, corrupt deflate data, another compression): not a package.
  assert.deepEqual(check(`<!DOCTYPE Types [<!ENTITY m "macroEnabled">]>${contentTypes("&m;")}`), {
    rejected: "content_mismatch"
  });
  const corrupt = book(contentTypes(WORKBOOK_TYPE));
  const at = corrupt.indexOf("[Content_Types].xml") + "[Content_Types].xml".length;
  corrupt.fill(0xff, at, at + 8);
  assert.deepEqual(checkOutputFile("a.xlsx", corrupt), { rejected: "content_mismatch" });
  const bzip = book(contentTypes(WORKBOOK_TYPE), false);
  bzip.writeUInt16LE(12, bzip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  assert.deepEqual(checkOutputFile("a.xlsx", bzip), { rejected: "content_mismatch" });
});

test("CSV: formulas neutralized per OWASP, numbers and quoting kept", () => {
  assert.equal(
    neutralizeCsv('a,=SUM(A1),-5,3.2,"@x",+3\r\n-,@SUM(1),"=1+1","a ""q"""\n\tcmd,+1e3,-0.5,"-7"'),
    // A tab separates cells (tab-separated reading): "\tcmd" is an empty cell and "cmd".
    'a,\'=SUM(A1),-5,3.2,"\'@x",+3\r\n\'-,\'@SUM(1),"\'=1+1","a ""q"""\n\tcmd,+1e3,-0.5,"-7"'
  );
  // A quoted cell may span lines and contain commas; a carriage return start is a formula too.
  assert.equal(neutralizeCsv('"=a,\nb",x\n"\rz"'), '"\'=a,\nb",x\n"\'\rz"');
  // BOM and empty cells are kept; malformed quoting is passed through.
  assert.equal(neutralizeCsv("\uFEFF=1,,\n"), "\uFEFF'=1,,\n");
  assert.equal(neutralizeCsv('"=open'), "\"'=open");
  const checked = checkOutputFile("报表.csv", Buffer.from("名称,值\n合计,=SUM(B2:B9)\n负数,-5\n"));
  assert.equal(checked.contentType, "text/csv");
  assert.equal(checked.data.toString("utf8"), "名称,值\n合计,'=SUM(B2:B9)\n负数,-5\n");
});

test("CSV: semicolon and tab separate cells too; a sep= directive line is removed", () => {
  // Semicolon- and tab-separated files (locale defaults, sniffing) are neutralized the same way.
  assert.equal(
    neutralizeCsv('a;=HYPERLINK("x");-5;"@y"\n+cmd;3,5'),
    'a;\'=HYPERLINK("x");-5;"\'@y"\n\'+cmd;3,5'
  );
  assert.equal(neutralizeCsv("a\t=1+1\t-2\n@x\tb"), "a\t'=1+1\t-2\n'@x\tb");
  // A comma-separated cell containing `;` is checked from both readings.
  assert.equal(neutralizeCsv("note;=1,x"), "note;'=1,x");
  // `sep=` lets the file choose the separator (Excel): removed, also repeated or quoted ones.
  assert.equal(neutralizeCsv("sep=|\na|=1\n"), "a|=1\n");
  assert.equal(neutralizeCsv("sep=;\r\na;=1\r\n"), "a;'=1\r\n");
  assert.equal(neutralizeCsv('SEP=;\n"sep=,"\nsep=\t\n=1'), "'=1");
  assert.equal(neutralizeCsv("\uFEFFsep=;\n=1;2"), "\uFEFF'=1;2");
  // Only a first line is a directive.
  assert.equal(neutralizeCsv("a\nsep=;"), "a\nsep=;");
  const directive = checkOutputFile("a.csv", Buffer.from("sep=;\nx;=cmd|' /C calc'!A0\n"));
  assert.equal(directive.data.toString("utf8"), "x;'=cmd|' /C calc'!A0\n");
  // Nothing but the directive: no content left.
  assert.deepEqual(checkOutputFile("a.csv", Buffer.from("\uFEFFsep=;\r\n")), {
    rejected: "content_mismatch"
  });
});

const files = (...names) => names.map(name => ({ name, data: Buffer.from("%PDF-1.7") }));

function sender(fail = () => undefined) {
  const calls = [];
  const send = async (report, signal) => {
    calls.push(report);
    assert.ok(signal instanceof AbortSignal);
    const error = fail(report, calls.length);
    if (error) throw error;
    return report.rejected ? {} : { file_id: "f1" };
  };
  send.calls = calls;
  return send;
}

test("delivery: accepted files first, then refused ones, each reported once", async () => {
  const send = sender();
  const logs = [];
  const result = await deliverOutputs(
    {
      files: [...files("a.pdf"), { name: "x.exe", data: Buffer.from("MZ") }, ...files("b.pdf")],
      rejected: [{ name: "link.pdf", reason: "not_regular_file" }]
    },
    {
      send,
      notAfter: () => Date.now() + 60_000,
      log: (code, fields) => logs.push({ code, ...fields })
    }
  );
  assert.deepEqual(result, { delivered: 2, rejected: 2, unreported: 0, uncertain: 0 });
  assert.deepEqual(
    send.calls.map(call => [call.path, call.name, call.content_type ?? call.rejected]),
    [
      ["outputs/a.pdf", "a.pdf", "application/pdf"],
      ["outputs/b.pdf", "b.pdf", "application/pdf"],
      ["outputs/x.exe", "x.exe", "type_not_allowed"],
      ["outputs/link.pdf", "link.pdf", "not_regular_file"]
    ]
  );
  assert.equal(Buffer.from(send.calls[0].content_base64, "base64").toString(), "%PDF-1.7");
  assert.ok(!("content_base64" in send.calls[2]));
  assert.deepEqual(logs, []);
});

test("delivery: a refused upload is reported as upload_failed, the limit as too_many", async () => {
  const send = sender((report, n) => {
    if (n === 1) return new ControlPlaneError("CONTROL_PLANE_FAULT", "storage_failed");
    if (report.name === "b.pdf" && report.content_base64)
      return new ControlPlaneError("CONTROL_PLANE_REJECTED", "output_limit");
    return undefined;
  });
  const logs = [];
  const result = await deliverOutputs(
    { files: files("a.pdf", "b.pdf", "c.pdf"), rejected: [] },
    {
      send,
      notAfter: () => Date.now() + 60_000,
      log: (code, fields) => logs.push({ code, ...fields })
    }
  );
  assert.deepEqual(
    send.calls.map(call => [call.name, call.rejected ?? "upload"]),
    [
      ["a.pdf", "upload"],
      ["a.pdf", "upload_failed"],
      ["b.pdf", "upload"],
      ["b.pdf", "too_many"],
      // Once the limit is reached the rest is reported without uploading.
      ["c.pdf", "too_many"]
    ]
  );
  assert.deepEqual(result, { delivered: 0, rejected: 3, unreported: 0, uncertain: 0 });
  assert.deepEqual(logs, [
    { code: "OUTPUT_FILE_REPORT_FAILED", error: "storage_failed" },
    { code: "OUTPUT_FILE_REPORT_FAILED", error: "output_limit" }
  ]);
});

test("delivery: an upload without an answer is not reported as failed (it may be stored)", async () => {
  for (const error of [
    new ControlPlaneError("CONTROL_PLANE_UNAVAILABLE"),
    new ControlPlaneError("CONTROL_PLANE_PROTOCOL"),
    new Error("unexpected")
  ]) {
    const send = sender((report, n) => (n === 1 ? error : undefined));
    const logs = [];
    const result = await deliverOutputs(
      { files: files("a.pdf", "b.pdf"), rejected: [{ name: "c.exe", reason: "type_not_allowed" }] },
      {
        send,
        notAfter: () => Date.now() + 60_000,
        log: (code, fields) => logs.push({ code, ...fields })
      }
    );
    // a.pdf: no upload_failed after the unanswered upload; the others go on as usual.
    assert.deepEqual(
      send.calls.map(call => [call.name, call.rejected ?? "upload"]),
      [
        ["a.pdf", "upload"],
        ["b.pdf", "upload"],
        ["c.exe", "type_not_allowed"]
      ],
      error.message
    );
    assert.deepEqual(result, { delivered: 1, rejected: 1, unreported: 1, uncertain: 1 });
    assert.equal(logs.length, 1);
  }
});

test("delivery: a lost lease or the deadline stops it; nothing throws", async () => {
  const lost = sender(() => new ControlPlaneError("CONTROL_PLANE_REJECTED", "lease_lost"));
  const logs = [];
  const result = await deliverOutputs(
    { files: files("a.pdf", "b.pdf"), rejected: [{ name: "c", reason: "too_many" }] },
    { send: lost, notAfter: () => Date.now() + 60_000, log: code => logs.push(code) }
  );
  assert.equal(lost.calls.length, 1);
  assert.deepEqual(result, { delivered: 0, rejected: 0, unreported: 3, uncertain: 0 });
  assert.deepEqual(logs, ["OUTPUT_FILE_REPORT_FAILED", "OUTPUT_FILES_INCOMPLETE"]);
  const late = sender();
  const none = await deliverOutputs(
    { files: files("a.pdf"), rejected: [] },
    { send: late, notAfter: () => Date.now() - 1 }
  );
  assert.equal(late.calls.length, 0);
  assert.equal(none.unreported, 1);
  // A call never outlives the remaining time.
  let seen;
  await deliverOutputs(
    { files: files("a.pdf"), rejected: [] },
    {
      send: (report, signal) =>
        new Promise((_, reject) => {
          seen = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      notAfter: () => Date.now() + 30
    }
  );
  assert.ok(seen.aborted);
});

test("contract: run.file_tools is an optional boolean; output responses are checked", () => {
  const now = Date.now();
  const base = {
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
      }
    }
  };
  const withTools = value => ({ ...base, run: { ...base.run, file_tools: value } });
  assert.equal(parseLease(base).run.file_tools, undefined);
  assert.equal(parseLease(withTools(true)).run.file_tools, true);
  assert.equal(parseLease(withTools(false)).run.file_tools, false);
  assert.equal(parseLease(withTools(null)).run.file_tools, undefined);
  assert.throws(() => parseLease(withTools("true")), { code: "CONTROL_PLANE_PROTOCOL" });
  const protocol = "purefect-ai-execution/1";
  assert.deepEqual(parseOutputResponse({ protocol }), {});
  assert.deepEqual(
    parseOutputResponse({
      protocol,
      file_id: "f-1",
      name: "a.pdf",
      content_type: "application/pdf",
      size: 3
    }),
    { file_id: "f-1", name: "a.pdf", content_type: "application/pdf", size: 3 }
  );
  assert.throws(() => parseOutputResponse({ protocol: "x" }), { code: "CONTROL_PLANE_PROTOCOL" });
  assert.throws(() => parseOutputResponse({ protocol, file_id: "../x" }), {
    code: "CONTROL_PLANE_PROTOCOL"
  });
});

test("control plane: output is its own operation with a 14 MiB request limit", async () => {
  const MiB = 1024 * 1024;
  const calls = [];
  const control = new PapiControlPlane({
    origin: "https://engine.example.test",
    site: "ctl",
    tenant: "tenant-a",
    principalId: "svc-1",
    secret: "s".repeat(32),
    send: async (url, init) => {
      calls.push({ url, bytes: init.body.length });
      return new Response(
        JSON.stringify({
          code: 200,
          success: true,
          data: { protocol: "purefect-ai-execution/1", file_id: "f-1" }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }
  });
  const proof = { job_id: "1", generation: 1, claim_token: "c".repeat(43) };
  const report = size => ({
    ...proof,
    path: "outputs/a.pdf",
    name: "a.pdf",
    content_type: "application/pdf",
    content_base64: Buffer.alloc(size).toString("base64")
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await control.output(report(10 * MiB), signal), { file_id: "f-1" });
  assert.ok(calls[0].url.endsWith("/papi/ctl/tenant-a/pf.ai.worker.ExecutionDomain::output"));
  assert.ok(calls[0].bytes > 13 * MiB);
  await assert.rejects(control.output(report(11 * MiB), signal), {
    code: "CONTROL_PLANE_UNAVAILABLE"
  });
  // The other operations keep their 512 KiB limit.
  await assert.rejects(
    control.complete(
      { ...proof, outcome: { status: "SUCCEEDED", answer: "x".repeat(600 * 1024) } },
      signal
    ),
    { code: "CONTROL_PLANE_UNAVAILABLE" }
  );
  assert.equal(calls.length, 1);
});
