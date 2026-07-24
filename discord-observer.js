/**
 * Read-only Discord Gateway observer for ambient guild traffic.
 *
 * This module deliberately has no filesystem, OpenClaw transcript, model, or
 * Discord REST dependencies.  Its only outbound Discord frames are Gateway
 * protocol control frames (IDENTIFY, RESUME, and HEARTBEAT); it has no message
 * send implementation.
 */

const DISCORD_GATEWAY_URL =
  "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_INTENTS = 1 | 512 | 32768; // GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4009]);
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const SNOWFLAKE_RE = /^[0-9]{5,32}$/;

function cleanSnowflake(value) {
  const text = String(value ?? "").trim();
  return SNOWFLAKE_RE.test(text) ? text : "";
}

function decodeGatewayPayload(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(data));
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      ),
    );
  }
  return JSON.parse(String(data));
}

function addListener(socket, name, handler) {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(name, handler);
    return;
  }
  if (typeof socket.on === "function") {
    socket.on(name, handler);
    return;
  }
  socket[`on${name}`] = handler;
}

/**
 * Normalize one raw Discord MESSAGE_CREATE dispatch into the existing
 * OpenClaw-shaped event/context pair consumed by buildGuildObservation().
 */
export function gatewayMessageToPluginEvent(
  message,
  { botUserId = "", channelLabel = "" } = {},
) {
  if (!message || typeof message !== "object") return null;
  const guildId = cleanSnowflake(message.guild_id);
  const channelId = cleanSnowflake(message.channel_id);
  const messageId = cleanSnowflake(message.id);
  const senderId = cleanSnowflake(message.author?.id);
  const botId = cleanSnowflake(botUserId);
  const content = String(message.content ?? "").trim();
  if (!guildId || !channelId || !messageId || !senderId || !content) {
    return null;
  }
  if (
    message.webhook_id
    || message.author?.bot === true
    || (botId && senderId === botId)
  ) {
    return null;
  }

  const referenced = (
    message.referenced_message
    && typeof message.referenced_message === "object"
  )
    ? message.referenced_message
    : null;
  const replyTargetMessageId = cleanSnowflake(
    message.message_reference?.message_id ?? referenced?.id,
  );
  const replySenderId = cleanSnowflake(referenced?.author?.id);
  const senderName = String(
    message.member?.nick
      ?? message.author?.global_name
      ?? message.author?.username
      ?? "",
  ).trim();
  const replySenderName = String(
    referenced?.member?.nick
      ?? referenced?.author?.global_name
      ?? referenced?.author?.username
      ?? "",
  ).trim();

  return {
    event: {
      content,
      timestamp: message.timestamp,
      metadata: {
        guildId,
        channelName: String(channelLabel ?? "").trim(),
        messageId,
        senderId,
        senderName,
        senderUsername: String(message.author?.username ?? "").trim(),
        originatingTo: `channel:${channelId}`,
        ...(replyTargetMessageId
          ? { replyToId: replyTargetMessageId }
          : {}),
        ...(replySenderId ? { replySenderId } : {}),
      },
    },
    ctx: {
      channelId: "discord",
      conversationId: channelId,
      messageId,
      senderId,
      ...(replyTargetMessageId
        ? { replyToId: replyTargetMessageId }
        : {}),
      ...(replySenderName ? { replyToSender: replySenderName } : {}),
      ...(referenced?.content
        ? { replyToBody: String(referenced.content).trim() }
        : {}),
    },
  };
}

/**
 * Open a second, receive-only Discord Gateway session.
 *
 * RESUME is always preferred after READY.  Fresh IDENTIFY frames are limited
 * by a sliding-window circuit breaker so a broken observer cannot consume the
 * primary bot connection's identify budget.
 */
export function createDiscordGatewayObserver({
  token,
  botUserId,
  onMessageCreate,
  log = console,
  WebSocketImpl = globalThis.WebSocket,
  gatewayUrl = DISCORD_GATEWAY_URL,
  random = Math.random,
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  identifyWindowMs = 5 * 60 * 1000,
  maxIdentifiesPerWindow = 3,
  handshakeTimeoutMs = 15_000,
} = {}) {
  const cleanToken = String(token ?? "").trim();
  const expectedBotId = cleanSnowflake(botUserId);
  if (!cleanToken) throw new TypeError("Discord Gateway observer requires token");
  if (!expectedBotId) {
    throw new TypeError("Discord Gateway observer requires botUserId");
  }
  if (typeof onMessageCreate !== "function") {
    throw new TypeError(
      "Discord Gateway observer requires onMessageCreate",
    );
  }
  if (typeof WebSocketImpl !== "function") {
    throw new TypeError("Discord Gateway observer requires WebSocket");
  }

  let socket = null;
  let stopped = true;
  let fatal = false;
  let sequence = null;
  let sessionId = "";
  let resumeGatewayUrl = "";
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let handshakeTimer = null;
  let heartbeatStartTimer = null;
  let heartbeatTimer = null;
  let heartbeatAcked = true;
  let pendingReconnectDelay = null;
  const identifyTimestamps = [];
  const channelLabels = new Map();

  function clearHandshake() {
    if (handshakeTimer !== null) {
      clearTimeoutImpl(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function clearHeartbeat() {
    if (heartbeatStartTimer !== null) {
      clearTimeoutImpl(heartbeatStartTimer);
      heartbeatStartTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearIntervalImpl(heartbeatTimer);
      heartbeatTimer = null;
    }
    heartbeatAcked = true;
  }

  function sendFrame(frame) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  function sendHeartbeat() {
    if (!heartbeatAcked) {
      log.warn?.(
        "[vc] Discord observation Gateway missed heartbeat ACK; reconnecting",
      );
      try {
        socket?.close(4000, "heartbeat ACK timeout");
      } catch {
        // The explicit reconnect below owns recovery.
      }
      scheduleReconnect(250);
      return;
    }
    heartbeatAcked = false;
    sendFrame({ op: 1, d: sequence });
  }

  function identifyDelayMs() {
    const stamp = now();
    while (
      identifyTimestamps.length
      && stamp - identifyTimestamps[0] >= identifyWindowMs
    ) {
      identifyTimestamps.shift();
    }
    if (identifyTimestamps.length < maxIdentifiesPerWindow) return 0;
    return Math.max(
      1000,
      identifyWindowMs - (stamp - identifyTimestamps[0]),
    );
  }

  function gatewayEndpoint(base) {
    const clean = String(base || gatewayUrl)
      .replace(/[?].*$/, "")
      .replace(/\/+$/, "");
    return `${clean}/?v=10&encoding=json`;
  }

  function scheduleReconnect(delayOverride) {
    if (stopped || fatal || reconnectTimer !== null) return;
    const exponent = Math.min(reconnectAttempt, 6);
    const baseDelay = Math.min(60_000, 1000 * (2 ** exponent));
    const jittered = Math.round(baseDelay * (0.75 + (random() * 0.5)));
    const delay = Math.max(
      250,
      Number.isFinite(delayOverride) ? delayOverride : jittered,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function closeForReconnect(delayOverride = null) {
    pendingReconnectDelay = delayOverride;
    try {
      socket?.close(4000, "Gateway reconnect requested");
    } catch {
      // The explicit reconnect below owns recovery.
    }
    scheduleReconnect(delayOverride);
  }

  function authenticate() {
    if (sessionId && sequence !== null) {
      sendFrame({
        op: 6,
        d: {
          token: cleanToken,
          session_id: sessionId,
          seq: sequence,
        },
      });
      return;
    }
    identifyTimestamps.push(now());
    sendFrame({
      op: 2,
      d: {
        token: cleanToken,
        intents: DISCORD_INTENTS,
        properties: {
          os: "linux",
          browser: "virtual-context-observer",
          device: "virtual-context-observer",
        },
      },
    });
  }

  function rememberChannel(channel) {
    const channelId = cleanSnowflake(channel?.id);
    if (!channelId) return;
    const label = String(channel?.name ?? "").trim();
    if (label) channelLabels.set(channelId, label);
  }

  function forgetChannel(channel) {
    const channelId = cleanSnowflake(channel?.id);
    if (channelId) channelLabels.delete(channelId);
  }

  function handleDispatch(type, data) {
    if (type === "READY") {
      const readyBotId = cleanSnowflake(data?.user?.id);
      if (!readyBotId || readyBotId !== expectedBotId) {
        fatal = true;
        log.error?.(
          "[vc] Discord observation Gateway bot identity mismatch; observer stopped",
        );
        try {
          socket?.close(1000, "bot identity mismatch");
        } catch {
          // Fatal prevents reconnect.
        }
        return;
      }
      sessionId = String(data?.session_id ?? "").trim();
      resumeGatewayUrl = String(data?.resume_gateway_url ?? "").trim();
      reconnectAttempt = 0;
      for (const guild of data?.guilds ?? []) {
        for (const channel of guild?.channels ?? []) rememberChannel(channel);
        for (const thread of guild?.threads ?? []) rememberChannel(thread);
      }
      log.info?.(
        `[vc] Discord observation Gateway READY — bot=${readyBotId}`,
      );
      return;
    }
    if (type === "RESUMED") {
      reconnectAttempt = 0;
      log.info?.("[vc] Discord observation Gateway RESUMED");
      return;
    }
    if (type === "GUILD_CREATE") {
      for (const channel of data?.channels ?? []) rememberChannel(channel);
      for (const thread of data?.threads ?? []) rememberChannel(thread);
      return;
    }
    if (
      type === "CHANNEL_CREATE"
      || type === "CHANNEL_UPDATE"
      || type === "THREAD_CREATE"
      || type === "THREAD_UPDATE"
    ) {
      rememberChannel(data);
      return;
    }
    if (type === "CHANNEL_DELETE" || type === "THREAD_DELETE") {
      forgetChannel(data);
      return;
    }
    if (type !== "MESSAGE_CREATE") return;
    const channelId = cleanSnowflake(data?.channel_id);
    Promise.resolve(
      onMessageCreate(data, {
        channelLabel: channelLabels.get(channelId) ?? "",
      }),
    ).catch((error) => {
      log.error?.(
        `[vc] Discord observation MESSAGE_CREATE handler failed: ${String(error)}`,
      );
    });
  }

  function handleGatewayPayload(payload) {
    if (Number.isInteger(payload?.s)) sequence = payload.s;
    if (payload?.op === 0) {
      handleDispatch(String(payload.t ?? ""), payload.d);
      return;
    }
    if (payload?.op === 1) {
      sendHeartbeat();
      return;
    }
    if (payload?.op === 7) {
      closeForReconnect(250);
      return;
    }
    if (payload?.op === 9) {
      if (payload.d !== true) {
        sessionId = "";
        resumeGatewayUrl = "";
        sequence = null;
      }
      closeForReconnect(1000 + Math.round(random() * 4000));
      return;
    }
    if (payload?.op === 10) {
      clearHandshake();
      const rawInterval = Number(payload.d?.heartbeat_interval);
      if (!Number.isFinite(rawInterval) || rawInterval <= 0) {
        log.error?.(
          "[vc] Discord observation Gateway sent invalid heartbeat interval; reconnecting",
        );
        closeForReconnect(1000);
        return;
      }
      const interval = Math.max(1000, rawInterval);
      clearHeartbeat();
      heartbeatAcked = true;
      heartbeatStartTimer = setTimeoutImpl(() => {
        heartbeatStartTimer = null;
        sendHeartbeat();
        heartbeatTimer = setIntervalImpl(sendHeartbeat, interval);
      }, Math.floor(random() * interval));
      authenticate();
      return;
    }
    if (payload?.op === 11) heartbeatAcked = true;
  }

  function connect() {
    if (stopped || fatal) return;
    if (!sessionId) {
      const limiterDelay = identifyDelayMs();
      if (limiterDelay > 0) {
        log.error?.(
          `[vc] Discord observation Gateway IDENTIFY circuit open; retrying in ${limiterDelay}ms`,
        );
        scheduleReconnect(limiterDelay);
        return;
      }
    }
    const endpoint = gatewayEndpoint(
      sessionId && resumeGatewayUrl ? resumeGatewayUrl : gatewayUrl,
    );
    let connection;
    try {
      connection = new WebSocketImpl(endpoint);
    } catch (error) {
      log.warn?.(
        `[vc] Discord observation Gateway connect failed: ${String(error)}`,
      );
      scheduleReconnect();
      return;
    }
    socket = connection;
    clearHandshake();
    handshakeTimer = setTimeoutImpl(() => {
      if (socket !== connection || stopped || fatal) return;
      log.warn?.(
        "[vc] Discord observation Gateway timed out before HELLO; reconnecting",
      );
      try {
        connection.close(4000, "Gateway HELLO timeout");
      } catch {
        // The explicit reconnect below owns recovery.
      }
      scheduleReconnect(1000);
    }, Math.max(1000, Number(handshakeTimeoutMs) || 15_000));
    addListener(connection, "message", (event) => {
      if (socket !== connection) return;
      try {
        handleGatewayPayload(decodeGatewayPayload(event?.data ?? event));
      } catch (error) {
        log.warn?.(
          `[vc] Discord observation Gateway frame rejected: ${String(error)}`,
        );
      }
    });
    addListener(connection, "error", (error) => {
      if (socket !== connection) return;
      log.warn?.(
        `[vc] Discord observation Gateway socket error: ${String(
          error?.message ?? error,
        )}`,
      );
    });
    addListener(connection, "close", (event) => {
      if (socket !== connection) return;
      clearHandshake();
      clearHeartbeat();
      socket = null;
      const code = Number(event?.code ?? 0);
      if (FATAL_CLOSE_CODES.has(code)) {
        fatal = true;
        log.error?.(
          `[vc] Discord observation Gateway fatal close code=${code}; observer stopped`,
        );
        return;
      }
      if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
        sessionId = "";
        resumeGatewayUrl = "";
        sequence = null;
      }
      const delay = pendingReconnectDelay;
      pendingReconnectDelay = null;
      scheduleReconnect(delay);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      fatal = false;
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = null;
      }
      clearHeartbeat();
      clearHandshake();
      try {
        socket?.close(1000, "observer stopped");
      } catch {
        // Stop is best effort and never reconnects.
      }
      socket = null;
    },
    get state() {
      return {
        stopped,
        fatal,
        sessionId,
        sequence,
        reconnectAttempt,
        identifyCount: identifyTimestamps.length,
      };
    },
  };
}
