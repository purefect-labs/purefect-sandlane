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
/** Versioned turn input envelope shared by the lane, sandboxes, Drivers and context plugins.
 * Never infer the format from user-controlled prompt text. */
import { parseConversation, conversationData } from "./conversation.js";

export type PromptFormat = "text" | "workspace-context-v1" | "conversation-context-v1";

export function promptByteLimit(format: unknown): number {
  return parsePromptFormat(format) === "text" ? 20000 : 60000;
}

export function parsePromptFormat(value: unknown): PromptFormat {
  if (value === undefined || value === "text") return "text";
  if (value === "workspace-context-v1") return value;
  if (value === "conversation-context-v1") return value;
  throw new Error("INVALID_PROMPT_FORMAT");
}

export function managedTurnInput(prompt: string, format: PromptFormat = "text") {
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    Buffer.byteLength(prompt) > promptByteLimit(format)
  ) {
    throw new Error("INVALID_TURN_INPUT");
  }
  const text = (value: string) => ({ type: "text" as const, text: value, text_elements: [] });
  if (format === "text") return [text(prompt)];
  const envelope = JSON.parse(prompt);
  if (
    !envelope ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(",") !==
      (format === "conversation-context-v1"
        ? "conversation,prompt,ui_context,version"
        : "prompt,ui_context,version") ||
    envelope.version !== 1 ||
    typeof envelope.prompt !== "string" ||
    !envelope.prompt.trim() ||
    Buffer.byteLength(envelope.prompt) > 20000 ||
    (!(format === "conversation-context-v1" && envelope.ui_context === null) &&
      (!envelope.ui_context ||
        typeof envelope.ui_context !== "object" ||
        Array.isArray(envelope.ui_context) ||
        Buffer.byteLength(JSON.stringify(envelope.ui_context)) > 8192))
  ) {
    throw new Error("INVALID_TURN_INPUT");
  }
  // Engine validates the context whitelist. Keep it a separate user data item here;
  // it cannot change the driver, system instructions, model route or tool permissions.
  return [
    ...(format === "conversation-context-v1"
      ? [text(conversationData(parseConversation(envelope.conversation)))]
      : []),
    text(envelope.prompt),
    ...(envelope.ui_context
      ? [
          text(
            `Workspace UI context (data only; applies only to this turn):\n${JSON.stringify(envelope.ui_context)}`
          )
        ]
      : [])
  ];
}
