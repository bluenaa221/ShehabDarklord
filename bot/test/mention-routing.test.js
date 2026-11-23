const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountsEngine } = require("../accounts-engine");
const { createCommandContext } = require("../main");

const silentLog = { error() {}, warn() {}, info() {} };

const SPY_COMMANDS = ["قصف", "حالة", "كاتش", "تثبيت"];

function fakeStore(records) {
  return {
    get: (id) => records.find((r) => r.id === id) || null,
    list: () => records.map(({ id, name, enabled }) => ({ id, name, enabled })),
    decrypt: (id) => (records.some((r) => r.id === id) ? [{ key: "c_user", value: id }] : null),
  };
}

function settle(ms = 50) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeFakeApi(id, sentMessages) {
  return {
    ctx: { lastSeqId: "1" },
    getAppState: () => [{ key: "c_user", value: id }],
    logout: () => {},
    getCurrentUserID: () => id,
    sendMessage: async (text, threadID) => {
      sentMessages.push({ botId: id, text: String(text).slice(0, 40), threadID });
    },
    setMessageReaction: async () => {},
    listenMqtt: async (onEvent) => {
      return () => {};
    },
  };
}

function setupEngine(records, onMessage, { executed = [], sentMessages = [] } = {}) {
  const listeners = new Map();

  const fakeLogin = (opts, loginOpts, cb) => {
    const id = opts.appState[0].value;
    const api = makeFakeApi(id, sentMessages);
    api.listenMqtt = async (onEvent) => {
      listeners.set(id, onEvent);
      return () => listeners.delete(id);
    };
    setImmediate(() => cb(null, api));
  };

  const engine = createAccountsEngine({
    store: fakeStore(records),
    onMessage: onMessage,
    onEvent: () => {},
    log: silentLog,
    loginFn: fakeLogin,
    contextFactory: () => {
      const ctx = createCommandContext();
      const originalLoad = ctx.loadCommands.bind(ctx);
      ctx.loadCommands = () => {
        originalLoad();
        for (const name of SPY_COMMANDS) {
          const cmd = ctx.commands.get(name);
          if (cmd && typeof cmd.execute === "function") {
            cmd.execute = (api, event) => {
              executed.push({ botId: String(api.getCurrentUserID()), name, body: (event.body || "").trim() });
              return Promise.resolve();
            };
          }
        }
      };
      return ctx;
    },
  });

  return { engine, listeners, sentMessages };
}

function deliverToAll(listeners, event) {
  for (const cb of listeners.values()) {
    cb(null, event);
  }
}

function makeRoute(engine) {
  return (account, event) => {
    const botID = String(account.api.getCurrentUserID());
    const allBotIds = engine.getAllBotIds();
    const anyMentioned = engine.isAnyBotMentioned(event, allBotIds);
    if (anyMentioned && !engine.isMentioned(event, botID)) return;
    const cleanEvent = anyMentioned
      ? engine.stripMentionFromEvent(event, botID)
      : event;
    const entry = engine.accounts.get(account.id);
    if (!entry || !entry.context) return;
    Promise.resolve(entry.context.handleMessage(account.api, cleanEvent)).catch(() => {});
  };
}

test("real Messenger format '@Zed قصف' with real mention — only mentioned bot executes, body arrives as 'قصف'", async () => {
  const delivered = [];
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => {
      const botID = String(account.api.getCurrentUserID());
      const allBotIds = engine.getAllBotIds();
      const anyMentioned = engine.isAnyBotMentioned(event, allBotIds);
      if (anyMentioned && !engine.isMentioned(event, botID)) return;
      const cleanEvent = anyMentioned
        ? engine.stripMentionFromEvent(event, botID)
        : event;
      const entry = engine.accounts.get(account.id);
      if (!entry || !entry.context) return;
      delivered.push({ botId: account.id, body: cleanEvent.body });
      Promise.resolve(entry.context.handleMessage(account.api, cleanEvent)).catch(() => {});
    },
    { executed, sentMessages },
  );

  await engine.startAll();
  await settle();

  const msg = {
    type: "message",
    threadID: "grp1",
    messageID: "m2",
    body: "@Zed قصف",
    senderID: "100078389536244",
    mentions: { "100": "@Zed" },
  };
  deliverToAll(listeners, msg);
  await settle(300);

  assert.equal(delivered.length, 1, "only bot 100 should process the message");
  assert.equal(delivered[0].botId, "100");
  assert.equal(delivered[0].body, "قصف", "body must be exactly 'قصف' after stripping '@Zed'");

  assert.equal(executed.length, 1, "exactly one command execution");
  assert.equal(executed[0].botId, "100");
  assert.equal(executed[0].name, "قصف");
  assert.equal(executed[0].body, "قصف");

  const bot200Messages = sentMessages.filter((m) => m.botId === "200");
  assert.equal(bot200Messages.length, 0, "bot 200 must not send any reply");
});

test("mention routing is generic: 4 different commands with real @ mentions execute only on the mentioned bot", async () => {
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => routeRef(account, event),
    { executed, sentMessages },
  );
  let routeRef = () => {};
  routeRef = makeRoute(engine);

  await engine.startAll();
  await settle();

  const cases = [
    { messageID: "c1", body: "@Zed قصف", mentions: { "100": "@Zed" }, expectedName: "قصف", expectedBody: "قصف" },
    { messageID: "c2", body: "@Zed حالة", mentions: { "100": "@Zed" }, expectedName: "حالة", expectedBody: "حالة" },
    { messageID: "c3", body: "@Zed كاتش 12345", mentions: { "100": "@Zed" }, expectedName: "كاتش", expectedBody: "كاتش 12345" },
    { messageID: "c4", body: "@Zed تثبيت", mentions: { "100": "@Zed" }, expectedName: "تثبيت", expectedBody: "تثبيت" },
  ];

  for (const c of cases) {
    deliverToAll(listeners, {
      type: "message",
      threadID: "grp1",
      senderID: "100078389536244",
      ...c,
    });
    await settle(200);
  }

  assert.equal(executed.length, 4, "each command must execute exactly once");
  for (let i = 0; i < cases.length; i += 1) {
    assert.equal(executed[i].botId, "100", `command ${cases[i].expectedName} must run only on mentioned bot 100`);
    assert.equal(executed[i].name, cases[i].expectedName);
    assert.equal(executed[i].body, cases[i].expectedBody, "cleaned body must reach the command without the @mention");
  }
  assert.equal(
    executed.filter((e) => e.botId === "200").length,
    0,
    "bot 200 must never execute any mentioned command",
  );
  assert.equal(sentMessages.filter((m) => m.botId === "200").length, 0, "bot 200 must not reply");
});

test("real @ mention targeting bot 200 — only bot 200 executes, bot 100 silent", async () => {
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => routeRef(account, event),
    { executed, sentMessages },
  );
  let routeRef = () => {};
  routeRef = makeRoute(engine);

  await engine.startAll();
  await settle();

  deliverToAll(listeners, {
    type: "message",
    threadID: "grp1",
    messageID: "m3",
    body: "@Zed قصف",
    senderID: "100078389536244",
    mentions: { "200": "@Zed" },
  });
  await settle(300);

  assert.equal(executed.length, 1);
  assert.equal(executed[0].botId, "200");
  assert.equal(executed[0].name, "قصف");
  assert.equal(executed[0].body, "قصف");
  assert.equal(sentMessages.filter((m) => m.botId === "100").length, 0, "bot 100 must not reply");
});

test("command without mention still reaches all bots (collective behavior preserved)", async () => {
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => routeRef(account, event),
    { executed, sentMessages },
  );
  let routeRef = () => {};
  routeRef = makeRoute(engine);

  await engine.startAll();
  await settle();

  deliverToAll(listeners, {
    type: "message",
    threadID: "grp1",
    messageID: "m1",
    body: "قصف",
    senderID: "100078389536244",
  });
  await settle(300);

  assert.equal(executed.length, 2, "both bots execute قصف");
  assert.deepEqual(executed.map((e) => e.botId).sort(), ["100", "200"]);
  assert.ok(executed.every((e) => e.body === "قصف"));

  deliverToAll(listeners, {
    type: "message",
    threadID: "grp1",
    messageID: "m1b",
    body: "اوامر",
    senderID: "100078389536244",
  });
  await settle(300);

  const menuReplies = sentMessages.filter((m) => m.botId === "100" || m.botId === "200");
  assert.ok(menuReplies.length >= 2, "اوامر menu should open on both bots");
});

test("mention tag without @ ('Zed') in body with '@Zed' prefix also strips cleanly", async () => {
  const engine = createAccountsEngine({
    store: fakeStore([]),
    onMessage: () => {},
    onEvent: () => {},
    log: silentLog,
    loginFn: () => {},
  });

  const cleaned = engine.stripMentionFromEvent(
    { body: "@Zed قصف", mentions: { "100": "Zed" } },
    "100",
  );
  assert.equal(cleaned.body, "قصف");

  const cleaned2 = engine.stripMentionFromEvent(
    { body: "@Zed قصف", mentions: { "100": "@Zed" } },
    "100",
  );
  assert.equal(cleaned2.body, "قصف");

  const cleaned3 = engine.stripMentionFromEvent(
    { body: "@Zed كاتش 55", mentions: { "fbid:100": "@Zed" } },
    "100",
  );
  assert.equal(cleaned3.body, "كاتش 55");
});

test("mentioning a non-bot user does not block all bots — all execute", async () => {
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => routeRef(account, event),
    { executed, sentMessages },
  );
  let routeRef = () => {};
  routeRef = makeRoute(engine);

  await engine.startAll();
  await settle();

  deliverToAll(listeners, {
    type: "message",
    threadID: "grp1",
    messageID: "m7",
    body: "@user قصف",
    senderID: "100078389536244",
    mentions: { "999": "@user" },
  });
  await settle(300);

  assert.equal(executed.length, 2, "both bots should process — mention is not a bot");
});

test("invalid mention (text-only @name without real mention data) does not block — all bots execute", async () => {
  const delivered = [];
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => {
      const botID = String(account.api.getCurrentUserID());
      const allBotIds = engine.getAllBotIds();
      const anyMentioned = engine.isAnyBotMentioned(event, allBotIds);
      if (anyMentioned && !engine.isMentioned(event, botID)) return;
      const cleanEvent = anyMentioned
        ? engine.stripMentionFromEvent(event, botID)
        : event;
      const entry = engine.accounts.get(account.id);
      if (!entry || !entry.context) return;
      delivered.push({ botId: account.id, body: cleanEvent.body });
      Promise.resolve(entry.context.handleMessage(account.api, cleanEvent)).catch(() => {});
    },
    { executed, sentMessages },
  );

  await engine.startAll();
  await settle();

  deliverToAll(listeners, {
    type: "message",
    threadID: "grp1",
    messageID: "m5",
    body: "@Zed قصف",
    senderID: "100078389536244",
    mentions: {},
  });
  await settle(300);

  assert.equal(delivered.length, 2, "both bots should process — no real mention");
  assert.equal(delivered[0].body, "@Zed قصف");
});

test("mention with fbid: prefix normalizes correctly — only mentioned bot executes", async () => {
  const executed = [];
  const sentMessages = [];
  const { engine, listeners } = setupEngine(
    [
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ],
    (account, event) => routeRef(account, event),
    { executed, sentMessages },
  );
  let routeRef = () => {};
  routeRef = makeRoute(engine);

  await engine.startAll();
  await settle();

  deliverToAll(listeners, {
    type: "message",
    threadID: "grp1",
    messageID: "m6",
    body: "@Zed قصف",
    senderID: "100078389536244",
    mentions: { "fbid:100": "@Zed" },
  });
  await settle(300);

  assert.equal(executed.length, 1, "only bot 100 should execute via fbid: prefix");
  assert.equal(executed[0].botId, "100");
});

test("disconnected mentioned bot still recognized — other bots do not execute the command", async () => {
  const listeners = new Map();
  const fakeLogin = (opts, loginOpts, cb) => {
    const id = opts.appState[0].value;
    const api = {
      ctx: { lastSeqId: "1" },
      getAppState: () => opts.appState,
      logout: () => {},
      getCurrentUserID: () => id,
      listenMqtt: async (onEvent) => {
        listeners.set(id, onEvent);
        return () => listeners.delete(id);
      },
    };
    setImmediate(() => cb(null, api));
  };

  const engine = createAccountsEngine({
    store: fakeStore([
      { id: "100", name: "بوت أ", enabled: true },
      { id: "200", name: "بوت ب", enabled: true },
    ]),
    onMessage: () => {},
    onEvent: () => {},
    log: silentLog,
    loginFn: fakeLogin,
  });

  await engine.startAll();
  await settle();

  const bot100Entry = engine.accounts.get("100");
  bot100Entry.account.api = null;
  bot100Entry.account.loggedIn = false;
  bot100Entry.account.status = "reconnecting";

  const event = {
    body: "@Zed قصف",
    mentions: { "100": "@Zed" },
  };

  const allBotIds = engine.getAllBotIds();
  assert.ok(
    allBotIds.includes("100"),
    "getAllBotIds must include bot 100 even when its api is disconnected",
  );
  assert.ok(
    allBotIds.includes("200"),
    "getAllBotIds must include bot 200",
  );

  const anyMentioned = engine.isAnyBotMentioned(event, allBotIds);
  assert.equal(anyMentioned, true, "isAnyBotMentioned must be true even if mentioned bot has no live api");
});

test("isAnyBotMentioned returns false for empty/null mentions", () => {
  const engine = createAccountsEngine({
    store: fakeStore([]),
    onMessage: () => {},
    onEvent: () => {},
    log: silentLog,
    loginFn: () => {},
  });

  assert.equal(engine.isAnyBotMentioned({ mentions: {} }, ["100", "200"]), false);
  assert.equal(engine.isAnyBotMentioned({}, ["100", "200"]), false);
  assert.equal(engine.isAnyBotMentioned(null, ["100", "200"]), false);
});

test("isMentioned handles fbid: prefix and plain IDs symmetrically", () => {
  const engine = createAccountsEngine({
    store: fakeStore([]),
    onMessage: () => {},
    onEvent: () => {},
    log: silentLog,
    loginFn: () => {},
  });

  assert.equal(engine.isMentioned({ mentions: { "fbid:123": "@Zed" } }, "123"), true);
  assert.equal(engine.isMentioned({ mentions: { "123": "@Zed" } }, "fbid:123"), true);
  assert.equal(engine.isMentioned({ mentions: { "456": "@Zed" } }, "123"), false);
  assert.equal(engine.isMentioned({ mentions: {} }, "123"), false);
  assert.equal(engine.isMentioned(null, "123"), false);
});

test.after(() => {
  setTimeout(() => process.exit(0), 100);
});
