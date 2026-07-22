import { mount } from "svelte";

import App from "./App.svelte";
import "./styles.css";
import "./telemetry.js";

mount(App, { target: document.getElementById("app") });
