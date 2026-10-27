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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = path.join(ROOT, "src/");

/** Dependency units: top-level directories, except sandbox/, harness/, gateway/ and plugins/,
 * whose subdirectories are the units (one implementation each). */
const NESTED = new Set(["sandbox", "harness", "gateway", "plugins"]);
const KNOWN = new Set(["spi", "core", "common", "runtime", "bin", "network", "status", ...NESTED]);

function sources(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") ? [path.relative(SRC, full).split(path.sep).join("/")] : [];
  });
}

function unitOf(file) {
  const parts = file.split("/");
  return NESTED.has(parts[0]) ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Every import, re-export and dynamic import, with whether it is erased at runtime. */
function importsOf(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  for (const m of code.matchAll(
    /\b(import|export)\s+(type\s+)?[^;'"`]*?\bfrom\s+["']([^"']+)["']/g
  ))
    found.push({ specifier: m[3], typeOnly: !!m[2] });
  for (const m of code.matchAll(/^\s*import\s+["']([^"']+)["']/gm))
    found.push({ specifier: m[1], typeOnly: false });
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g))
    found.push({ specifier: m[1], typeOnly: false });
  return found;
}

/** Returns a violation message, or undefined when the import is allowed. */
function check(file, { specifier, typeOnly }) {
  const unit = unitOf(file);
  if (unit === "bin") return undefined;
  if (!specifier.startsWith(".")) {
    // SPI is interfaces and neutral types only: no runtime dependency at all.
    return unit === "spi" && !typeOnly
      ? "spi/ must not import packages or Node modules"
      : undefined;
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (target.startsWith("..")) return "import leaves src/";
  const to = unitOf(target);
  if (to === unit) return undefined;
  if (unit === "common") return "common/ imports only common/";
  if (unit === "spi")
    return to === "common" && typeOnly ? undefined : "spi/ imports only types from common/";
  if (unit === "runtime")
    return ["core", "spi", "common"].includes(to)
      ? undefined
      : "runtime/ imports only core/, spi/, common/ and its own directory";
  if (to === "spi" || to === "common") return undefined;
  return `${unit} may import only spi/, common/ and its own directory`;
}

test("source tree only contains classified dependency units", () => {
  const unknown = sources().filter(
    file =>
      !KNOWN.has(file.split("/")[0]) ||
      (NESTED.has(file.split("/")[0]) && file.split("/").length < 3)
  );
  assert.deepEqual(unknown, [], "unclassified source files (add them to a unit)");
});

test("imports follow the layering rules: spi <- core <- runtime <- bin", () => {
  const violations = [];
  for (const file of sources()) {
    for (const item of importsOf(readFileSync(path.join(SRC, file), "utf8"))) {
      const reason = check(file, item);
      if (reason) violations.push(`${file} -> ${item.specifier} (${reason})`);
    }
  }
  assert.deepEqual(violations, [], `layering violations:\n${violations.join("\n")}`);
});

test("dynamic client loading stays in composition roots or the Purefect plugin", () => {
  const offenders = sources().filter(
    file =>
      !file.startsWith("bin/") &&
      !file.startsWith("plugins/purefect/") &&
      /createRequire\(|PUREFECT_CLIENT_MODULE/.test(readFileSync(path.join(SRC, file), "utf8"))
  );
  assert.deepEqual(offenders, []);
});

test("the rule checker itself flags cross-unit imports", () => {
  const flagged = [
    ["core/worker.ts", "../harness/codex/codex-adapter.js"],
    ["sandbox/docker/lifecycle.ts", "../../harness/codex/codex-managed-config.js"],
    ["plugins/purefect/control-plane.ts", "../../gateway/tool/gateway.js"],
    ["spi/harness.ts", "../core/worker.js"],
    ["common/json.ts", "../spi/control-plane.js"],
    ["status/recorder.ts", "../core/worker.js"],
    ["core/worker.ts", "../status/recorder.js"],
    ["gateway/tool/gateway.ts", "../../status/recorder.js"],
    ["runtime/runtime.ts", "../plugins/purefect/control-plane.js"]
  ].map(([file, specifier]) => check(file, { specifier, typeOnly: true }));
  assert.ok(flagged.every(Boolean), JSON.stringify(flagged));
  assert.ok(check("spi/sandbox.ts", { specifier: "../common/json.js", typeOnly: false }));
  assert.ok(check("spi/sandbox.ts", { specifier: "node:fs", typeOnly: false }));
  assert.equal(
    check("runtime/runtime.ts", { specifier: "../core/worker.js", typeOnly: false }),
    undefined
  );
  assert.equal(
    check("bin/worker.ts", { specifier: "../core/worker.js", typeOnly: false }),
    undefined
  );
  assert.equal(
    check("gateway/model/gateway.ts", { specifier: "../../spi/model-upstream.js", typeOnly: true }),
    undefined
  );
  assert.deepEqual(
    importsOf('import {\n  a,\n  type B\n} from "./x.js";\nexport type { C } from "../y.js";'),
    [
      { specifier: "./x.js", typeOnly: false },
      { specifier: "../y.js", typeOnly: true }
    ]
  );
});

const COPYRIGHT =
  "Copyright © 2024-2026 杭州熵闪科技(Hangzhou Sunshine Technology Corporation). All rights reserved. https://www.purefect.cn";
const LICENSE_LINES = [
  COPYRIGHT,
  "",
  'Licensed under the Apache License, Version 2.0 (the "License");',
  "you may not use this file except in compliance with the License.",
  "You may obtain a copy of the License at",
  "",
  "    http://www.apache.org/licenses/LICENSE-2.0",
  "",
  "Unless required by applicable law or agreed to in writing, software",
  'distributed under the License is distributed on an "AS IS" BASIS,',
  "WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
  "See the License for the specific language governing permissions and",
  "limitations under the License."
];

/** Own files that must carry the license header: sources, tests, scripts and fixtures, plus the
 * Dockerfiles, YAML and shell files at the root and under deploy/. */
function licensed() {
  const walk = dir =>
    existsSync(path.join(ROOT, dir))
      ? readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
          const file = `${dir}/${entry.name}`;
          return entry.isDirectory() ? walk(file) : [file];
        })
      : [];
  const code = /\.(ts|js|mjs|cjs|sh)$/;
  const infra = name => /^Dockerfile/.test(name) || /\.(ya?ml|sh)$/.test(name);
  return [
    ...["src", "test", "scripts", "fixtures"].flatMap(walk).filter(file => code.test(file)),
    ...readdirSync(ROOT).filter(infra),
    ...walk("deploy").filter(file => infra(path.posix.basename(file)))
  ];
}

/** The header as it must appear at the top of `file` (after a shebang). */
function header(file) {
  return /\.(ts|js|mjs|cjs)$/.test(file)
    ? `/*\n${LICENSE_LINES.map(line => (line ? ` * ${line}` : " *")).join("\n")}\n */\n`
    : `${LICENSE_LINES.map(line => (line ? `# ${line}` : "#")).join("\n")}\n`;
}

test("own source, test, script and deployment files carry the Apache-2.0 header", () => {
  const files = licensed();
  assert.ok(files.length > 100 && files.includes("src/bin/worker.ts"), "scan found the sources");
  const missing = files.filter(file => {
    const text = readFileSync(path.join(ROOT, file), "utf8").replace(/^#![^\n]*\n/, "");
    return !text.startsWith(header(file));
  });
  assert.deepEqual(missing, [], "files without the license header");
});

/** Product and Purefect literals: only the Purefect plugin and the composition roots may name
 * them. The copyright line of the license header is exempt. */
const FORBIDDEN = /purefect|(?<![A-Za-z0-9_])pf\.|mcp__purefect/i;

function forbiddenLiterals(file, text) {
  if (file.startsWith("plugins/purefect/") || file.startsWith("bin/")) return [];
  return text
    .split("\n")
    .map((line, index) => ({ line: line.replace(COPYRIGHT, ""), number: index + 1 }))
    .filter(({ line }) => FORBIDDEN.test(line))
    .map(({ number }) => `${file}:${number}`);
}

test("only the Purefect plugin and bin/ name Purefect, pf. or mcp__purefect", () => {
  const offenders = sources().flatMap(file =>
    forbiddenLiterals(file, readFileSync(path.join(SRC, file), "utf8"))
  );
  assert.deepEqual(offenders, [], "Purefect literals outside plugins/purefect and bin");
});

test("the literal checker flags comments and identifiers but not the copyright line", () => {
  assert.deepEqual(forbiddenLiterals("core/x.ts", `/* ${COPYRIGHT} */\nconst a = 1;`), []);
  assert.deepEqual(forbiddenLiterals("core/x.ts", "// Purefect tenant"), ["core/x.ts:1"]);
  assert.deepEqual(forbiddenLiterals("gateway/x.ts", 'const ns = "mcp__purefect";'), [
    "gateway/x.ts:1"
  ]);
  assert.deepEqual(forbiddenLiterals("sandbox/x.ts", 'api("pf.ai.Domain")'), ["sandbox/x.ts:1"]);
  assert.deepEqual(forbiddenLiterals("sandbox/x.ts", "const tmpf = 1; tmpf.x;"), []);
  assert.deepEqual(forbiddenLiterals("plugins/purefect/x.ts", "pf.ai.Domain"), []);
  assert.deepEqual(forbiddenLiterals("bin/worker.ts", "purefect"), []);
});

test("both CLI images install the same pinned document tools for file mode", () => {
  const pins = file => {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const match = /^ARG PYTHON_DOC_TOOLS="([^"]+)"$/m.exec(text);
    assert.ok(match, `${file} defines PYTHON_DOC_TOOLS`);
    assert.match(
      text,
      /^ENV MPLCONFIGDIR=\/tmp\/matplotlib /m,
      `${file} sets a writable MPLCONFIGDIR`
    );
    assert.ok(text.indexOf("PYTHON_DOC_TOOLS") < text.lastIndexOf("USER 1000:1000"), file);
    return match[1].split(" ");
  };
  const codex = pins("Dockerfile.cli");
  assert.deepEqual(pins("Dockerfile.cli-claude"), codex);
  for (const name of [
    "pypdf",
    "pdfplumber",
    "openpyxl",
    "pandas",
    "python-pptx",
    "python-docx",
    "matplotlib"
  ])
    assert.ok(
      codex.some(pin => pin.startsWith(`${name}==`)),
      name
    );
  assert.ok(
    codex.every(pin => /^[a-z][a-z0-9-]*==[0-9][0-9.]*$/.test(pin)),
    "exact versions"
  );
});

test("distributed images carry the SandLane license and notice", () => {
  for (const file of [
    "Dockerfile.runtime",
    "Dockerfile.relay",
    "Dockerfile.cli",
    "Dockerfile.cli-claude"
  ]) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    assert.match(text, /COPY LICENSE NOTICE /, file);
  }
});
