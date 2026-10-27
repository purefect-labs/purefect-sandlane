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

const STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1f23; --muted: #6b7280; --line: #e5e7eb;
  --head: #f6f7f9; --ok: #15803d; --warn: #b45309; --bad: #b91c1c; --run: #1d4ed8; }
@media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e5e7eb; --muted: #9ca3af;
  --line: #2a2e35; --head: #1a1d23; --ok: #4ade80; --warn: #fbbf24; --bad: #f87171; --run: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 20px 40px; background: var(--bg); color: var(--fg);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 17px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 22px 0 6px; }
.meta, .note { color: var(--muted); }
.meta span { margin-right: 14px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { background: var(--head); font-weight: 600; }
td.num, th.num { text-align: right; }
.scroll { overflow-x: auto; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); } .run { color: var(--run); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/** Renders with DOM text nodes only (no HTML from data). */
const SCRIPT = `
"use strict";
const query = new URLSearchParams(location.search);
const token = query.get("token");
// Chinese for zh browsers (or ?lang=zh), English otherwise (?lang=en).
const zh = (query.get("lang") || navigator.language || "").toLowerCase().startsWith("zh");
const T = zh ? {
  title: "SandLane 运行状态", loading: "加载中…", updated: "更新于 ", failed: "刷新失败：",
  lanes: "执行通道", sandbox: "沙箱", gateways: "网关", upstream: "上游预连接", runs: "最近的 Run",
  version: "版本", runtime: "运行实例", node: "节点", started: "启动时间", uptime: "已运行", harnesses: "CLI",
  queues: "通道：", busy: " · 占用 ", none: "暂无",
  laneHead: ["序号", "状态", "开始于", "当前 Run", "最近错误"],
  sandboxHead: ["可连接", "就绪", "活跃", "容量", "每租户上限", "空闲会话", "排队操作", "网络", "CLI", "检查时间"],
  gatewayHead: ["网关", "调用", "失败", "进行中", "并发上限", "错误码"],
  upstreamHead: ["预连成功", "失败", "最近结果", "最近时间", "握手耗时", "错误"],
  runHead: ["Run", "CLI", "通道", "开始", "沙箱就绪", "开始回合", "首字", "回合结束", "总耗时", "状态", "结算", "错误码", "工具调用", "工具失败"],
  runsNote: (a, r, c, m) => a + " 个执行中 · 保留最近 " + r + "/" + c + " 条 · 标识：" + m + " · 各阶段为自领取起的耗时",
  gateway: { model: "模型", tool: "工具" }, yes: "是", no: "否", ok: "成功", fail: "失败",
  state: { idle: "空闲", claiming: "等待领取", running: "执行中", stopped: "已停止",
    SUCCEEDED: "成功", FAILED: "失败", CANCELLED: "已取消", UNKNOWN: "结果未知" },
  day: "天 ", hour: "时 ", minute: "分 ", second: "秒"
} : {
  title: "SandLane status", loading: "loading…", updated: "updated ", failed: "update failed: ",
  lanes: "Lanes", sandbox: "Sandbox", gateways: "Gateways", upstream: "Upstream preconnect", runs: "Runs",
  version: "version", runtime: "runtime", node: "node", started: "started", uptime: "uptime", harnesses: "harnesses",
  queues: "queues: ", busy: " · busy ", none: "none",
  laneHead: ["lane", "state", "since", "run", "last error"],
  sandboxHead: ["reachable", "ready", "active", "capacity", "per tenant", "idle sessions", "queued ops", "network", "harnesses", "checked"],
  gatewayHead: ["gateway", "calls", "failed", "in flight", "limit", "errors"],
  upstreamHead: ["preconnected", "failed", "last", "last at", "handshake", "error"],
  runHead: ["run", "harness", "lane", "started", "sandbox", "admitted", "first text", "ended", "duration", "status", "settlement", "error", "tools", "tool failures"],
  runsNote: (a, r, c, m) => a + " active · last " + r + " of " + c + " kept · ids: " + m + " · phases in ms since claim",
  gateway: { model: "model", tool: "tool" }, yes: "yes", no: "no", ok: "ok", fail: "failed",
  state: {}, day: "d ", hour: "h ", minute: "m ", second: "s"
};
const label = v => T.state[v] || v;
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (cls) node.className = cls;
  return node;
};
const ms = v => v === undefined || v === null ? "" : v < 1000 ? v + " ms" : (v / 1000).toFixed(v < 10000 ? 2 : 1) + " s";
const time = v => v ? new Date(v).toLocaleTimeString() : "";
const dur = v => { const s = Math.floor(v / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
  m = Math.floor(s % 3600 / 60); return (d ? d + T.day : "") + (d || h ? h + T.hour : "") + m + T.minute + (s % 60) + T.second; };
const STATE = { idle: "", claiming: "ok", running: "run", stopped: "warn",
  SUCCEEDED: "ok", FAILED: "bad", CANCELLED: "warn" };
function table(target, head, rows, numeric = []) {
  const t = el("table"), tr = el("tr");
  head.forEach((h, i) => tr.append(el("th", h, numeric.includes(i) ? "num" : "")));
  t.append(el("thead")); t.tHead.append(tr);
  const body = el("tbody");
  if (!rows.length) { const r = el("tr"), c = el("td", T.none, "note"); c.colSpan = head.length; r.append(c); body.append(r); }
  for (const row of rows) {
    const r = el("tr");
    row.forEach((cell, i) => {
      const value = cell && typeof cell === "object" ? cell : { text: cell };
      r.append(el("td", value.text, [numeric.includes(i) ? "num" : "", value.cls || ""].join(" ").trim()));
    });
    body.append(r);
  }
  t.append(body);
  $(target).replaceChildren(t);
}
function render(s) {
  const w = s.worker;
  $("meta").replaceChildren(...[[T.version, w.version], [T.runtime, w.runtimeId], [T.node, w.nodeId],
    [T.started, new Date(w.startedAt).toLocaleString()], [T.uptime, dur(w.uptimeMs)],
    [T.harnesses, (w.harnesses || []).join(", ")]].filter(([, v]) => v)
    .map(([k, v]) => el("span", k + ": " + v)));
  const l = s.lanes;
  $("lanes-note").textContent = T.queues + l.queues.join(", ") + T.busy + l.busy + " / " + l.concurrency;
  table("lanes", T.laneHead, l.items.map(i =>
    [i.index, { text: label(i.state), cls: STATE[i.state] }, time(i.since), { text: i.run || "", cls: "mono" },
     { text: i.lastError || "", cls: "bad" }]), [0]);
  const b = s.sandbox;
  table("sandbox", T.sandboxHead,
    b ? [[{ text: b.reachable ? T.yes : T.no + (b.error ? " (" + b.error + ")" : ""), cls: b.reachable ? "ok" : "bad" },
      b.ready === undefined ? "" : { text: b.ready ? T.yes : T.no, cls: b.ready ? "ok" : "bad" },
      b.active, b.capacity, b.perTenant, b.idleSessions, b.queuedOperations, b.network,
      (b.harnesses || []).join(", "), time(b.checkedAt)]] : [], [2, 3, 4, 5, 6]);
  const g = s.gateways, errors = e => Object.entries(e).map(([k, v]) => k + " ×" + v).join(", ");
  table("gateways", T.gatewayHead, ["model", "tool"].map(n =>
    [T.gateway[n], g[n].calls, { text: g[n].failed, cls: g[n].failed ? "bad" : "" }, g[n].inFlight, g[n].limit ?? "",
     { text: errors(g[n].errors), cls: "mono" }]), [1, 2, 3, 4]);
  const u = s.upstream, last = u.last;
  table("upstream", T.upstreamHead,
    [[u.preconnects, { text: u.failures, cls: u.failures ? "bad" : "" },
      last ? { text: last.ok ? T.ok : T.fail, cls: last.ok ? "ok" : "bad" } : "",
      last ? time(last.at) : "", last ? ms(last.elapsedMs) : "", last?.error || ""]], [0, 1, 4]);
  const runs = [...s.runs.active, ...s.runs.recent];
  $("runs-note").textContent = T.runsNote(s.runs.active.length, s.runs.recent.length, s.runs.capacity, s.runs.idMode);
  table("runs", T.runHead, runs.map(r => [
    { text: r.id, cls: "mono" }, r.harness, r.lane ?? "", time(r.startedAt),
    ms(r.phases["sandbox-ready"]), ms(r.phases["turn-admitted"]), ms(r.phases["first-text"]),
    ms(r.phases["turn-ended"]), ms(r.durationMs), { text: label(r.status), cls: STATE[r.status] },
    r.settlement || "", { text: r.error || "", cls: "bad" }, r.toolCalls,
    { text: r.toolFailures, cls: r.toolFailures ? "bad" : "" }]), [2, 4, 5, 6, 7, 8, 12, 13]);
}
async function poll() {
  try {
    const response = await fetch("status.json", { cache: "no-store",
      headers: token ? { authorization: "Bearer " + token } : {} });
    if (!response.ok) throw new Error("HTTP " + response.status);
    render(await response.json());
    $("updated").textContent = T.updated + new Date().toLocaleTimeString();
    $("updated").className = "note";
  } catch (error) {
    $("updated").textContent = T.failed + error.message;
    $("updated").className = "bad";
  } finally { setTimeout(poll, 2000); }
}
document.documentElement.lang = zh ? "zh-CN" : "en";
document.title = T.title;
for (const [id, key] of [["title", "title"], ["h-lanes", "lanes"], ["h-sandbox", "sandbox"], ["h-gateways", "gateways"],
  ["h-upstream", "upstream"], ["h-runs", "runs"]]) $(id).textContent = T[key];
$("updated").textContent = T.loading;
poll();
`;

/** Self-contained read-only status page; `nonce` authorizes its inline style and script (CSP). */
export function statusPage(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{16,64}={0,2}$/.test(nonce)) throw new Error("INVALID_NONCE");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>SandLane status</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<h1 id="title">SandLane status</h1>
<div class="meta" id="meta"></div>
<div id="updated" class="note">loading…</div>
<h2 id="h-lanes">Lanes</h2><div class="note" id="lanes-note"></div><div class="scroll" id="lanes"></div>
<h2 id="h-sandbox">Sandbox</h2><div class="scroll" id="sandbox"></div>
<h2 id="h-gateways">Gateways</h2><div class="scroll" id="gateways"></div>
<h2 id="h-upstream">Upstream preconnect</h2><div class="scroll" id="upstream"></div>
<h2 id="h-runs">Runs</h2><div class="note" id="runs-note"></div><div class="scroll" id="runs"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
