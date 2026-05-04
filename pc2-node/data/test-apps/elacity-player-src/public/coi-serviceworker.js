/*! coi-serviceworker v0.1.7 - Guido Zuidhof, licensed under MIT */
let coepCredentialless = false;
if (typeof window === 'undefined') {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => {
          return self.clients.matchAll();
        })
        .then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
    }
  });

  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
      return;
    }

    const request =
      coepCredentialless && r.mode === "no-cors"
        ? new Request(r, { credentials: "omit" })
        : r;

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }

          const newHeaders = new Headers(response.headers);
          newHeaders.set(
            "Cross-Origin-Embedder-Policy",
            coepCredentialless ? "credentialless" : "require-corp"
          );
          if (!coepCredentialless) {
            newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
          }
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  (() => {
    const reloadedBySelf = window.sessionStorage.getItem("coiReloadedBySelf");
    window.sessionStorage.removeItem("coiReloadedBySelf");
    const coepDegrading = reloadedBySelf === "coepdegrade";

    if (window.crossOriginIsolated !== false || window.SharedArrayBuffer !== undefined) return;

    if (window.isSecureContext === false) {
      return;
    }

    if (!reloadedBySelf) {
      window.sessionStorage.setItem("coiReloadedBySelf", "coepCredentialless");
      coepCredentialless = true;
    }

    if (coepDegrading) {
      coepCredentialless = false;
    }

    window.isCoiServiceWorker = true;

    if (navigator.serviceWorker) {
      navigator.serviceWorker
        .register(new URL("coi-serviceworker.js", window.location.href).href)
        .then(
          (registration) => {
            console.log("[COI] Service Worker registered", registration.scope);
            if (registration.active && !navigator.serviceWorker.controller) {
              window.sessionStorage.setItem("coiReloadedBySelf", reloadedBySelf || "");
              window.location.reload();
            }
          },
          (err) => {
            console.error("[COI] Service Worker registration failed:", err.message);
          }
        );
    }
  })();
}
