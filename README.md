# Lahacks 2025 - Polyglot!

- ⚡ Language Injection[^1]: edit embedded languages like SQL and HTML faster and better, without having to open up a separate file.
- LLM-based, 
- 🤖 AI-powered warnings and suggestions that reasons across the whole file, seamlessly integrate into the developer workflow

## Overview

This VS Code extension integrates Google's Gemini AI directly into your development workflow. It provides intelligent code analysis features to help you write better code, whether you're a beginner or an experienced developer.

We also provide developer-friendly way to edit embedded languages, or languages that appear within other languages (think about the SQL that you write in most backends or the HTML that you).

## Impact

This extension has the potential to significantly impact the software development process by:

- **Improving code quality:** Real-time feedback and suggestions can help developers avoid common errors and write more robust code.
- **Improving productivity:** We all use language servers, normally without thinking about them. This extension brings them to embedded languages, bringing you back to the good old days when you just switched to using an IDE with autocomplete.

## How it's Better

Existing solutions often require developers to switch between different tools and platforms. This extension allows developers to seamlessly write multiple different languages in one file for a more streamlined and efficient workflow. Furthermore, it closely integrates Gemini AI into the VS Code environment for AI powered linting and diagnostics. Unlike solutions like Cursor, our extension proactively looks for optmizations in your code, in turn creating linting errors if any are found. Also, This extension is designed to be lightweight and performant, ensuring that it doesn't slow down your development process.

## Running the Project

1.  **Install VS Code:** Make sure you have VS Code installed.
2.  **Install the extension:** Open VS Code and go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`). Search for "Lahacks 2025 - VS Code Gemini AI Extension" and install it. Or, you can download the .vsix file on our repository and install it by running `code --install-extension ./lahacks2025-1.0.0.vsix`.
3.  **Set up your Configuration:** You will need to provide a Gemini API key to use the extension. You can do this by opening the VS Code settings (`Ctrl+,` or `Cmd+,`) and searching for "polyglot.geminiApiKey". Enter your API key in the text box. Repeat for "polyglot.clangd.path" (the path to your clangd installation) and "polyglot.pyright-langserver.path" (the path to your pyright-langserver installation)
4.  **Start coding:** The extension will automatically start providing AI-powered assistance as you type.

[^1]: akin to IntelliJ's implementation with the same name
