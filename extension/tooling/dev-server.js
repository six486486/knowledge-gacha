#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.WEB_HOST || "127.0.0.1";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function resolveStaticPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl || "/", "http://localhost").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}

function serveStatic(request, response) {
  let target;
  try {
    target = resolveStaticPath(request.url);
  } catch (_error) {
    sendJson(response, 400, { error: "Invalid URL" });
    return;
  }
  if (!target) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  fs.stat(target, function (statError, stats) {
    if (statError || !stats.isFile()) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const headers = {
      "content-type": MIME_TYPES[path.extname(target).toLowerCase()] || "application/octet-stream",
      "content-length": stats.size,
      "cache-control": "no-store"
    };
    response.writeHead(200, headers);
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(target).pipe(response);
  });
}

const server = http.createServer(function (request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  serveStatic(request, response);
});

server.listen(PORT, HOST, function () {
  console.log(`Knowledge Gacha web preview: http://${HOST}:${PORT}`);
});
