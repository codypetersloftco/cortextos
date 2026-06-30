import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { renderMarkdownToHtml, renderMarkdownIndex } from '../../../src/bus/render-html';

// ---------------------------------------------------------------------------
// renderMarkdownToHtml — deterministic Markdown -> self-contained styled HTML
// report. No LLM, no external assets. The HARD requirement is escaping: report
// content must never be able to break the page or inject markup.
// ---------------------------------------------------------------------------

describe('renderMarkdownToHtml — document shell', () => {
  it('emits a self-contained HTML document with an inline <style> and no external assets', () => {
    const html = renderMarkdownToHtml('# Title\n\nBody.');
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('<style>');
    expect(html).toContain('</html>');
    // self-contained: no external stylesheet links, no remote scripts/images
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:\/\/[^"']*\.css/i);
  });

  it('auto-derives the <title> from the first H1', () => {
    const html = renderMarkdownToHtml('# My Report\n\ntext');
    expect(html).toMatch(/<title>My Report<\/title>/);
  });

  it('escapes the title derived from the H1', () => {
    const html = renderMarkdownToHtml('# A <b> & "Q"\n');
    expect(html).toContain('<title>A &lt;b&gt; &amp; &quot;Q&quot;</title>');
  });
});

describe('renderMarkdownToHtml — block elements', () => {
  it('renders h1-h4', () => {
    const html = renderMarkdownToHtml('# H1\n## H2\n### H3\n#### H4');
    expect(html).toMatch(/<h1[^>]*>H1<\/h1>/);
    expect(html).toMatch(/<h2[^>]*>H2<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>H3<\/h3>/);
    expect(html).toMatch(/<h4[^>]*>H4<\/h4>/);
  });

  it('renders a paragraph', () => {
    expect(renderMarkdownToHtml('Just a line.')).toMatch(/<p>Just a line\.<\/p>/);
  });

  it('renders bold, italic, and inline code', () => {
    const html = renderMarkdownToHtml('a **bold** and *italic* and `code` here');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
  });

  it('renders a fenced code block with content escaped and no inline applied', () => {
    const html = renderMarkdownToHtml('```\nif (a < b && c) { x(); } *not italic*\n```');
    expect(html).toMatch(/<pre><code>[\s\S]*<\/code><\/pre>/);
    expect(html).toContain('a &lt; b &amp;&amp; c');
    expect(html).toContain('*not italic*'); // inline NOT processed inside code
    expect(html).not.toContain('<em>not italic</em>');
  });

  it('renders a horizontal rule', () => {
    expect(renderMarkdownToHtml('a\n\n---\n\nb')).toMatch(/<hr\s*\/?>/);
  });

  it('renders a blockquote', () => {
    expect(renderMarkdownToHtml('> quoted')).toMatch(/<blockquote>[\s\S]*quoted[\s\S]*<\/blockquote>/);
  });

  it('renders a link with the href escaped', () => {
    const html = renderMarkdownToHtml('see [docs](https://example.com/a)');
    expect(html).toContain('<a href="https://example.com/a">docs</a>');
  });
});

describe('renderMarkdownToHtml — tables (must-have)', () => {
  it('renders a GFM pipe table into thead/tbody', () => {
    const md = [
      '| Name | Call |',
      '| --- | --- |',
      '| Walls | KEEP |',
      '| Truss | BUILD |',
    ].join('\n');
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<table>');
    expect(html).toMatch(/<thead>[\s\S]*<th>Name<\/th>[\s\S]*<th>Call<\/th>[\s\S]*<\/thead>/);
    expect(html).toMatch(/<tbody>[\s\S]*<td>Walls<\/td>[\s\S]*<td>KEEP<\/td>[\s\S]*<\/tbody>/);
    expect(html).toContain('<td>BUILD</td>');
  });

  it('applies inline formatting inside table cells but escapes html', () => {
    const md = '| A | B |\n| --- | --- |\n| **bold** | a<b |';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<td><strong>bold</strong></td>');
    expect(html).toContain('<td>a&lt;b</td>');
  });
});

describe('renderMarkdownToHtml — lists (nested must-have)', () => {
  it('renders an unordered list', () => {
    const html = renderMarkdownToHtml('- one\n- two');
    expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  });

  it('renders an ordered list', () => {
    const html = renderMarkdownToHtml('1. first\n2. second');
    expect(html).toMatch(/<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
  });

  it('renders a nested list inside a parent item', () => {
    const md = '- parent\n  - child a\n  - child b\n- parent2';
    const html = renderMarkdownToHtml(md);
    // child list is nested within the first <li>, before that li closes
    expect(html).toMatch(/<li>parent\s*<ul>\s*<li>child a<\/li>\s*<li>child b<\/li>\s*<\/ul>\s*<\/li>/);
    expect(html).toContain('<li>parent2</li>');
  });
});

describe('renderMarkdownToHtml — ESCAPING (the crux)', () => {
  it('renders a literal <script> in body text inert (escaped, not a live tag)', () => {
    const html = renderMarkdownToHtml('Danger: <script>alert(1)</script> end');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // the only <script tokens in the doc must be the escaped ones — no live tag
    expect(html).not.toMatch(/<script\b/i);
  });

  it('escapes &, <, >, " in paragraph text', () => {
    const html = renderMarkdownToHtml('5 < 3 & "quoted" > 1');
    expect(html).toContain('5 &lt; 3 &amp; &quot;quoted&quot; &gt; 1');
  });

  it('escapes html inside a fenced code block', () => {
    const html = renderMarkdownToHtml('```\n<div class="x">&</div>\n```');
    expect(html).toContain('&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;');
  });

  it('does not allow a link URL to break out of the href attribute', () => {
    const html = renderMarkdownToHtml('[x](https://e.com/"onmouseover="alert(1))');
    // the double-quote in the URL must be escaped so it cannot close the attribute
    expect(html).not.toMatch(/href="https:\/\/e\.com\/"\s*onmouseover/i);
    expect(html).toContain('&quot;onmouseover');
  });
});

describe('renderMarkdownIndex — multi-file (native, not a retrofit)', () => {
  const files = [
    { name: 'alpha.md', content: '# Alpha Report\n\nFirst body. <script>x</script>' },
    { name: 'beta.md', content: '# Beta Notes\n\n| A | B |\n| --- | --- |\n| 1 | 2 |' },
  ];

  it('produces ONE self-contained HTML doc with body content escaped (crux carried through)', () => {
    const html = renderMarkdownIndex(files);
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('<style>');
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i); // alpha's <script> must be inert
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('includes a TOC whose anchors resolve to each rendered section', () => {
    const html = renderMarkdownIndex(files);
    const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    for (const id of ids) {
      expect(html).toContain(`href="#${id}"`);
    }
  });

  it('titles each section (from its H1) and renders each doc body in its own section', () => {
    const html = renderMarkdownIndex(files);
    expect(html).toContain('Alpha Report');
    expect(html).toContain('Beta Notes');
    expect(html).toContain('<td>1</td>'); // beta's table rendered in-section
  });

  it('falls back to the filename for a doc with no H1', () => {
    const html = renderMarkdownIndex([{ name: 'no-title.md', content: 'just body' }]);
    expect(html).toContain('no-title.md');
  });

  it('gives same-titled docs distinct anchors (no collision)', () => {
    const html = renderMarkdownIndex([
      { name: 'a.md', content: '# Same\n\nA' },
      { name: 'b.md', content: '# Same\n\nB' },
    ]);
    const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('renderMarkdownToHtml — link scheme sanitization (Prism block must-fix 1)', () => {
  it('renders a javascript: link INERT (no anchor), label preserved', () => {
    const html = renderMarkdownToHtml('click [x](javascript:alert(1))');
    expect(html).not.toMatch(/<a\s+href=/i);
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('x'); // label survives as text
  });

  it('renders a mixed-case JaVaScRiPt: link inert', () => {
    const html = renderMarkdownToHtml('[x](JaVaScRiPt:alert(1))');
    expect(html).not.toMatch(/<a\s+href=/i);
  });

  it('renders a control-char-prefixed javascript: link inert (fails closed)', () => {
    const html = renderMarkdownToHtml('[x](' + String.fromCharCode(1) + 'javascript:alert(1))');
    expect(html).not.toMatch(/<a\s+href=/i);
  });

  it('renders a data: link inert', () => {
    const html = renderMarkdownToHtml('[x](data:text/html,foo)');
    expect(html).not.toMatch(/<a\s+href=/i);
  });

  it('still renders a safe https link as an anchor', () => {
    const html = renderMarkdownToHtml('[ok](https://example.com/a)');
    expect(html).toContain('<a href="https://example.com/a">ok</a>');
  });

  it('still renders a mailto link as an anchor', () => {
    const html = renderMarkdownToHtml('[mail](mailto:a@b.com)');
    expect(html).toContain('<a href="mailto:a@b.com">mail</a>');
  });

  it('renders a local #anchor link', () => {
    const html = renderMarkdownToHtml('[top](#section-1)');
    expect(html).toContain('<a href="#section-1">top</a>');
  });

  it('sanitizes an unsafe scheme inside a table cell too', () => {
    const md = '| Link |\n| --- |\n| [x](javascript:alert(1)) |';
    const html = renderMarkdownToHtml(md);
    expect(html).not.toMatch(/<a\s+href=/i);
  });
});

describe('render-html source hygiene (Prism block must-fix 2)', () => {
  it('the source file contains no NUL bytes (stays text-reviewable / non-binary)', () => {
    const buf = readFileSync('src/bus/render-html.ts');
    expect(buf.includes(0x00)).toBe(false);
  });
});
