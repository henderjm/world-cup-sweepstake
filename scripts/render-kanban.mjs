import { readFile, writeFile } from 'node:fs/promises';

const data = JSON.parse(await readFile(new URL('../docs/kanban.json', import.meta.url), 'utf8'));
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const ids = new Set();
for (const card of data.cards) {
  if (ids.has(card.id) || !data.columns.includes(card.status)) throw new Error(`Invalid card: ${card.id}`);
  ids.add(card.id);
}
const columns = data.columns.map(status => {
  const cards = data.cards.filter(card => card.status === status);
  return `<section aria-label="${escape(status)}"><h3>${escape(status)} <span class="text-muted">${cards.length}</span></h3>${cards.map(card => `<article data-card="${escape(card.id)}">
<span class="viz-badge">${escape(card.priority)}</span>
<details><summary class="cursor-interaction">${escape(card.title)}</summary>
<dl><dt>Acceptance</dt><dd>${escape(card.acceptance)}</dd><dt>Next action</dt><dd>${escape(card.next)}</dd><dt>Evidence</dt><dd>${escape(card.evidence)}</dd></dl></details>
<p>${escape(card.summary)}</p></article>`).join('') || '<p>No items.</p>'}</section>`;
}).join('');
await writeFile(new URL('../docs/kanban.html', import.meta.url), `<style>
#kickoff-kanban {color:var(--foreground);overflow-wrap:anywhere}
#kickoff-kanban .lanes {display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px;align-items:start}
#kickoff-kanban article {padding:16px 0;border-top:1px solid var(--border)}
#kickoff-kanban summary {font-weight:500;padding:10px 0;min-height:44px;box-sizing:border-box}
#kickoff-kanban dd {margin:4px 0 14px}
#kickoff-kanban dt {font-weight:500}
#kickoff-kanban p {margin:8px 0}
@media(max-width:1000px){#kickoff-kanban .lanes{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:650px){#kickoff-kanban .lanes{grid-template-columns:1fr}}
</style>
<div id="kickoff-kanban">
<div class="viz-row text-small"><span>Updated ${escape(data.updated)}</span><span>Code ${escape(data.revision)}</span><span>Hourly work: ${escape(data.automation)}</span><span>Owner: Codex</span></div>
<div class="lanes">${columns}</div>
</div>
`);
console.log(`Rendered ${data.cards.length} cards across ${data.columns.length} columns.`);
