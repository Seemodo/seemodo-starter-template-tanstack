import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

/** Minimal IncomingMessage stand-in. */
export function fakeRequest({
  method = "POST",
  url = "/",
  body,
  headers = {},
  remoteAddress = "127.0.0.1",
} = {}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  return req;
}

/** Minimal ServerResponse stand-in; `done` resolves when end() was called. */
export function fakeResponse() {
  let finish;
  const res = new EventEmitter();
  res.done = new Promise((resolve) => {
    finish = resolve;
  });
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.body = "";
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status;
    Object.assign(res.headers, headers);
    res.headersSent = true;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.end = (chunk = "") => {
    res.body += chunk;
    res.headersSent = true;
    res.emit("finish");
    finish();
  };
  res.json = () => (res.body ? JSON.parse(res.body) : undefined);
  return res;
}

/** A fake Vite dev server with a watcher, ws channel and middleware stack. */
export function fakeServer() {
  const middlewares = [];
  const listeners = new Map();
  const sent = [];
  const emitted = [];
  const watcher = {
    emit: (event, file) => {
      emitted.push([event, file]);
      return true;
    },
  };
  const ws = {
    clients: new Set(),
    send: (payload) => sent.push(payload),
    on: (event, fn) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
  };
  const server = {
    watcher,
    ws,
    environments: {},
    config: { logger: { warn() {}, error() {}, info() {} }, root: process.cwd() },
    middlewares: { use: (fn) => middlewares.push(fn) },
  };
  return {
    server,
    sent,
    emitted,
    trigger(event, data, client) {
      for (const fn of listeners.get(event) ?? []) fn(data, client);
    },
    /** Runs the middleware stack; resolves with the response (or "next" when nobody answered). */
    async request(options) {
      const req = fakeRequest(options);
      const res = fakeResponse();
      let index = 0;
      let passed = false;
      const next = () => {
        const fn = middlewares[index++];
        if (!fn) {
          passed = true;
          return;
        }
        fn(req, res, next);
      };
      next();
      if (passed) return "next";
      await res.done;
      return res;
    },
  };
}
