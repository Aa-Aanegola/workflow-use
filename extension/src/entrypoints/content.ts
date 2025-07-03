import * as rrweb from "rrweb";
import { EventType, IncrementalSource } from "@rrweb/types";

let stopRecording: (() => void) | undefined = undefined;
let isRecordingActive = true;

function getXPath(element: HTMLElement | null): string {
  if (!element) return "unknown";
  if (!element.tagName) return "unknown";
  if (element.id) return `id("${element.id}")`;
  if (element === document.body) return element.tagName.toLowerCase();
  let ix = 0;
  const siblings = element.parentNode?.children;
  if (siblings) {
    for (let i = 0; i < siblings.length; i++) {
      if (siblings[i] === element) {
        return `${getXPath(element.parentElement as HTMLElement)}/${element.tagName.toLowerCase()}[${ix + 1}]`;
      }
      if (siblings[i].nodeType === 1 && siblings[i].tagName === element.tagName) ix++;
    }
  }
  return element.tagName.toLowerCase();
}

function getEnhancedCSSSelector(element: HTMLElement | null, xpath: string): string {
  if (!element || !element.tagName) return "unknown";
  let selector = element.tagName.toLowerCase();
  if (element.classList && element.classList.length > 0) {
    element.classList.forEach(className => {
      if (className) selector += `.${CSS.escape(className)}`;
    });
  }
  for (const attr of element.attributes) {
    if (attr.name !== "class" && attr.value) {
      selector += `[${CSS.escape(attr.name)}="${CSS.escape(attr.value)}"]`;
    }
  }
  return selector;
}

function findEditableElement(root: HTMLElement | ShadowRoot): HTMLElement | null {
  try {
    const el = root.querySelector("input, textarea, [contenteditable]");
    console.log("findEditableElement in", root, "found:", el);
    return el;
  } catch (e) {
    console.error("Error in findEditableElement:", e);
    return null;
  }
}

function resolveClickTarget(event: Event): HTMLElement | null {
  let target = event.target as HTMLElement | null;
  console.log("resolveClickTarget called with", target);
  return target;
}

function resolveInputTarget(event: Event): HTMLElement | null {
  try {
    let target = event.target as HTMLElement | null;
    console.log("resolveInputTarget called with", target);
    if (!target) return null;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.hasAttribute("contenteditable")) {
      console.log("Direct editable target detected:", target);
      return target;
    }
    if (target.shadowRoot) {
      const deep = findEditableElement(target.shadowRoot);
      if (deep) {
        console.log("Found editable in shadowRoot:", deep);
        return deep;
      }
    }
    let parent = target.parentElement;
    while (parent) {
      if (parent.shadowRoot) {
        const deep = findEditableElement(parent.shadowRoot);
        if (deep) {
          console.log("Found editable in parent shadowRoot:", deep);
          return deep;
        }
      }
      parent = parent.parentElement;
    }
    const fallback = findEditableElement(document);
    console.log("Fallback editable element:", fallback);
    return fallback;
  } catch (e) {
    console.error("Error in resolveInputTarget:", e);
    return null;
  }
}

function startRecorder() {
  if (stopRecording) return;
  console.log("Starting recorder");
  isRecordingActive = true;
  stopRecording = rrweb.record({
    emit(event) {
      if (!isRecordingActive) return;
      console.log("rrweb emit event:", event);
      chrome.runtime.sendMessage({ type: "RRWEB_EVENT", payload: event });
    },
    maskInputOptions: { password: true },
    checkoutEveryNms: 10000,
    checkoutEveryNth: 200,
    recordShadowDOM: true,
  });
  attachListeners(document);
}

function stopRecorder() {
  if (stopRecording) {
    console.log("Stopping recorder");
    stopRecording();
    stopRecording = undefined;
    isRecordingActive = false;
  }
}

function attachListeners(root: Document | ShadowRoot) {
  console.log("Attaching listeners to:", root);
  root.addEventListener("click", handleCustomClick, true);
  root.addEventListener("input", handleInput, true);
  root.addEventListener("change", handleSelectChange, true);
  root.addEventListener("keydown", handleKeydown, true);
}

function handleCustomClick(event: MouseEvent) {
  if (!isRecordingActive) return;
  console.log("handleCustomClick fired for:", event);
  const target = resolveClickTarget(event);
  if (!target) return;
  chrome.runtime.sendMessage({
    type: "CUSTOM_CLICK_EVENT",
    payload: {
      timestamp: Date.now(),
      url: location.href,
      frameUrl: location.href,
      xpath: getXPath(target),
      cssSelector: getEnhancedCSSSelector(target, getXPath(target)),
      elementTag: target.tagName,
      elementText: target.textContent?.trim().slice(0, 200) || "",
    },
  });
}

function handleInput(event: Event) {
  if (!isRecordingActive) return;
  console.log("handleInput fired for:", event);
  const target = resolveInputTarget(event) as HTMLInputElement | HTMLTextAreaElement;
  if (!target || !("value" in target)) return;
  chrome.runtime.sendMessage({
    type: "CUSTOM_INPUT_EVENT",
    payload: {
      timestamp: Date.now(),
      url: location.href,
      frameUrl: location.href,
      xpath: getXPath(target),
      cssSelector: getEnhancedCSSSelector(target, getXPath(target)),
      elementTag: target.tagName,
      value: target.type === "password" ? "********" : target.value,
    },
  });
}

function handleSelectChange(event: Event) {
  if (!isRecordingActive) return;
  console.log("handleSelectChange fired for:", event);
  const target = resolveInputTarget(event) as HTMLSelectElement;
  if (!target) return;
  chrome.runtime.sendMessage({
    type: "CUSTOM_SELECT_EVENT",
    payload: {
      timestamp: Date.now(),
      url: location.href,
      frameUrl: location.href,
      xpath: getXPath(target),
      cssSelector: getEnhancedCSSSelector(target, getXPath(target)),
      elementTag: target.tagName,
      selectedValue: target.value,
      selectedText: target.selectedOptions[0]?.text || "",
    },
  });
}

function handleKeydown(event: KeyboardEvent) {
  if (!isRecordingActive) return;
  console.log("handleKeydown fired for:", event);
  const target = resolveInputTarget(event);
  if (!target) return;
  chrome.runtime.sendMessage({
    type: "CUSTOM_KEY_EVENT",
    payload: {
      timestamp: Date.now(),
      url: location.href,
      frameUrl: location.href,
      xpath: getXPath(target),
      cssSelector: getEnhancedCSSSelector(target, getXPath(target)),
      elementTag: target.tagName,
      key: event.key,
    },
  });
}

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    console.log("Content script loaded");
    chrome.runtime.onMessage.addListener((message) => {
      console.log("Received message:", message);
      if (message.type === "SET_RECORDING_STATUS") {
        if (message.payload && !isRecordingActive) startRecorder();
        else if (!message.payload && isRecordingActive) stopRecorder();
      }
    });
    chrome.runtime.sendMessage({ type: "REQUEST_RECORDING_STATUS" }, (response) => {
      console.log("Initial recording status response:", response);
      if (response?.isRecordingEnabled) startRecorder();
    });
    window.addEventListener("beforeunload", stopRecorder);
  },
});
