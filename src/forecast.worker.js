// Runs the Monte Carlo forecast off the main thread so the what-if explorer stays
// smooth while it re-simulates on every pin change. A native ES-module worker, so it
// imports the same pure forecast code with no build step. app.js falls back to running
// runForecast on the main thread if module workers are unavailable.
import { runForecast } from "./forecast.js";

self.onmessage = (event) => {
  const { id, params } = event.data ?? {};
  try {
    const forecast = runForecast(params);
    self.postMessage({ id, forecast });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
