/*
MIT License

Copyright (c) 2026 Christian Fiedler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

export const MEMORY_SAVER_ID = "@firefox-memory-saver-hero";
export const API_VERSION = 1;
export const MAX_TIMEOUT_SECONDS = 3600;

export class MemorySaverError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "MemorySaverError";
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalidResponse() {
  return new MemorySaverError("INVALID_RESPONSE", "Memory Saver returned an invalid or incompatible API response.");
}

/** A standalone Firefox client. Does not cache leases, retry, or schedule renewals. */
export class MemorySaverClient {
  #runtime;

  /** The optional runtime is a Firefox-compatible adapter, primarily for testing. */
  constructor({ runtime = globalThis.browser?.runtime } = {}) {
    this.#runtime = runtime;
  }

  async #request(type, payload, validData) {
    if (typeof this.#runtime?.sendMessage !== "function") {
      throw new MemorySaverError("UNAVAILABLE", "Firefox extension messaging is unavailable in this context.");
    }
    let response;
    try {
      response = await this.#runtime.sendMessage(MEMORY_SAVER_ID, { apiVersion: API_VERSION, type, ...payload });
    } catch (cause) {
      // Firefox cannot reliably distinguish a missing add-on from an unreachable
      // or older add-on with no external listener. Preserve the original cause.
      throw new MemorySaverError("UNAVAILABLE", "Memory Saver or its external API could not be reached.", { cause });
    }
    if (!isObject(response)) throw invalidResponse();
    if (response.ok === false) {
      const error = response.error;
      if (!isObject(error) || typeof error.code !== "string" || !error.code
        || typeof error.message !== "string" || !error.message) throw invalidResponse();
      throw new MemorySaverError(error.code, error.message);
    }
    const data = response.data;
    if (response.ok !== true || !isObject(data) || !Number.isInteger(data.apiVersion)) throw invalidResponse();
    if (data.apiVersion !== API_VERSION) {
      throw new MemorySaverError("UNSUPPORTED_API_VERSION", `Unsupported Memory Saver API version: ${data.apiVersion}.`);
    }
    if (!validData(data)) throw invalidResponse();
    return data;
  }

  /** Returns { apiVersion, maxTimeoutSeconds }, or throws (including API_DISABLED). */
  async getApiInfo() {
    return this.#request("get-api-info", {}, (data) => Number.isInteger(data.maxTimeoutSeconds)
      && data.maxTimeoutSeconds >= 1 && data.maxTimeoutSeconds <= MAX_TIMEOUT_SECONDS);
  }

  /** Acquire or renew a tab with an explicit timeoutSeconds (1–3600). Other tabs are unaffected. */
  async protect(tabId, options) {
    const timeoutSeconds = options?.timeoutSeconds;
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw new MemorySaverError("INVALID_TAB_ID", "tabId must be a nonnegative safe integer. Use release(tabId) to release protection.");
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw new MemorySaverError("INVALID_TIMEOUT", "timeoutSeconds must be an integer from 1 to 3600.");
    }
    return this.#request("set-protected-tab", { tabId, timeoutSeconds }, (data) => data.tabId === tabId
      && Number.isSafeInteger(data.expiresAt) && data.expiresAt > 0);
  }

  /** Releases only this extension's lease for tabId, even if the tab has closed. */
  async release(tabId) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) {
      throw new MemorySaverError("INVALID_TAB_ID", "tabId must be a nonnegative safe integer. Use releaseAll() to release all protection.");
    }
    return this.#request("release-protected-tab", { tabId }, (data) => data.tabId === tabId && data.expiresAt === null);
  }

  /** Releases all this extension's leases. Other owners' protections are unaffected. */
  async releaseAll() {
    return this.#request("release-all-protected-tabs", {}, (data) => Array.isArray(data.releasedTabIds)
      && data.releasedTabIds.every((id) => Number.isSafeInteger(id) && id >= 0)
      && new Set(data.releasedTabIds).size === data.releasedTabIds.length);
  }
}
