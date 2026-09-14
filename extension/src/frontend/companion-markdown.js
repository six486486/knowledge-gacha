(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.KnowledgeGachaCompanionMarkdown = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  // Deliberately limited Markdown: all source text is escaped, with no HTML,
  // links, images or attributes from the model. Citations use the host's UI.
  function escape(text) { return String(text).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function inline(text) {
    const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
    let html = "", end = 0;
    for (const match of text.matchAll(pattern)) {
      html += escape(text.slice(end, match.index));
      const tag = match[1] ? "code" : match[2] ? "strong" : "em";
      html += "<" + tag + ">" + escape(match[1] || match[2] || match[3]) + "</" + tag + ">";
      end = match.index + match[0].length;
    }
    return html + escape(text.slice(end));
  }
  function cells(line) { return line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(function (cell) { return cell.trim().replace(/\\\|/g, "|"); }); }
  function render(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const parts = [];
    let paragraph = [];
    function flush() { if (paragraph.length) { parts.push("<p>" + paragraph.map(inline).join("<br>") + "</p>"); paragraph = []; } }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        flush(); const code = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
        parts.push('<pre tabindex="0"><code>' + escape(code.join("\n")) + "</code></pre>"); continue;
      }
      if (!line.trim()) { flush(); continue; }
      if (line.includes("|") && i + 1 < lines.length && cells(lines[i + 1]).length > 1 && cells(lines[i + 1]).every(function (cell) { return /^:?-{3,}:?$/.test(cell); })) {
        flush(); const headers = cells(line); i += 1;
        let table = '<div class="companion-table" tabindex="0" role="region" aria-label="回答中的表格"><table><thead><tr>' + headers.map(function (cell) { return "<th scope=\"col\">" + inline(cell) + "</th>"; }).join("") + "</tr></thead><tbody>";
        while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) {
          const row = cells(lines[++i]); table += "<tr>" + headers.map(function (_, n) { return "<td>" + inline(row[n] || "") + "</td>"; }).join("") + "</tr>";
        }
        parts.push(table + "</tbody></table></div>"); continue;
      }
      const item = line.match(/^\s*(?:([-+*]) |(\d+)[.)] )(.*)$/);
      if (item) {
        flush(); const ordered = Boolean(item[2]), tag = ordered ? "ol" : "ul", items = [inline(item[3])];
        while (i + 1 < lines.length) {
          const next = lines[i + 1].match(ordered ? /^\s*\d+[.)] (.*)$/ : /^\s*[-+*] (.*)$/);
          if (!next) break;
          items.push(inline(next[1])); i += 1;
        }
        parts.push("<" + tag + ">" + items.map(function (text) { return "<li>" + text + "</li>"; }).join("") + "</" + tag + ">"); continue;
      }
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) { flush(); parts.push("<h3>" + inline(heading[1]) + "</h3>"); continue; }
      if (/^>\s?/.test(line)) { flush(); parts.push("<blockquote>" + inline(line.replace(/^>\s?/, "")) + "</blockquote>"); continue; }
      paragraph.push(line);
    }
    flush(); return parts.join("");
  }
  return { render: render };
});
