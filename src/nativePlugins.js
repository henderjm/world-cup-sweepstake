// Which page's Capacitor a native plugin call goes through.
//
// V2 shows Fantasy, Play and You as V1 inside a same-origin iframe, and
// Capacitor registers native plugins in the TOP page only: measured in the iOS
// Simulator, App.getInfo() answers from the top page and fails from the frame
// with '"App" plugin is not implemented on ios'. Sign-in and "Enable on this
// device" both live on the framed You screen, so the frame borrows the top
// page's plugins instead (same origin, so it can reach them directly).
//
// Pure apart from what it is handed, so it is testable without a WebView.

export const NATIVE_HOST_KEY = "__kdNative";

// The top page publishes this so frames can reach its plugins.
export function createNativeHost({ registerPlugin, isPluginAvailable }) {
  return {
    plugin: name => registerPlugin(name),
    available: name => isPluginAvailable(name),
  };
}

// A frame's view of one of the top page's plugins. Listener callbacks belong to
// the frame, so every listener added through here is remembered and removed when
// the frame goes away; otherwise the top page would keep calling into a dead
// frame each time a token refreshes or a notification arrives.
export function createPluginRouter({ host, registerLocal, availableLocal }) {
  const handles = [];
  const settled = [];

  function framed(plugin) {
    return new Proxy(plugin, {
      get(target, prop) {
        if (prop === "addListener") {
          return (event, callback) => {
            const handle = Promise.resolve(target.addListener(event, callback));
            handles.push(handle);
            handle.then(resolved => settled.push(resolved), () => {});
            return handle;
          };
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  return {
    framed: Boolean(host),
    plugin: name => (host ? framed(host.plugin(name)) : registerLocal(name)),
    available: name => (host ? host.available(name) : availableLocal(name)),
    // Called from the frame's pagehide.
    // pagehide runs while the frame is torn down, when its own queued promise
    // callbacks may never run, so already-registered listeners are removed
    // synchronously (the call starts in the top page at once); a still-pending
    // registration gets the best effort.
    release() {
      const done = new Set(settled.splice(0));
      for (const handle of done) handle.remove()?.catch?.(() => {});
      for (const pending of handles.splice(0)) {
        pending.then(handle => { if (!done.has(handle)) handle.remove(); }).catch(() => {});
      }
    },
  };
}
