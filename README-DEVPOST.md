---
title: "Polyglot!"
subtitle: "Multi-language editing experience in VSCode"
---

# Motivation

Editing pieces of code embedded in string literals, aka _injected_ languages, inevitably show up in various fields, whether that's SQL in backend development, or shader (usually GLSL) code in graphics programming, or HTML fragments in quick and dirty apps.
The existing tooling around language injection are quite lackluster. VSCode, in particular, has zero _built-in_ support. Extensions need to do non-trivial engineering efforts to support _specific_ injected languages, such as CSS/JS in HTML. These efforts don't generalize.

Polygot! the extension solves this problem by enabling arbitary injection backed by the corresponding extensions.

# What it does

- Language Injection: enable auto-complete when edit pieces of code embedded in string literals (such as HTML or SQL)
- LLM Linting: provide AI-powered warnings, suggestions, and quickfixes, complementing the polyglot editing process

# Try it

You can download our preview extension from our GitHub repository's releases.

Insert a comment containing `@LANGUAGE:<lang>@` (where `<lang>` is the desired language's file extension) before any string, and then the string will be marked as as an injected fragment.
Edit directly and use <kbd>Ctrl+Space</kbd> to trigger auto-complete, or click the _New Tab_ code lenses above the literal to edit it in a separate tab, as-if it was a separate file with full extension support. Changes will be automatically synced back when saving.

Once provided with a Gemini API key, the AI-powered linting will automatically kick in for different files. Warnings produced is shown as squiggles. Ask the AI explain the warning by navigating to the quickfixes menu, and selecting `Explain`.

# How we built it

Polyglot! parses the file to look for comment markers and string literals after it. They will be extracted and synced to virtual documents and set to the corresponding language.

When editing in a separate tab, whichever extension is configured to support the language will automatically kick in on the virtual document.,

When editing inline, Polyglot! will forward the auto-complete request to the corresponding virtue document, letting the corresponding extension to handle it, if caret is inside an injected fragment.

# Challenges we ran into

Gemini was probably the easiest part of our journey. It's always a struggle
to get LLMs to output exactly what you want, but Gemini's structured outputs
made this a whole lot easier. Better yet, it was free.

On the other hand, VSCode is surprisingly difficult to work with. After finishing our AI features
in a couple of hours, we spent the rest of the time sobbing in front
of our computers as VSCode's virtual document API continually left us
with little to no information of what was actually going on and _way_
too many unexplained issues.

Also, it turns out there are a ton of different ways that language servers
work. While the protocol is standardized, each of the different language
servers we employed had its own way to respond (leading to some inelegant casewise solutions).

# What's Next

- Actually highlight all languages in string literals
- Make the extension use dynamic LSP providers instead of manually configured ones
- Better AI features
- Upstream the language injection parts

# What We Learned

- Simplicity comes at a cost
  - TextMate grammars aren't as powerful as we initially hoped
- Working != good
  - We had an initial version of language injection working around hour 12. It was a mess and we couldn't add any more features without it breaking. It's changed since then.
