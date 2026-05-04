(async () => {
  const info = {
    hasJsParams: typeof jsParams !== "undefined",
    hasParams: typeof params !== "undefined",
    jsParamsType: typeof jsParams,
    paramsType: typeof params
  };

  try {
    info.jsParamsKeys = typeof jsParams !== "undefined" ? Object.keys(jsParams) : [];
  } catch(e) {
    info.jsParamsError = e.message;
  }

  try {
    info.hasKid = typeof kid !== "undefined";
  } catch(e) {
    info.kidError = e.message;
  }

  const interesting = Object.keys(globalThis).filter(k => {
    const builtins = ["Object","Function","Array","Number","parseFloat","parseInt",
      "Infinity","NaN","undefined","Boolean","String","Symbol","Date","Promise",
      "RegExp","Error","AggregateError","EvalError","RangeError","ReferenceError",
      "SyntaxError","TypeError","URIError","globalThis","JSON","Math","Intl",
      "ArrayBuffer","Uint8Array","Int8Array","Uint16Array","Int16Array",
      "Uint32Array","Int32Array","Float32Array","Float64Array",
      "Uint8ClampedArray","BigUint64Array","BigInt64Array","DataView",
      "Map","BigInt","Set","WeakMap","WeakSet","Proxy","Reflect",
      "FinalizationRegistry","WeakRef","decodeURI","decodeURIComponent",
      "encodeURI","encodeURIComponent","escape","unescape","eval",
      "isFinite","isNaN","console","SharedArrayBuffer","Atomics",
      "WebAssembly","crypto","atob","btoa","URL","URLSearchParams",
      "TextEncoder","TextDecoder","structuredClone","setTimeout",
      "setInterval","clearTimeout","clearInterval","queueMicrotask",
      "performance","fetch","Headers","Request","Response","FormData",
      "Blob","File","Event","EventTarget","AbortController","AbortSignal",
      "ReadableStream","WritableStream","TransformStream",
      "Iterator","AsyncIterator","Float16Array","MessageEvent",
      "MessageChannel","MessagePort","PromiseRejectionEvent"];
    return !builtins.includes(k);
  });
  info.nonBuiltinGlobals = interesting;

  Lit.Actions.setResponse({ response: JSON.stringify(info) });
})();
