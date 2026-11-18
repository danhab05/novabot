import { expect, test } from "bun:test";
import { renderMarkdown } from "../src/lib/markdown";

test("échappe le HTML", () => {
  expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
});
test("liens javascript: refusés", () => {
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("href=\"javascript");
});
test("gras, code, liste, bloc", () => {
  const h = renderMarkdown("**ok** `a<b`\n\n- un\n- deux\n\n```\n<x>\n```");
  expect(h).toContain("<strong>ok</strong>");
  expect(h).toContain("<code>a&lt;b</code>");
  expect(h).toContain("<ul><li>un</li><li>deux</li></ul>");
  expect(h).toContain("<pre><code>&lt;x&gt;</code></pre>");
  expect(h).toContain("data-copy");
});
