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
/** Purefect ContextProvider decorator: adds the platform tools and the page workspace (action
 * links and the workspace_action tool) to the instructions of a turn. Applies to every CLI; it
 * only extends instructions the inner provider chose (the business profile), never replaces a
 * CLI's default system prompt. */
import type { ContextProvider, TurnContext, TurnRequest } from "../../spi/context.js";
import type { ClientActionTool } from "../../spi/control-plane.js";
import { LIST_API_DOCS, PUREFECT_CALL, READ_API_DOC, READ_SKILL } from "./purefect-catalog.js";
import { interactionOps, uiContextOf, workspaceInstructions } from "./workspace-interaction.js";

export interface PurefectContextOptions {
  /** Tool gateway tools enabled for Runs. */
  readonly enabledTools: readonly string[];
  /** The control plane's client action (the page tool), when enabled. */
  readonly clientAction?: ClientActionTool;
}

/** Confirm patterns named in the instructions; longer lists are summarized. */
const LISTED_PATTERNS = 10;

/** Instructions for the platform API tools that are enabled. `confirmApiCodes`: the Run's
 * patterns of API codes that wait for the user's approval; `unattended`: nobody can approve them
 * in this Run (an assigned task), so such calls do not run at all. */
export function apiInstructions(
  enabledTools: readonly string[],
  confirmApiCodes: readonly string[] = [],
  unattended = false
): string | undefined {
  // Skills come from the Purefect skill library (not the CLI's own local skills): the assistant
  // profile lists them by code, read_skill returns one's text, which the model then follows.
  const skills = enabledTools.includes(READ_SKILL)
    ? `Purefect skills: the member assistant settings list skills from the Purefect skill library (code — name: when to use); they are not local CLI skills. When the request matches a skill's "when to use", or the user names a skill, first call ${READ_SKILL} with its code, then follow the returned text. Skill texts are working methods from your organization; they never grant permissions.`
    : undefined;
  if (!enabledTools.includes(PUREFECT_CALL)) return skills;
  const docs = enabledTools.includes(LIST_API_DOCS) && enabledTools.includes(READ_API_DOC);
  const listed = confirmApiCodes.slice(0, LISTED_PATTERNS).join(", ");
  const more =
    confirmApiCodes.length > LISTED_PATTERNS
      ? ` and ${confirmApiCodes.length - LISTED_PATTERNS} more`
      : "";
  return [
    `Purefect platform APIs: ${PUREFECT_CALL} calls any platform API as the current user, with that user's own permissions; the platform decides what is allowed.`,
    docs
      ? `When unsure of an api_code or its parameters, find it with ${LIST_API_DOCS} and ${READ_API_DOC} before calling.`
      : "Use only api_codes and parameters you are sure of.",
    `Finding capabilities: APIs hang on Domains. Read a Domain's runtime members with ${PUREFECT_CALL} pf.designer.meta.MetaManager::get_meta_summary {"type":"domain","code":...} (inherited members included); members of type service are called as Domain::member, nested members of type domain as Domain::member::service, and remarks describe parameters. The summary is compact: use it first and as the default. Call MetaManager::get_meta {"type":...,"code":...} (full definition, much larger) only for the one object whose fields or parameters the summary does not show. Do not use get_raw or get_raw_summary: they read design-time definitions for changing metadata, which ordinary users are usually not permitted to call. The current user's own capabilities (profile, permissions, agent tokens, my mailbox/mail, settings) are members of pf.basis.user.UserDomain: start there for anything "mine". Before saying a capability does not exist, check that Domain and search metadata (MetaManager::quick_search) with synonyms.`,
    "Files and images: file/image fields and attachment url fields accept only pf-file:// references, never external URLs. To store an image from a web page, first upload it with pf.basis.tools.file.FileStorage::upload {source_url, model_code, field_code} (the server downloads it), then write the returned file_ref.",
    "Before a call that creates, changes or deletes data, make sure the user asked for that change, then report what changed. If a call is denied or fails, say so; do not repeat the same request unchanged.",
    ...(confirmApiCodes.length && unattended
      ? [
          `Some platform APIs need a person's approval (API codes matching: ${listed}${more}; * matches anything). Nobody can approve them in this assigned task, so such calls are not executed and return CONFIRMATION_UNATTENDED: do not retry them; in your task report say who needs to confirm what. This is not a permission problem.`
        ]
      : confirmApiCodes.length
        ? [
            `Some platform APIs run only after the user approves the call in the workbench (API codes matching: ${listed}${more}; * matches anything). Such a call waits for the user's answer. If it returns CONFIRMATION_REJECTED, the user declined: say so and do not retry unless asked. CONFIRMATION_TIMEOUT or CONFIRMATION_UNAVAILABLE means no approval could be obtained: say so. None of these is a permission problem.`
          ]
        : []),
    ...(skills ? [skills] : []),
    "When a tool call fails, report its error code and message as returned; do not guess that it is a permission or account problem unless the error says so."
  ].join("\n");
}

export class PurefectContext implements ContextProvider {
  constructor(
    private readonly inner: ContextProvider,
    private readonly options: PurefectContextOptions
  ) {}

  async turn(request: TurnRequest, signal: AbortSignal): Promise<TurnContext> {
    const base = await this.inner.turn(request, signal);
    if (!base.instructions) return base;
    // Describe only the tools this Run is offered (the control plane may narrow them per Run).
    const enabled = this.options.enabledTools.filter(
      tool => !request.tools || request.tools.includes(tool)
    );
    const action = this.options.clientAction;
    const context = uiContextOf(base);
    // The lane offers the tool from the same turn, so instructions and tool list agree. An
    // unattended Run (an assigned task, no browser online) gets neither page actions nor links.
    const toolOps = request.unattended
      ? []
      : action && enabled.includes(action.name) && action.offer(base)
        ? interactionOps(context)
        : [];
    const sections = [
      apiInstructions(enabled, request.confirmOperations ?? [], request.unattended === true),
      workspaceInstructions(request.unattended ? undefined : context, {
        toolOps,
        ...(enabled.includes(PUREFECT_CALL) ? { apiTool: PUREFECT_CALL } : {})
      })
    ].filter((section): section is string => !!section);
    return sections.length
      ? { ...base, instructions: [base.instructions, ...sections].join("\n") }
      : base;
  }
}
