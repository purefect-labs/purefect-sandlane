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
/** Model request limits of file-mode Runs (conversation files in the sandbox). The CLI then
 * sends the images and documents it read as inline content, and resends them with the history,
 * so its requests may be much larger than text-only turns. Other Runs keep the entry limits. */

/** Largest request body of a file-mode Run, on either entry. Bounded so a few concurrent calls
 * stay well within the Worker's memory. */
export const FILE_REQUEST_BYTES = 8_000_000;

/** Inline images a file-mode Responses request may carry: base64 data URLs of common raster
 * formats only. A remote URL would make the provider fetch from the network on the model's
 * behalf. */
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
