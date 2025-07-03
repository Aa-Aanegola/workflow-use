import * as rrweb from "rrweb";
import { EventType, IncrementalSource } from "@rrweb/types";

let stopRecording: (() => void) | undefined = undefined;
let isRecordingActive = true;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let lastScrollY: number | null = null;
let lastDirection: "up" | "down" | null = null;
const DEBOUNCE_MS = 500;

const SAFE_ATTRIBUTES = new Set([
  "id",
  "name",
  "type",
  "placeholder",
  "aria-label",
  "aria-labelledby",
  "aria-describedby",
  "role",
  "for",
  "autocomplete",
  "required",
  "readonly",
  "alt",
  "title",
  "src",
  "href",
  "target",
  "data-id",
  "data-qa",
  "data-cy",
  "data-testid",
]);

function getXPath(element: HTMLElement): string {
  if (element.id !== "") {
    return `id("${element.id}")`;
  }
  if (element === document.body) {
    return element.tagName.toLowerCase();
  }
  let ix = 0;
  const siblings = element.parentNode?.children;
  if (siblings) {
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        return `${getXPath(element.parentElement as HTMLElement)}/${element.tagName.toLowerCase()}[${ix + 1}]`;
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix++;
      }
    }
  }
  return element.tagName.toLowerCase();
}

function getEnhancedCSSSelector(element: HTMLElement, xpath: string): string {
  let cssSelector = element.tagName.toLowerCase();
  if (element.classList && element.classList.length > 0) {
    const validClassPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
    element.classList.forEach((className) => {
      if (className && validClassPattern.test(className)) {
        cssSelector += `.${CSS.escape(className)}`;
      }
    });
  }
  for (const attr of element.attributes) {
    const attrName = attr.name;
    const attrValue = attr.value;
    if (attrName === "class") continue;
    if (!attrName.trim()) continue;
    if (!SAFE_ATTRIBUTES.has(attrName)) continue;
    const safeAttribute = CSS.escape(attrName);
    if (attrValue === "") {
      cssSelector += `[${safeAttribute}]`;
    } else {
      const safeValue = attrValue.replace(/"/g, '\"');
      if (/['"<>`\s]/.test(attrValue)) {
        cssSelector += `[${safeAttribute}*="${safeValue}"]`;
      } else {
        cssSelector += `[${safeAttribute}="${safeValue}"]`;
      }
    }
  }
  return cssSelector;
}

function attachListenersToNode(node: Node | ShadowRoot) {
  node.addEventListener("click", handleCustomClick, true);
  node.addEventListener("input", handleInput, true);
  node.addEventListener("change", handleSelectChange, true);
  node.addEventListener("keydown", handleKeydown, true);
  node.addEventListener("mouseover", handleMouseOver, true);
  node.addEventListener("mouseout", handleMouseOut, true);
  node.addEventListener("focus", handleFocus, true);
  node.addEventListener("blur", handleBlur, true);
  node.querySelectorAll("*").forEach((el) => {
    if ((el as HTMLElement).shadowRoot) {
      attachListenersToNode((el as HTMLElement).shadowRoot!);
    }
  });
}

function observeShadowDOM() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement && node.shadowRoot) {
          attachListenersToNode(node.shadowRoot);
        }
      });
    });
  });
  observer.observe(document, { childList: true, subtree: true });
}

function startRecorder() {
  if (stopRecording) {
    return;
  }
  isRecordingActive = true;
  stopRecording = rrweb.record({
    emit(event) {
      if (!isRecordingActive) return;
      if (event.type === EventType.IncrementalSnapshot && event.data.source === IncrementalSource.Scroll) {
        const scrollData = event.data as { id: number; x: number; y: number };
        const roundedScrollData = {
          ...scrollData,
          x: Math.round(scrollData.x),
          y: Math.round(scrollData.y),
        };
        let currentDirection: "up" | "down" | null = null;
        if (lastScrollY !== null) {
          currentDirection = scrollData.y > lastScrollY ? "down" : "up";
        }
        if (lastDirection !== null && currentDirection !== null && currentDirection !== lastDirection) {
          if (scrollTimeout) {
            clearTimeout(scrollTimeout);
            scrollTimeout = null;
          }
          chrome.runtime.sendMessage({
            type: "RRWEB_EVENT",
            payload: { ...event, data: roundedScrollData },
          });
          lastDirection = currentDirection;
          lastScrollY = scrollData.y;
          return;
        }
        lastDirection = currentDirection;
        lastScrollY = scrollData.y;
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }
        scrollTimeout = setTimeout(() => {
          chrome.runtime.sendMessage({
            type: "RRWEB_EVENT",
            payload: { ...event, data: roundedScrollData },
          });
          scrollTimeout = null;
          lastDirection = null;
        }, DEBOUNCE_MS);
      } else {
        chrome.runtime.sendMessage({ type: "RRWEB_EVENT", payload: event });
      }
    },
    maskInputOptions: {
      password: true,
    },
    checkoutEveryNms: 10000,
    checkoutEveryNth: 200,
    recordShadowDOM: true,
  });
  attachListenersToNode(document);
  observeShadowDOM();
}

function stopRecorder() {
  if (stopRecording) {
    stopRecording();
    stopRecording = undefined;
    isRecordingActive = false;
  }
}

function handleCustomClick(event: MouseEvent) {
  if (!isRecordingActive) return;
  const targetElement = event.composedPath()[0] as HTMLElement;
  if (!targetElement) return;
  try {
    const xpath = getXPath(targetElement);
    const clickData = {
      timestamp: Date.now(),
      url: document.location.href,
      frameUrl: window.location.href,
      xpath: xpath,
      cssSelector: getEnhancedCSSSelector(targetElement, xpath),
      elementTag: targetElement.tagName,
      elementText: targetElement.textContent?.trim().slice(0, 200) || "",
    };
    chrome.runtime.sendMessage({
      type: "CUSTOM_CLICK_EVENT",
      payload: clickData,
    });
  } catch (error) {}
}

function handleInput(event: Event) {
  if (!isRecordingActive) return;
  const targetElement = event.composedPath()[0] as HTMLInputElement | HTMLTextAreaElement;
  if (!targetElement || !("value" in targetElement)) return;
  const isPassword = targetElement.type === "password";
  try {
    const xpath = getXPath(targetElement);
    const inputData = {
      timestamp: Date.now(),
      url: document.location.href,
      frameUrl: window.location.href,
      xpath: xpath,
      cssSelector: getEnhancedCSSSelector(targetElement, xpath),
      elementTag: targetElement.tagName,
      value: isPassword ? "********" : targetElement.value,
    };
    chrome.runtime.sendMessage({
      type: "CUSTOM_INPUT_EVENT",
      payload: inputData,
    });
  } catch (error) {}
}

function handleSelectChange(event: Event) {
  if (!isRecordingActive) return;
  const targetElement = event.composedPath()[0] as HTMLSelectElement;
  if (!targetElement || targetElement.tagName !== "SELECT") return;
  try {
    const xpath = getXPath(targetElement);
    const selectedOption = targetElement.options[targetElement.selectedIndex];
    const selectData = {
      timestamp: Date.now(),
      url: document.location.href,
      frameUrl: window.location.href,
      xpath: xpath,
      cssSelector: getEnhancedCSSSelector(targetElement, xpath),
      elementTag: targetElement.tagName,
      selectedValue: targetElement.value,
      selectedText: selectedOption ? selectedOption.text : "",
    };
    chrome.runtime.sendMessage({
      type: "CUSTOM_SELECT_EVENT",
      payload: selectData,
    });
  } catch (error) {}
}

const CAPTURED_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
]);

function handleKeydown(event: KeyboardEvent) {
  if (!isRecordingActive) return;
  const key = event.key;
  let keyToLog = "";
  if (CAPTURED_KEYS.has(key)) {
    keyToLog = key;
  } else if ((event.ctrlKey || event.metaKey) && key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
    keyToLog = `CmdOrCtrl+${key.toUpperCase()}`;
  }
  if (keyToLog) {
    const targetElement = event.composedPath()[0] as HTMLElement;
    let xpath = "";
    let cssSelector = "";
    let elementTag = "document";
    if (targetElement && typeof targetElement.tagName === "string") {
      try {
        xpath = getXPath(targetElement);
        cssSelector = getEnhancedCSSSelector(targetElement, xpath);
        elementTag = targetElement.tagName;
      } catch (e) {}
    }
    try {
      const keyData = {
        timestamp: Date.now(),
        url: document.location.href,
        frameUrl: window.location.href,
        key: keyToLog,
        xpath: xpath,
        cssSelector: cssSelector,
        elementTag: elementTag,
      };
      chrome.runtime.sendMessage({
        type: "CUSTOM_KEY_EVENT",
        payload: keyData,
      });
    } catch (error) {}
  }
}

function handleMouseOver(event: MouseEvent) {}
function handleMouseOut(event: MouseEvent) {}
function handleFocus(event: FocusEvent) {}
function handleBlur(event: FocusEvent) {}

export default defineContentScript({
  matches: ["<all_urls>"],
  main(ctx) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === "SET_RECORDING_STATUS") {
        const shouldBeRecording = message.payload;
        if (shouldBeRecording && !isRecordingActive) {
          startRecorder();
        } else if (!shouldBeRecording && isRecordingActive) {
          stopRecorder();
        }
      }
    });
    chrome.runtime.sendMessage(
      { type: "REQUEST_RECORDING_STATUS" },
      (response) => {
        if (response && response.isRecordingEnabled) {
          startRecorder();
        } else {
          stopRecorder();
        }
      }
    );
    window.addEventListener("beforeunload", () => {
      stopRecorder();
    });
  },
});
