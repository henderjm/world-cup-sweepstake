// Ambient "Goon Squad pub" background: swaying bunting and drifting embers.
//
// Inspired by the Goon Squad pub animation design, reworked as a quiet ambient layer
// so the live data stays the focus: the opaque content cards sit on top, and this
// shows through the page gutters and behind the hero. Pure DOM + CSS, no React.

const BUNTING_COLORS = ["var(--gold)", "var(--up)", "var(--clay)", "#f3e6c4", "var(--accent)"];

function buildBunting(host) {
  const count = Math.max(8, Math.min(28, Math.round(window.innerWidth / 64)));
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const flag = document.createElement("span");
    flag.className = "bunting__flag";
    flag.style.left = `${((i + 0.5) / count) * 100}%`;
    flag.style.setProperty("--c", BUNTING_COLORS[i % BUNTING_COLORS.length]);
    flag.style.animationDelay = `${(i % 5) * -0.6}s`;
    frag.appendChild(flag);
  }
  host.appendChild(frag);
}

function buildEmbers(host, count) {
  // Deterministic pseudo-random: scattered but stable across reloads.
  let seed = 20260618;
  const rnd = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    const ember = document.createElement("span");
    ember.className = "bg__ember";
    const size = 6 + rnd() * 12;
    ember.style.left = `${rnd() * 100}%`;
    ember.style.width = `${size}px`;
    ember.style.height = `${size}px`;
    ember.style.animationDuration = `${14 + rnd() * 12}s`;
    ember.style.animationDelay = `${-rnd() * 22}s`;
    ember.style.opacity = (0.05 + rnd() * 0.08).toFixed(3);
    frag.appendChild(ember);
  }
  host.appendChild(frag);
}

const bunting = document.getElementById("bunting");
if (bunting) buildBunting(bunting);
const embers = document.getElementById("bgEmbers");
if (embers) buildEmbers(embers, 14);
