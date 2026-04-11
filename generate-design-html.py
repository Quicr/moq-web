#!/usr/bin/env python3
"""
generate-design-html.py

Converts DESIGN.md to a beautifully styled HTML document with:
- Inter font (modern, highly readable)
- JetBrains Mono for code
- Deep ocean color palette with warm accents
- Dark/Light theme support
- Responsive design

Usage:
    python3 generate-design-html.py [input.md] [output.html]

If output is not specified, generates input_name.html (e.g., DESIGN.md -> DESIGN.html).
Title and footer are extracted from the first # heading in the markdown file.

If 'markdown' package is available, uses it for better conversion.
Otherwise, uses built-in regex-based conversion.
"""

import sys
import re
from pathlib import Path

# Try to import markdown library
try:
    import markdown
    from markdown.extensions.toc import TocExtension
    from markdown.extensions.fenced_code import FencedCodeExtension
    from markdown.extensions.tables import TableExtension
    HAS_MARKDOWN = True
except ImportError:
    HAS_MARKDOWN = False
    print("Note: 'markdown' package not found. Using built-in converter.")
    print("For better results: pip install markdown")
    print()


def convert_markdown_builtin(md_text: str) -> str:
    """Convert markdown to HTML using regex (fallback)."""

    html = md_text

    # Escape HTML in code blocks first (preserve them)
    code_blocks = []
    def save_code_block(match):
        code_blocks.append(match.group(0))
        return f"__CODE_BLOCK_{len(code_blocks) - 1}__"

    # Save fenced code blocks
    html = re.sub(r'```[\s\S]*?```', save_code_block, html)

    # Save inline code
    inline_codes = []
    def save_inline_code(match):
        inline_codes.append(match.group(1))
        return f"__INLINE_CODE_{len(inline_codes) - 1}__"
    html = re.sub(r'`([^`]+)`', save_inline_code, html)

    # Headers
    html = re.sub(r'^# (.+)$', r'<h1>\1</h1>', html, flags=re.MULTILINE)
    html = re.sub(r'^## (\d+)\. (.+)$',
                  lambda m: f'<h2 id="{m.group(2).lower().replace(" ", "-").replace("&", "").replace("/", "-")}">{m.group(1)}. {m.group(2)}</h2>',
                  html, flags=re.MULTILINE)
    html = re.sub(r'^## (.+)$',
                  lambda m: f'<h2 id="{m.group(1).lower().replace(" ", "-").replace("&", "").replace("/", "-")}">{m.group(1)}</h2>',
                  html, flags=re.MULTILINE)
    html = re.sub(r'^### (.+)$', r'<h3>\1</h3>', html, flags=re.MULTILINE)
    html = re.sub(r'^#### (.+)$', r'<h4>\1</h4>', html, flags=re.MULTILINE)

    # Bold and italic
    html = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', html)
    html = re.sub(r'\*([^*]+)\*', r'<em>\1</em>', html)

    # Links
    html = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', html)

    # Horizontal rules
    html = re.sub(r'^---+$', '<hr>', html, flags=re.MULTILINE)

    # Tables
    def convert_table(match):
        lines = match.group(0).strip().split('\n')
        if len(lines) < 2:
            return match.group(0)

        result = ['<table>']

        # Header row
        headers = [cell.strip() for cell in lines[0].split('|') if cell.strip()]
        result.append('<thead><tr>')
        for h in headers:
            result.append(f'<th>{h}</th>')
        result.append('</tr></thead>')

        # Body rows (skip separator line)
        result.append('<tbody>')
        for line in lines[2:]:
            if line.strip():
                cells = [cell.strip() for cell in line.split('|') if cell.strip()]
                result.append('<tr>')
                for c in cells:
                    result.append(f'<td>{c}</td>')
                result.append('</tr>')
        result.append('</tbody>')
        result.append('</table>')

        return '\n'.join(result)

    # Match tables (lines starting with |)
    html = re.sub(r'(?:^\|.+\|$\n)+', convert_table, html, flags=re.MULTILINE)

    # Lists
    def convert_list(match):
        items = match.group(0).strip().split('\n')
        result = ['<ul>']
        for item in items:
            item = re.sub(r'^[\s]*[-*]\s+', '', item)
            if item:
                result.append(f'<li>{item}</li>')
        result.append('</ul>')
        return '\n'.join(result)

    html = re.sub(r'(?:^[\s]*[-*]\s+.+$\n?)+', convert_list, html, flags=re.MULTILINE)

    # Restore code blocks
    for i, block in enumerate(code_blocks):
        lang_match = re.match(r'```(\w*)\n', block)
        lang = lang_match.group(1) if lang_match else ''
        code = re.sub(r'```\w*\n', '', block)
        code = re.sub(r'```$', '', code)
        # Escape HTML in code
        code = code.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        html = html.replace(f'__CODE_BLOCK_{i}__',
                           f'<pre><code class="language-{lang}">{code}</code></pre>')

    # Restore inline code
    for i, code in enumerate(inline_codes):
        code = code.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        html = html.replace(f'__INLINE_CODE_{i}__', f'<code>{code}</code>')

    # Paragraphs (wrap lines not in tags)
    lines = html.split('\n')
    result = []
    in_block = False
    para_buffer = []

    for line in lines:
        stripped = line.strip()

        # Check if we're entering or in a block element
        if stripped.startswith('<pre') or stripped.startswith('<table') or stripped.startswith('<ul') or stripped.startswith('<ol'):
            in_block = True
        if stripped.endswith('</pre>') or stripped.endswith('</table>') or stripped.endswith('</ul>') or stripped.endswith('</ol>'):
            in_block = False
            result.append(line)
            continue

        if in_block or stripped.startswith('<') or not stripped:
            # Flush paragraph buffer
            if para_buffer:
                result.append('<p>' + ' '.join(para_buffer) + '</p>')
                para_buffer = []
            result.append(line)
        else:
            para_buffer.append(stripped)

    # Flush remaining
    if para_buffer:
        result.append('<p>' + ' '.join(para_buffer) + '</p>')

    return '\n'.join(result)


def convert_markdown_library(md_text: str) -> str:
    """Convert markdown to HTML using the markdown library."""
    md = markdown.Markdown(extensions=[
        'fenced_code',
        'tables',
        'toc',
        'nl2br',
    ])
    return md.convert(md_text)


HTML_TEMPLATE = '''<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>

    <!-- Google Fonts - Product Sans style with Roboto -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&family=Roboto:wght@300;400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">

    <style>
        /* Google Color Palette */
        :root {
            /* Google Colors */
            --google-blue: #4285F4;
            --google-red: #EA4335;
            --google-yellow: #FBBC05;
            --google-green: #34A853;
            --google-blue-dark: #1a73e8;
            --google-blue-light: #8ab4f8;

            --bg-primary: #1a1a2e;
            --bg-secondary: #16213e;
            --bg-tertiary: #0f3460;
            --bg-card: #1a1a2e;
            --bg-code: #0d1117;
            --bg-code-inline: #21262d;

            --text-primary: #ffffff;
            --text-secondary: #c9d1d9;
            --text-muted: #8b949e;
            --text-code: #e6edf3;

            /* Vibrant accents using Google colors */
            --accent-primary: var(--google-blue);
            --accent-secondary: var(--google-red);
            --accent-tertiary: var(--google-green);
            --accent-warm: var(--google-yellow);
            --accent-pink: #e94560;

            --border-color: #30363d;
            --border-accent: var(--google-blue);
            --shadow-lg: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
            --shadow-glow: 0 0 40px rgba(66, 133, 244, 0.2);

            --content-width: 960px;

            /* Gradient colors */
            --gradient-google: linear-gradient(135deg, var(--google-blue), var(--google-red), var(--google-yellow), var(--google-green));
        }

        /* Light theme - Google style */
        @media (prefers-color-scheme: light) {
            :root {
                --bg-primary: #ffffff;
                --bg-secondary: #f8f9fa;
                --bg-tertiary: #e8eaed;
                --bg-card: #ffffff;
                --bg-code: #f8f9fa;
                --bg-code-inline: #e8eaed;
                --text-primary: #202124;
                --text-secondary: #5f6368;
                --text-muted: #80868b;
                --text-code: #202124;
                --border-color: #dadce0;
                --shadow-glow: 0 0 40px rgba(66, 133, 244, 0.1);
                --accent-warm: #ea8600;
            }
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        html {
            scroll-behavior: smooth;
            font-size: 16px;
        }

        body {
            font-family: 'Roboto', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.75;
            -webkit-font-smoothing: antialiased;
        }

        .container {
            max-width: var(--content-width);
            margin: 0 auto;
            padding: 3rem 2rem 6rem;
        }

        /* Typography - Google Style */
        h1 {
            font-family: 'Google Sans', 'Roboto', sans-serif;
            font-size: 3rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            letter-spacing: -0.02em;
            background: linear-gradient(135deg, var(--google-blue), var(--google-red), var(--google-yellow), var(--google-green));
            background-size: 300% 300%;
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            animation: gradient-shift 8s ease infinite;
        }

        @keyframes gradient-shift {
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }

        h2 {
            font-family: 'Google Sans', 'Roboto', sans-serif;
            font-size: 1.875rem;
            font-weight: 500;
            margin-top: 4rem;
            margin-bottom: 1.5rem;
            padding-bottom: 0.75rem;
            border-bottom: 3px solid transparent;
            border-image: linear-gradient(90deg, var(--google-blue), var(--google-green)) 1;
            letter-spacing: -0.01em;
            color: var(--text-primary);
        }

        h2::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 1.5rem;
            background: linear-gradient(180deg, var(--google-blue), var(--google-red));
            margin-right: 0.75rem;
            border-radius: 3px;
            vertical-align: middle;
        }

        h3 {
            font-family: 'Google Sans', 'Roboto', sans-serif;
            font-size: 1.375rem;
            font-weight: 500;
            margin-top: 2.5rem;
            margin-bottom: 1rem;
            color: var(--google-blue);
        }

        h4 {
            font-family: 'Google Sans', 'Roboto', sans-serif;
            font-size: 1.125rem;
            font-weight: 500;
            color: var(--google-green);
            margin-top: 2rem;
            margin-bottom: 0.75rem;
        }

        p {
            margin-bottom: 1.25rem;
            color: var(--text-secondary);
        }

        strong {
            font-weight: 600;
            color: var(--text-primary);
        }

        em {
            font-style: italic;
            color: var(--accent-tertiary);
        }

        a {
            color: var(--google-blue);
            text-decoration: none;
            transition: all 0.2s ease;
            border-bottom: 1px solid transparent;
            font-weight: 500;
        }

        a:hover {
            color: var(--google-blue-light);
            border-bottom-color: var(--google-blue-light);
        }

        /* Lists */
        ul, ol {
            margin-bottom: 1.5rem;
            padding-left: 1.5rem;
            color: var(--text-secondary);
        }

        li {
            margin-bottom: 0.5rem;
            padding-left: 0.5rem;
        }

        ul li::marker {
            color: var(--google-blue);
        }

        ol li::marker {
            color: var(--google-red);
            font-weight: 600;
        }

        /* Code */
        pre {
            background: var(--bg-code);
            border-radius: 12px;
            padding: 1.5rem;
            margin: 1.5rem 0;
            overflow-x: auto;
            border: 1px solid var(--border-color);
            border-left: 4px solid var(--google-blue);
            box-shadow: var(--shadow-lg);
            position: relative;
        }

        pre code {
            font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
            font-size: 0.875rem;
            line-height: 1.6;
            color: var(--text-code);
            background: none;
            padding: 0;
            border-radius: 0;
        }

        code {
            font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
            font-size: 0.875em;
            background: var(--bg-code-inline);
            color: var(--google-yellow);
            padding: 0.2em 0.5em;
            border-radius: 6px;
            border: 1px solid var(--border-color);
        }

        /* Tables - Google style */
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 1.5rem 0;
            background: var(--bg-card);
            border-radius: 12px;
            overflow: hidden;
            box-shadow: var(--shadow-lg);
            border: 1px solid var(--border-color);
        }

        th {
            background: linear-gradient(135deg, var(--google-blue), var(--google-blue-dark));
            color: white;
            font-weight: 500;
            text-align: left;
            padding: 1rem 1.25rem;
            font-size: 0.875rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        td {
            padding: 1rem 1.25rem;
            border-top: 1px solid var(--border-color);
            color: var(--text-secondary);
        }

        tr:hover td {
            background: var(--bg-secondary);
        }

        /* Alternate row coloring */
        tbody tr:nth-child(even) td {
            background: var(--bg-secondary);
        }

        tbody tr:nth-child(even):hover td {
            background: var(--bg-tertiary);
        }

        /* Blockquotes */
        blockquote {
            border-left: 4px solid var(--google-green);
            background: var(--bg-secondary);
            padding: 1rem 1.5rem;
            margin: 1.5rem 0;
            border-radius: 0 12px 12px 0;
            color: var(--text-secondary);
        }

        hr {
            border: none;
            height: 3px;
            background: linear-gradient(90deg, var(--google-blue), var(--google-red), var(--google-yellow), var(--google-green));
            margin: 3rem 0;
            border-radius: 2px;
        }

        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }

        ::-webkit-scrollbar-track {
            background: var(--bg-secondary);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb {
            background: var(--border-color);
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--text-muted);
        }

        /* Responsive */
        @media (max-width: 768px) {
            .container {
                padding: 2rem 1rem 4rem;
            }

            h1 {
                font-size: 2rem;
            }

            h2 {
                font-size: 1.5rem;
            }

            pre {
                padding: 1rem;
                font-size: 0.8rem;
            }
        }

        /* Print */
        @media print {
            body {
                background: white;
                color: black;
            }

            pre {
                background: #f5f5f5;
            }

            h1 {
                background: none;
                -webkit-text-fill-color: inherit;
                color: black;
            }
        }

        h2:hover, h3:hover {
            color: var(--google-blue);
        }

        :target {
            scroll-margin-top: 2rem;
        }

        /* TOC styling */
        .toc-list {
            background: var(--bg-secondary);
            border-radius: 12px;
            padding: 1.5rem 2rem;
            border-left: 4px solid var(--google-blue);
        }

        .toc-list a {
            display: inline-block;
            padding: 0.25rem 0;
            transition: transform 0.2s ease, color 0.2s ease;
        }

        .toc-list a:hover {
            transform: translateX(4px);
            color: var(--google-red);
        }

        .footer {
            margin-top: 4rem;
            padding-top: 2rem;
            border-top: 3px solid transparent;
            border-image: linear-gradient(90deg, var(--google-blue), var(--google-red), var(--google-yellow), var(--google-green)) 1;
            text-align: center;
            color: var(--text-muted);
            font-size: 0.875rem;
        }

        .footer em {
            color: var(--text-secondary);
        }

        /* Copy button for code blocks */
        .copy-btn {
            position: absolute;
            top: 0.5rem;
            right: 0.5rem;
            padding: 0.25rem 0.75rem;
            font-size: 0.75rem;
            font-family: 'Roboto', sans-serif;
            background: var(--google-blue);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            opacity: 0;
            transition: all 0.2s;
        }

        pre:hover .copy-btn {
            opacity: 1;
        }

        .copy-btn:hover {
            background: var(--google-blue-dark);
            transform: scale(1.05);
        }

        /* Google-style badges/pills for inline code */
        h2 code, h3 code, h4 code {
            background: var(--google-blue);
            color: white;
            font-size: 0.75em;
            padding: 0.2em 0.6em;
            border-radius: 12px;
            border: none;
            vertical-align: middle;
        }
    </style>
</head>
<body>
    <div class="container">
        {content}

        <div class="footer">
            <em>{title}</em>
        </div>
    </div>

    <script>
        // Generate IDs for h2/h3 headers based on their text content
        document.querySelectorAll('h2, h3').forEach(header => {
            if (!header.id) {
                const text = header.textContent.trim();
                // Generate ID: lowercase, replace spaces with dashes, remove special chars
                const id = text
                    .toLowerCase()
                    .replace(/[^a-z0-9\\s-]/g, '')
                    .replace(/\\s+/g, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '');
                header.id = id;
            }
        });

        // Add copy button to code blocks
        document.querySelectorAll('pre').forEach(block => {
            const button = document.createElement('button');
            button.className = 'copy-btn';
            button.textContent = 'Copy';
            block.appendChild(button);

            button.addEventListener('click', async () => {
                const code = block.querySelector('code');
                await navigator.clipboard.writeText(code.textContent);
                button.textContent = 'Copied!';
                setTimeout(() => button.textContent = 'Copy', 2000);
            });
        });

        // Smooth scrolling for anchor links with fuzzy matching
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function (e) {
                const href = this.getAttribute('href');
                const targetId = href.substring(1);

                // Try exact match first
                let target = document.getElementById(targetId);

                // If not found, try fuzzy match (handle different ID formats)
                if (!target) {
                    const searchText = targetId.replace(/-/g, ' ').toLowerCase();
                    document.querySelectorAll('h2, h3').forEach(header => {
                        const headerText = header.textContent.toLowerCase().replace(/[^a-z0-9\\s]/g, '');
                        if (headerText.includes(searchText) || searchText.includes(headerText.substring(0, 20))) {
                            target = header;
                        }
                    });
                }

                if (target) {
                    e.preventDefault();
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                    // Update URL hash
                    history.pushState(null, null, href);
                }
            });
        });
    </script>
</body>
</html>
'''


def extract_title(md_text: str) -> str:
    """Extract the first H1 title from markdown text."""
    match = re.search(r'^#\s+(.+)$', md_text, re.MULTILINE)
    if match:
        return match.group(1).strip()
    return "Document"


def main():
    input_file = sys.argv[1] if len(sys.argv) > 1 else 'DESIGN.md'

    input_path = Path(input_file)

    # Auto-generate output filename from input if not provided
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
    else:
        output_file = input_path.stem + '.html'

    output_path = Path(output_file)

    if not input_path.exists():
        print(f"Error: Input file '{input_file}' not found.")
        sys.exit(1)

    print(f"Converting {input_file} to {output_file}...")

    md_text = input_path.read_text(encoding='utf-8')

    # Extract title from markdown content
    title = extract_title(md_text)
    print(f"Title: {title}")

    if HAS_MARKDOWN:
        print("Using 'markdown' library for conversion...")
        html_content = convert_markdown_library(md_text)
    else:
        print("Using built-in converter...")
        html_content = convert_markdown_builtin(md_text)

    final_html = HTML_TEMPLATE.replace('{title}', title)
    final_html = final_html.replace('{content}', html_content)

    output_path.write_text(final_html, encoding='utf-8')

    print()
    print("=" * 50)
    print("  HTML generated successfully!")
    print("=" * 50)
    print()
    print(f"  Input:  {input_file}")
    print(f"  Output: {output_file}")
    print()
    print("  Open in browser:")
    print(f"    open {output_file}")
    print()
    print("  Features:")
    print("    - Inter font (modern, readable)")
    print("    - JetBrains Mono for code")
    print("    - Dark/Light theme support")
    print("    - Responsive design")
    print("    - Copy button on code blocks")
    print()


if __name__ == '__main__':
    main()
