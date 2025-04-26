/* eslint-disable @typescript-eslint/no-unused-vars */
import * as path from 'path';
import {
  commands,
  CompletionList,
  ExtensionContext,
  Uri,
  workspace,
} from "vscode";
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from "vscode-languageclient";

const virtualDocumentContents = new Map<string, string>();

let theClient: LanguageClient;

function canonUri(uri: Uri): string {
  const originalUri = uri.path.slice(1).slice(0, -4);
  return decodeURIComponent(originalUri);
}

interface Region {
  start: number;
  end: number;
}

function filterDocContent(doc: string, regions: Region[]): string {
  let content = doc.replace(/[^\n]/g, ' ');
  for (const r of regions) {
    content = content.slice(0, r.start) + doc.slice(r.start, r.end) + content.slice(r.end);
  }
  return content;
}

function parseInjections(doc: string): Region[] {
  const rx = /@LANGUAGE:([^@]*)@/g;
  let match: RegExpExecArray;
  const regions: Region[] = [];
  while ((match = rx.exec(doc)) !== null) {
    const sbegRx = /R"""\(/g;
    sbegRx.lastIndex = match.index;
    const sbeg = sbegRx.exec(doc);
    if (!sbeg) { return regions; }

    const sendRx = /\)"""/g;
    sendRx.lastIndex = sbeg.index;
    const send = sendRx.exec(doc);
    if (!send) { return regions; }

    regions.push({ start: sbeg.index + sbeg[0].length, end: send.index });
    // Look for injection annotation after this snippet
    rx.lastIndex = send.index;
  }
  return regions;
}

export function activate(context: ExtensionContext) {
  testParseInjections();

  
  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    command: 'clangd',
  };

  workspace.registerTextDocumentContentProvider('embedded-content', {
    provideTextDocumentContent: uri => {
      return virtualDocumentContents.get(canonUri(uri));
    }
  });

  workspace.onDidChangeTextDocument(e => {
    for (const ch of e.contentChanges) {
      const st = e.document.offsetAt(ch.range.start);
      const ed = e.document.offsetAt(ch.range.end);

    }
  });

  workspace.onDidCloseTextDocument(e => {
    virtualDocumentContents.delete(canonUri(e.uri));
  });

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'cpp' }],
    middleware: {
      provideCompletionItem: async (document, position, context, token, next) => {
        const injectionLang = "";
        // !isInsideStyleRegion(htmlLanguageService, document.getText(), document.offsetAt(position))

        // If not in an injection fragment, forward the request to primary LS directly
        if (!injectionLang) {
          return await next(document, position, context, token);
        }

        // Otherwise, forward to minion LS
        const originalUri = encodeURIComponent(document.uri.toString(true));
        // TODO
        virtualDocumentContents.set(originalUri, "");

        const vdocUriString = `embedded-content://${injectionLang}/${originalUri}.${injectionLang}`;
        const vdocUri = Uri.parse(vdocUriString);
        return await commands.executeCommand<CompletionList>(
          'vscode.executeCompletionItemProvider',
          vdocUri,
          position,
          context.triggerCharacter
        );
      }
    }
  };

  // Create the language client and start the client.
  theClient = new LanguageClient(
    'lahacksDemo',
    'C++ (Fancy)',
    serverOptions,
    clientOptions
  );

  // Start the client. This will also launch the server
  theClient.start();
}

export async function deactivate(): Promise<void> {
  if (!theClient) {
    return undefined;
  }
  return theClient.stop();
}





function testParseInjections() {
  const i = "// @LANGUAGE: sql@\nauto s = R\"\"\"(some code here)\"\"\"";
  const pp = parseInjections(i);
  const sec = i.substring(pp[0].start, pp[0].end);
  return sec;
}
