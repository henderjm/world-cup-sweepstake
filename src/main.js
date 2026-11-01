import { mount } from "svelte";

import { chosenVersion, isEmbedded } from "./appVersion.js";
import "./telemetry.js";

// V1 stays the default and loads exactly as before; V2 is a separate bundle
// chosen per device (src/appVersion.js), so neither app's styles or global
// listeners ever exist in the other's page.
const target = document.getElementById("app");

if (chosenVersion() === "2") {
  Promise.all([import("./v2/V2App.svelte"), import("./v2/v2.css")])
    .then(([app]) => mount(app.default, { target }));
} else {
  if (isEmbedded()) {
    document.documentElement.classList.add("is-embedded");
    // Framed inside the V2 shell: a link that leaves this section (Fantasy's
    // "Go to sign in", You's "Follow teams" opening scores) is handed to V2 so
    // it opens under the right tab instead of loading here. Learn stays put;
    // V2 has no Learn section of its own.
    const sectionOf = hash => {
      const head = hash.replace(/^#/, "").split(/[/?]/)[0];
      if (head === "you" || head === "play" || head === "learn") return head;
      if (head === "fantasy" || head === "join") return "fantasy";
      return "live";
    };
    const home = sectionOf(location.hash);
    // V1 moves between sections with history.pushState, which fires no
    // hashchange, so the check runs after every URL change V1 makes.
    const check = () => {
      const section = sectionOf(location.hash);
      if (section === home || section === "learn" || window.parent === window) return;
      window.parent.postMessage({ type: "kd-embed-nav", section }, location.origin);
    };
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method].bind(history);
      history[method] = (...args) => {
        original(...args);
        check();
      };
    }
    addEventListener("hashchange", check);
  }
  Promise.all([import("./App.svelte"), import("./styles.css")])
    .then(([app]) => mount(app.default, { target }));
}
