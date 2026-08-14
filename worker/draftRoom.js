// FantasyDraftRoom: one Durable Object instance per league (idFromName(String(leagueId))),
// holding the live snake draft's clock and turn order in memory.
//
// This class is deliberately thin. Every decision that can be unit-tested lives in
// src/draftLogic.js (snake order, pick validation, autopick, the H2H schedule); this
// file only wires those pure functions to WebSockets, D1 and the alarm clock. It
// cannot be exercised by node:test (it needs the Workers runtime's WebSocket
// Hibernation API and Durable Object storage), so keep it boring on purpose.
//
// D1's fantasy_draft_picks is the only source of truth. this.draft is a cache
// rebuilt from it on every wake (constructor runs fresh after each eviction, so
// there is no stale in-memory state to worry about); a pick is never considered
// real until the D1 batch that writes it has committed.
//
// Auth is enforced entirely at the Worker edge (see handleFantasyDraftWs in
// worker.js): by the time a request reaches fetch() here, the session has already
// been verified against D1 and league membership checked. The DO trusts only the
// X-Draft-User-Id/X-Draft-League-Id headers on that first request, never a
// client-supplied token.

import {
  PICK_VIA,
  autoPick,
  isUniqueConstraintError,
  resolvePick,
  resolvePickVia,
  roundRobinSchedule,
  topQueuedPick,
  validatePick,
} from "../src/draftLogic.js";
import { SQUAD_SIZE, SQUAD_SLOTS } from "../src/fantasy.js";
import { pickClockMs } from "../src/fantasyBots.js";
import { CHAT_EVENTS, cleanChatText } from "../src/fantasyChat.js";

const PLAYER_POOL_PATH = "/data/PL/players.json";
const PLAYER_POOL_STORAGE_KEY = "playerPool";

export class FantasyDraftRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.draft = null; // hydrated lazily, see ensureHydrated
    this.hydrating = null;
    this.playersById = null; // Map<id, {id,name,team,position}>
    this.playerPoolOrder = null; // the full pool (xP/tier included); autoPick ranks it itself
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/start" && request.method === "POST") {
      const leagueId = Number(request.headers.get("X-Draft-League-Id"));
      if (!Number.isInteger(leagueId)) return new Response("bad league", { status: 400 });
      await this.state.storage.put("leagueId", leagueId);
      await this.ensureHydrated(leagueId);
      if (this.draft.status === "drafting" && (await this.state.storage.getAlarm()) == null) {
        await this.scheduleClock();
      }
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/join" && request.method === "GET") {
      const userId = Number(request.headers.get("X-Draft-User-Id"));
      const leagueId = Number(request.headers.get("X-Draft-League-Id"));
      if (!Number.isInteger(userId) || !Number.isInteger(leagueId)) {
        return new Response("missing verified identity", { status: 400 });
      }
      await this.state.storage.put("leagueId", leagueId);
      await this.ensureHydrated(leagueId);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Hibernation API: tagging + serializeAttachment survive eviction, so the
      // socket's identity never depends on this object instance staying alive.
      this.state.acceptWebSocket(server, [`user:${userId}`]);
      server.serializeAttachment({ userId, leagueId });
      this.sendState(server);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  // -- WebSocket Hibernation API callbacks -------------------------------------

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return this.sendError(ws, "bad message");
    }
    if (data?.type !== "pick" && data?.type !== "chat") return this.sendError(ws, "unknown message type");

    const attachment = ws.deserializeAttachment() ?? {};
    if (!Number.isInteger(attachment.userId)) return this.sendError(ws, "not authenticated");

    // Chat is not a pick: it takes no turn, needs no clock and must never
    // queue behind blockConcurrencyWhile, which exists purely to serialise
    // writes to the one contended resource (the next pick slot). Persisted to
    // the same fantasy_chat_messages table the league feed reads, so the
    // conversation is continuous after the draft ends rather than evaporating
    // with the socket.
    if (data.type === "chat") return this.handleChat(ws, attachment, data.text);

    // The whole validate-then-write sequence runs inside blockConcurrencyWhile,
    // which suspends every other incoming event (another socket's pick message,
    // the alarm firing) until this promise settles. Without it, two handlers can
    // both await past their own validation (D1/fetch calls yield the event loop)
    // before either has committed, so both see the same "seat open" state and
    // both write: the same slot picked twice, or the same user's two tabs both
    // getting through. Validation is re-read fresh in here (not reused from
    // before the lock) so a message that was queued behind another one's commit
    // is judged against the post-commit state, not stale state from before it
    // queued.
    await this.state.blockConcurrencyWhile(async () => {
      await this.ensureHydrated(attachment.leagueId);
      if (this.draft.status !== "drafting") return this.sendError(ws, "draft is not live");

      const onClock = this.currentOnClockUserId();
      if (attachment.userId !== onClock) return this.sendError(ws, "not your turn");

      const player = this.playersById.get(Number(data.playerId));
      if (!player) return this.sendError(ws, "unknown player");

      const roster = this.draft.rosters.get(attachment.userId) ?? [];
      const validation = validatePick({
        roster,
        draftedIds: this.draft.draftedPlayerIds,
        player,
        squadSlots: SQUAD_SLOTS,
      });
      if (!validation.valid) return this.sendError(ws, validation.error);

      // A socket message is somebody at the keyboard, which is the whole
      // point of recording it. onClockIsBot is threaded through rather than
      // hardcoded false so resolvePickVia stays the single decision point;
      // a bot can never actually reach here (it holds no session, so the
      // Worker edge can never mint it a socket), so this only ever answers
      // "manual".
      const result = await this.commitPick(attachment.userId, player, {
        via: resolvePickVia({ onClockIsBot: this.draft.botUserIds.has(attachment.userId) }),
      });
      if (!result.ok) this.sendError(ws, result.error);
    });
  }

  // Draft-room chat. The sender's identity comes from the socket attachment
  // the Worker edge already verified (see handleFantasyDraftWs), never from
  // the message, so a client cannot post as somebody else. The display name
  // comes from the hydrated member list rather than from the client for the
  // same reason.
  async handleChat(ws, attachment, rawText) {
    const text = cleanChatText(rawText);
    if (!text) return; // nothing to say; not worth an error round trip
    await this.ensureHydrated(attachment.leagueId);

    let messageId = null;
    try {
      const result = await this.env.DB.prepare(
        `INSERT INTO fantasy_chat_messages (league_id, user_id, kind, text) VALUES (?1, ?2, 'message', ?3)`,
      )
        .bind(attachment.leagueId, attachment.userId, text)
        .run();
      messageId = result.meta?.last_row_id ?? null;
    } catch {
      // The feed row is the durable copy; if D1 rejects it there is nothing
      // worth broadcasting, since a message everyone saw but nobody can scroll
      // back to is worse than one that never appeared.
      return this.sendError(ws, "message could not be sent");
    }

    this.broadcast({
      type: "chat",
      id: messageId,
      userId: attachment.userId,
      name: this.draft.memberNames?.get(attachment.userId) ?? "Someone",
      text,
    });
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      // already closing; hibernation API cleans up regardless
    }
  }

  async webSocketError() {
    // Hibernation API drops the socket on error automatically; nothing to persist.
  }

  // -- Alarm: the 60s pick clock -------------------------------------------------

  async alarm() {
    const leagueId = await this.state.storage.get("leagueId");
    if (leagueId == null) return; // never joined/started, nothing to autopick

    // Same serialization as webSocketMessage: without it, this autopick could
    // interleave with a human's pick landing in the same instant (see the
    // comment there for the full race).
    await this.state.blockConcurrencyWhile(async () => {
      await this.ensureHydrated(leagueId);
      if (this.draft.status !== "drafting") return;

      const onClock = this.currentOnClockUserId();
      if (onClock == null) return;
      const roster = this.draft.rosters.get(onClock) ?? [];
      const available = this.availablePlayers();
      // The manager's own shortlist beats the generic scarcest-bucket
      // autopick: a manager who ranked players before their clock expired
      // gets THEIR pick, not a stranger's heuristic. topQueuedPick already
      // skips a queued player who was sniped or whose bucket has since
      // filled, and returns null (falling through to autoPick below) once
      // nothing in the queue is still legal.
      const queuedPlayer = topQueuedPick(
        this.draft.queues.get(onClock) ?? [],
        this.playerPoolOrder,
        roster,
        this.draft.draftedPlayerIds,
        SQUAD_SLOTS,
      );
      const player = queuedPlayer ?? autoPick(available, roster, SQUAD_SLOTS, this.draft.memberIds.length);
      if (!player) {
        // Every open bucket has run out of legal candidates in the pool. This
        // should not happen (the pool is far larger than a squad) but must not
        // alarm-loop forever: do NOT reschedule. The draft simply pauses; the
        // clock only restarts once this manager (or whoever ends up on the
        // clock) lands a legal pick through the normal commitPick path below.
        this.broadcast({ type: "error", error: "autopick found no legal candidate", userId: onClock });
        return;
      }

      const result = await this.commitPick(onClock, player, {
        via: resolvePickVia({
          onClockIsBot: this.draft.botUserIds.has(onClock),
          fromClock: true,
          fromQueue: queuedPlayer != null,
        }),
      });
      if (!result.ok) {
        // Lost the race to a human pick that landed a moment earlier (or, in
        // theory, another instance's write). commitPick already rehydrated;
        // nothing else to do, the pick that won already rescheduled the clock.
      }
    });
  }

  // -- Shared pick path (human message or alarm autopick) ------------------------
  // Only ever called from inside a blockConcurrencyWhile block (see
  // webSocketMessage/alarm above), so within this instance there is never a
  // second commitPick in flight. The try/catch below is defense in depth for a
  // race that lock cannot cover: two Durable Object instances for the same
  // league briefly overlapping (an eviction/wake edge case), where each one's
  // in-memory overallPick could otherwise agree and both write the same slot.
  // The fantasy_draft_picks(league_id, overall_pick) unique index makes the
  // second write fail instead of silently duplicating a pick.
  async commitPick(userId, player, { via = PICK_VIA.MANUAL } = {}) {
    const leagueId = this.draft.leagueId;
    const overallPick = this.draft.overallPick;
    const viaQueue = via === PICK_VIA.QUEUE;
    const resolved = resolvePick(this.draft.memberIds, overallPick, SQUAD_SIZE);
    if (!resolved) return { ok: false, error: "draft is already complete" };

    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO fantasy_draft_picks (league_id, round, pick_in_round, overall_pick, user_id, player_id, via)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(leagueId, resolved.round, resolved.pickInRound, overallPick, userId, player.id, via),
        this.env.DB.prepare(
          `INSERT INTO fantasy_rosters (league_id, user_id, player_id, acquired_via) VALUES (?1, ?2, ?3, 'draft')`,
        ).bind(leagueId, userId, player.id),
        // The league feed's announcement of this pick, in the SAME batch as
        // the pick itself. A duplicate-slot write loses the whole batch on the
        // unique index below, so the feed can never carry a pick that did not
        // actually happen.
        //
        // The payload stores `via` and NOT the older `viaQueue` boolean it
        // replaces: viaQueue is derivable from via, and the feed is permanent
        // history, so storing a derived field forever is how two copies of one
        // fact start disagreeing. describeChatEvent (src/fantasyChat.js) reads
        // `via` and falls back to `viaQueue` for rows written before this
        // column existed, so both dialects keep rendering correctly.
        this.env.DB.prepare(
          `INSERT INTO fantasy_chat_messages (league_id, user_id, kind, event, payload) VALUES (?1, NULL, 'system', ?2, ?3)`,
        ).bind(
          leagueId,
          CHAT_EVENTS.DRAFT_PICK,
          JSON.stringify({
            actor: this.draft.memberNames?.get(userId) ?? "Someone",
            player: player.name,
            team: player.team,
            position: player.position,
            round: resolved.round,
            pickInRound: resolved.pickInRound,
            overallPick,
            via,
          }),
        ),
      ]);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      // Lost the race: some other write already claimed this overall_pick. Never
      // trust the in-memory state after this, force a full rehydrate from D1 so
      // the next attempt (a retry, or the next queued event) sees the real
      // current pick rather than compounding the drift.
      this.draft = null;
      await this.ensureHydrated(leagueId);
      return { ok: false, error: "not your turn" };
    }

    this.draft.draftedPlayerIds.add(player.id);
    const roster = this.draft.rosters.get(userId) ?? [];
    roster.push(player);
    this.draft.rosters.set(userId, roster);
    this.draft.overallPick = overallPick + 1;
    // Keep the in-memory picks log current (not just rosters/draftedPlayerIds
    // above) so a client that joins/reconnects between now and this
    // instance's next actual eviction still gets an accurate sendState feed.
    //
    // Both `via` and the older `viaQueue` ride the wire, unlike the persisted
    // payload above which stores only `via`. These messages are ephemeral, so
    // carrying the derived boolean costs nothing and keeps every existing
    // reader working unchanged (reduceDraftMessage in src/fantasyDraft.js and
    // the pick feed's Queue chip in src/fantasyView.js both read viaQueue).
    this.draft.picks.push({
      round: resolved.round,
      pickInRound: resolved.pickInRound,
      overallPick,
      userId,
      player: publicPlayer(player),
      via,
      viaQueue,
    });

    this.broadcast({
      type: "pick",
      round: resolved.round,
      pickInRound: resolved.pickInRound,
      overallPick,
      userId,
      player: publicPlayer(player),
      via,
      viaQueue,
    });

    if (this.draft.overallPick > this.draft.totalPicks) {
      await this.completeDraft();
    } else {
      await this.scheduleClock();
    }
    return { ok: true };
  }

  async completeDraft() {
    this.draft.status = "complete";
    const fixtures = roundRobinSchedule(this.draft.memberIds, 38);
    if (fixtures.length) {
      // D1 batches are capped in size in practice; this schedule tops out at
      // MAX_LEAGUE_SIZE/2 * 38 = 190 rows, comfortably within one batch.
      await this.env.DB.batch(
        fixtures.map((fixture) =>
          this.env.DB.prepare(
            `INSERT INTO fantasy_h2h_fixtures (league_id, gameweek, home_user_id, away_user_id) VALUES (?1, ?2, ?3, ?4)`,
          ).bind(this.draft.leagueId, fixture.gameweek, fixture.homeUserId, fixture.awayUserId),
        ),
      );
    }
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE fantasy_leagues SET draft_status = 'complete' WHERE id = ?1`).bind(
        this.draft.leagueId,
      ),
      this.env.DB.prepare(
        `INSERT INTO fantasy_chat_messages (league_id, user_id, kind, event, payload) VALUES (?1, NULL, 'system', ?2, ?3)`,
      ).bind(
        this.draft.leagueId,
        CHAT_EVENTS.DRAFT_COMPLETED,
        JSON.stringify({ picks: this.draft.picks.length, managers: this.draft.memberIds.length }),
      ),
    ]);
    await this.state.storage.deleteAlarm();
    this.broadcast({ type: "complete", leagueId: this.draft.leagueId });
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, "draft complete");
      } catch {
        // already closed
      }
    }
  }

  async scheduleClock() {
    const onClock = this.currentOnClockUserId();
    // A bot's clock is deliberately short (see pickClockMs in
    // src/fantasyBots.js). It cannot pick early and it will never pick late,
    // so its window is pure waiting; at the human 60s an eight-bot league
    // would take two hours to draft, which defeats the point of filling the
    // seats at all.
    const onClockIsBot = onClock != null && this.draft.botUserIds.has(onClock);
    const deadline = Date.now() + pickClockMs(onClockIsBot);
    // Known, accepted rough edge: a DO eviction and rehydrate partway through a
    // pick's window does not reset this alarm (it is durable storage, kept
    // as-is across evictions), so it can fire a little ahead of a client's own
    // local countdown for that one pick. Self-healing (the broadcast right after
    // carries the true state) and cosmetic, so left as-is rather than tracked.
    await this.state.storage.setAlarm(deadline);
    const resolved = resolvePick(this.draft.memberIds, this.draft.overallPick, SQUAD_SIZE);
    this.broadcast({
      type: "clock",
      deadline,
      onClockUserId: onClock,
      onClockIsBot,
      overallPick: this.draft.overallPick,
      round: resolved?.round ?? null,
      pickInRound: resolved?.pickInRound ?? null,
    });
  }

  currentOnClockUserId() {
    if (this.draft.status !== "drafting") return null;
    const resolved = resolvePick(this.draft.memberIds, this.draft.overallPick, SQUAD_SIZE);
    return resolved?.userId ?? null;
  }

  availablePlayers() {
    return this.playerPoolOrder.filter((player) => !this.draft.draftedPlayerIds.has(player.id));
  }

  broadcast(message) {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // dead socket; the hibernation API tears it down via webSocketClose/Error
      }
    }
  }

  sendError(ws, error) {
    try {
      ws.send(JSON.stringify({ type: "error", error }));
    } catch {
      // socket already gone
    }
  }

  sendState(ws) {
    const resolved = resolvePick(this.draft.memberIds, this.draft.overallPick, SQUAD_SIZE);
    const rosters = {};
    this.draft.rosters.forEach((players, userId) => {
      rosters[userId] = players.map(publicPlayer);
    });
    ws.send(
      JSON.stringify({
        type: "state",
        leagueId: this.draft.leagueId,
        status: this.draft.status,
        memberIds: this.draft.memberIds,
        // So a client that reconnects mid-draft can label the order strip and
        // the pick feed without waiting for a league-detail fetch to land.
        botUserIds: [...this.draft.botUserIds],
        overallPick: this.draft.overallPick,
        totalPicks: this.draft.totalPicks,
        onClockUserId: resolved?.userId ?? null,
        round: resolved?.round ?? null,
        pickInRound: resolved?.pickInRound ?? null,
        picks: this.draft.picks,
        rosters,
      }),
    );
  }

  // -- Hydration: rebuild the in-memory cache from D1 ---------------------------

  async ensureHydrated(leagueId) {
    if (this.draft && this.draft.leagueId === leagueId) return;
    if (this.hydrating) return this.hydrating;
    this.hydrating = this._hydrate(leagueId);
    try {
      await this.hydrating;
    } finally {
      this.hydrating = null;
    }
  }

  async _hydrate(leagueId) {
    await this.loadPlayerPool();

    const league = await this.env.DB.prepare(`SELECT draft_status FROM fantasy_leagues WHERE id = ?1`)
      .bind(leagueId)
      .first();
    // name/email joined in purely so a pick's league-feed row and a chat
    // message can name their author: the Durable Object only ever sees a
    // verified user id, and the feed is a permanent history that must not
    // depend on a later join to stay legible.
    const members = await this.env.DB.prepare(
      `SELECT m.user_id, u.name, u.email, u.is_bot FROM fantasy_league_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.league_id = ?1
       ORDER BY m.draft_position IS NULL, m.draft_position, m.joined_at`,
    )
      .bind(leagueId)
      .all();
    const pickRows = await this.env.DB.prepare(
      `SELECT round, pick_in_round, overall_pick, user_id, player_id, via FROM fantasy_draft_picks
       WHERE league_id = ?1 ORDER BY overall_pick`,
    )
      .bind(leagueId)
      .all();
    // Every member's own shortlist, queue order. Read fresh on every wake
    // (never cached beyond this instance's own commitPick/alarm lifetime), so
    // a manager's most recent save always wins - this table has no idea which
    // Durable Object instance is currently warm, and shouldn't need to.
    const queueRows = await this.env.DB.prepare(
      `SELECT user_id, player_id FROM fantasy_draft_queue WHERE league_id = ?1 ORDER BY user_id, position`,
    )
      .bind(leagueId)
      .all();

    const memberIds = (members.results ?? []).map((row) => row.user_id);
    // Read from D1 on every wake like everything else here, never cached in
    // Durable Object storage: a commissioner can add or remove a bot right up
    // until the draft starts, and this instance has no idea whether it was
    // warm across that change.
    const botUserIds = new Set(
      (members.results ?? []).filter((row) => row.is_bot).map((row) => row.user_id),
    );
    const memberNames = new Map(
      (members.results ?? []).map((row) => [
        row.user_id,
        row.name || String(row.email ?? "").split("@")[0] || "Someone",
      ]),
    );
    const rosters = new Map(memberIds.map((id) => [id, []]));
    const draftedPlayerIds = new Set();
    const picks = [];

    for (const row of pickRows.results ?? []) {
      const player = this.playersById.get(row.player_id);
      draftedPlayerIds.add(row.player_id);
      if (player) {
        const roster = rosters.get(row.user_id) ?? [];
        roster.push(player);
        rosters.set(row.user_id, roster);
      }
      picks.push({
        round: row.round,
        pickInRound: row.pick_in_round,
        overallPick: row.overall_pick,
        userId: row.user_id,
        player: player ? publicPlayer(player) : { id: row.player_id },
        // A rehydrated pick now reports how it was made, because the pick log
        // carries it. Before the `via` column this was hardcoded false, so a
        // Durable Object eviction mid-draft silently relabelled every earlier
        // queue autopick as an ordinary pick in the room's own feed.
        //
        // null (a row written before the column existed) stays null rather
        // than being coerced to a value, and viaQueue keeps its old
        // false-when-unknown shape so no existing reader sees undefined.
        via: row.via ?? null,
        viaQueue: row.via === PICK_VIA.QUEUE,
      });
    }

    const queues = new Map(memberIds.map((id) => [id, []]));
    for (const row of queueRows.results ?? []) {
      const list = queues.get(row.user_id) ?? [];
      list.push(row.player_id);
      queues.set(row.user_id, list);
    }

    this.draft = {
      leagueId,
      memberIds,
      memberNames,
      botUserIds,
      status: league?.draft_status ?? "pending",
      totalPicks: memberIds.length * SQUAD_SIZE,
      overallPick: picks.length + 1,
      picks,
      rosters,
      draftedPlayerIds,
      queues,
    };
  }

  // Player pool for pick validation/autopick. Fetched from the public static site
  // (the same data/PL/players.json the frontend already reads) rather than D1,
  // because D1 holds no xP/tier columns and autoPick needs the same per-player
  // figures the browser's board is built from. The array's ORDER carries no
  // meaning here: it is grouped by club and sorted only by tier, and autoPick
  // ranks it itself (see its header - trusting this order was the bug). Cached in
  // Durable Object storage (durable across evictions) and only refetched when
  // missing.
  async loadPlayerPool() {
    if (this.playersById) return;
    let pool = await this.state.storage.get(PLAYER_POOL_STORAGE_KEY);
    if (!pool) {
      const origin = this.env.SITE_ORIGIN ?? "";
      const response = await fetch(`${origin}${PLAYER_POOL_PATH}`);
      if (!response.ok) throw new Error(`player pool fetch failed: ${response.status}`);
      const body = await response.json();
      pool = { lastUpdated: body.lastUpdated, players: body.players ?? [] };
      await this.state.storage.put(PLAYER_POOL_STORAGE_KEY, pool);
    }
    this.playerPoolOrder = pool.players;
    this.playersById = new Map(pool.players.map((player) => [player.id, player]));
  }
}

function publicPlayer(player) {
  return { id: player.id, name: player.name, team: player.team, position: player.position };
}
