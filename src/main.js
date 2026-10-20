import { mount } from "svelte";

import App from "./App.svelte";
import "./styles.css";
import "./telemetry.js";
import { setupNative } from "./native.js";

setupNative().catch(console.error);
mount(App, { target: document.getElementById("app") });
