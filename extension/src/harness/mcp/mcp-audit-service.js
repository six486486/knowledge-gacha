(function (root, factory) {
  const utils = typeof module === "object" && module.exports
    ? require("../../shared/runtime-utils.js")
    : root.KnowledgeGachaRuntimeUtils;
  const tools = typeof module === "object" && module.exports
    ? require("../tools/tool-calling.js")
    : root.KnowledgeGachaHarnessTools;
  const api = factory(utils, tools);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaHarnessMcp = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (utils, tools) {
  "use strict";

  function recordAudit(db, toolName, status, approvalRequired, durationMs, timestamp) {
    db.audit.push({
      id: utils.id("audit"),
      direction: "inbound",
      source: "internal",
      name: toolName,
      serverId: "extension-harness",
      connectionId: "browser-session",
      permissions: tools.WRITE_TOOLS.has(toolName) ? ["learning.write"] : ["learning.read"],
      status: status,
      durationMs: Math.max(0, Number(durationMs) || 0),
      approvalRequired: approvalRequired,
      occurredAt: timestamp,
      errorCode: null
    });
    db.audit = db.audit.slice(-200);
  }

  function createMcpAuditService(context) {
    return {
      listMcpAudit: function () {
        const db = context.readDb();
        return Promise.resolve({
          items: db.audit.slice(-20).reverse(),
          replay: { after: 0, nextAfter: db.audit.length, hasMore: false },
          requestId: context.requestId()
        });
      }
    };
  }

  return { createMcpAuditService: createMcpAuditService, recordAudit: recordAudit };
});
