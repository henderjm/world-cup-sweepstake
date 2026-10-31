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
  if (isEmbedded()) document.documentElement.classList.add("is-embedded");
  Promise.all([import("./App.svelte"), import("./styles.css")])
    .then(([app]) => mount(app.default, { target }));
}
