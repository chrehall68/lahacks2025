import * as vscode from "vscode";
import { Uri } from "vscode";

export const FS_SCHEME = "fragments";

// js, py, cpp, etc.
// The thing that is put into @LANGUAGE:__@ and into vdoc Uri
export type LangFileExtension = "js" | "ts" | "py" | "cpp" | "sql";
// javascript, python, cpp, etc.
// The thing extensions & syntaxes registers to provide
export type LangId = "javascript" | "typescript" | "python" | "cpp" | "sql";

interface FragmentDelims {
  sbeg: RegExp;
  send: RegExp;
}

// HERE BE DRAGON: RegExp.lastIndex is the only state of the matching machinery, and since this is single-threaded, we don't care about sharing RegExp objects
export const fragdelimsFor: Record<LangId, FragmentDelims> = {
  cpp: { sbeg: /R"""\(/g, send: /\)"""/g },
  python: { sbeg: /"""/g, send: /"""/g },
  // HERE BE DRAGON: just ignore escaped \` for this demo...
  javascript: { sbeg: /`/g, send: /`/g },
  typescript: { sbeg: /`/g, send: /`/g },
  sql: undefined,
};

// TODO support only parse for begin delimiter on the next line, to prevent misuses
export function parseInjections(doc: string, rx: FragmentDelims): Fragment[] {
  const rxInjectionTag = /@LANGUAGE:([^@]*)@/g;
  let match: RegExpExecArray;
  const frags: Fragment[] = [];
  const now = Date.now();
  while ((match = rxInjectionTag.exec(doc)) !== null) {
    rx.sbeg.lastIndex = match.index + match[0].length;
    const sbeg = rx.sbeg.exec(doc);
    if (!sbeg) {
      break;
    }

    rx.send.lastIndex = sbeg.index + sbeg[0].length;
    const send = rx.send.exec(doc);
    if (!send) {
      break;
    }

    const begin = sbeg.index + sbeg[0].length;
    const end = send.index;
    frags.push(
      new Fragment(
        match[1] as LangFileExtension,
        begin,
        end,
        now,
        now,
        Buffer.from(doc.substring(begin, end))
      )
    );
    // Look for injection annotation after this snippet
    rxInjectionTag.lastIndex = send.index;
  }
  return frags;
}

export function parseMarkdownInjections(doc: string): Fragment[] {
  const rxInjectionBeg = /```([^\n]+)\n/g;
  let match: RegExpExecArray;
  const frags: Fragment[] = [];
  const now = Date.now();
  while ((match = rxInjectionBeg.exec(doc)) !== null) {
    // FIXME(rtk0c): markdown probably has a way to escape ``` inside a codeblock
    const rxInjectionEnd = /```/g;
    rxInjectionEnd.lastIndex = match.index + match[0].length;
    const injectionEnd = rxInjectionEnd.exec(doc);
    if (!injectionEnd) {
      break;
    }

    const begin = match.index + match[0].length;
    const end = injectionEnd.index;
    frags.push(
      new Fragment(
        match[1] as LangFileExtension,
        begin,
        end,
        now,
        now,
        Buffer.from(doc.substring(begin, end))
      )
    );
  }
  return frags;
}

class TextDocumentAttachments {
  fragments: Fragment[] = [];
  document: vscode.TextDocument;
}

export class Fragment implements vscode.FileStat {
  get type() {
    return vscode.FileType.File;
  }

  ctime: number;
  mtime: number;
  langFileExt: LangFileExtension;
  fileContent: Uint8Array;
  start: number;
  end: number;

  constructor(
    langFileExt: LangFileExtension,
    start: number,
    end: number,
    ctime: number,
    mtime: number,
    fileContent: Uint8Array
  ) {
    this.langFileExt = langFileExt;
    this.start = start;
    this.end = end;
    this.ctime = ctime;
    this.mtime = mtime;
    this.fileContent = fileContent;
  }

  get size() {
    return this.fileContent.byteLength;
  }
}

export function vdoc2orig(uri: Uri): string {
  // Apparently, if an encoded URI component is used, that part becomes the authority, instead a part of the path?
  // const preStrip = uri.path.slice(1);
  // const postStrip = preStrip.slice(0, preStrip.lastIndexOf("/"));
  // return decodeURIComponent(postStrip);
  return uri.authority;
}

// frag5.js
// => js
export function vdocGetLang(uri: Uri): string {
  return uri.path.slice(uri.path.lastIndexOf(".") + 1);
}

// frag5.js
// => 5
export function vdocGetIndex(uri: Uri): number {
  const filePart: string = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  const numPart = filePart.match(/^frag(\d+)/)[1];
  return parseInt(numPart);
}

export function orig2vdoc(
  uri: Uri,
  index: number,
  langExt: LangFileExtension
): Uri {
  const originalUri = encodeURIComponent(canonOrigUri(uri));
  const vdocUriString = `${FS_SCHEME}://${originalUri}/frag${index}.${langExt}`;
  return Uri.parse(vdocUriString);
}

export function canonOrigUri(uri: Uri): string {
  let res = uri.path;
  // HACK: vscode seesm to ignore { isCaseSensitive: true }
  //       canon to lowercase as vscode seems to be doing in openTextDocument()
  res = res.toLowerCase();
  return res;
}

export class FragmentsFS implements vscode.FileSystemProvider {
  // Map key: path of the original file
  files = new Map<string, TextDocumentAttachments>();

  onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  onDidChangeFile = this.onDidChangeFileEmitter.event;

  updateDocument(
    document: vscode.TextDocument,
    delta?: readonly vscode.TextDocumentContentChangeEvent[]
  ) {
    // apply changes in order, as said by docs
    let docText = document.getText();
    for (const change of delta || []) {
      docText =
        docText.slice(0, change.rangeOffset) +
        change.text +
        docText.slice(change.rangeOffset + change.rangeLength);
    }

    const att = this._getOrMakeAtt(document.uri);
    att.document = document;

    this._onUpdate(att.document, att, docText);
  }
  _onUpdate(
    document: vscode.TextDocument,
    att: TextDocumentAttachments,
    docText: string
  ) {
    // reparse
    if (document.languageId == "markdown") {
      att.fragments = parseMarkdownInjections(docText);
    } else {
      att.fragments = parseInjections(
        docText,
        fragdelimsFor[document.languageId]
      );
    }

    // emit event
    const events = [];
    let idx = 0;
    for (const frag of att.fragments) {
      events.push({
        type: vscode.FileChangeType.Changed,
        uri: orig2vdoc(document.uri, idx, frag.langFileExt),
      });
      idx++;
    }
    this.onDidChangeFileEmitter.fire(events);
  }

  removeDocument(primary: Uri) {
    const key = canonOrigUri(primary);
    const events = [];
    let idx = 0;
    for (const fragment of this.files.get(key).fragments.values()) {
      events.push({
        type: vscode.FileChangeType.Deleted,
        uri: orig2vdoc(primary, idx, fragment.langFileExt),
      });
      idx++;
    }
    this.onDidChangeFileEmitter.fire(events);
    this.files.delete(key);
  }

  // --- manage file metadata
  stat(uri: Uri): vscode.FileStat {
    return this._lookup(uri);
  }

  readDirectory(uri: Uri): [string, vscode.FileType][] {
    const hostFile = vdoc2orig(uri);
    const att = this.files.get(hostFile);
    if (!att) {
      return null;
    }
    const res = [];
    for (const fragment of Object.values(att.fragments)) {
      res.push([`frag.${fragment.langFileExt}`, vscode.FileType.File]);
    }
    return res;
  }

  // --- manage file contents

  readFile(uri: Uri): Uint8Array {
    const fragment = this._lookup(uri);
    if (fragment?.fileContent) {
      return fragment.fileContent;
    } else {
      throw vscode.FileSystemError.FileNotFound();
    }
  }

  async writeFile(
    uri: Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const [att, fragment] = this._lookup0(uri);
    if (!fragment) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // TODO options
    fragment.fileContent = content;
    fragment.mtime = Date.now();

    const doc = att.document;
    // Replace `doc` content between offset `fragment.start` and `fragment.end` with `content`
    const offset = fragment.start;
    const length = Math.max(fragment.end - 1 - fragment.start, 0); // -1 because end is actually index of )

    // send update
    const edit = new vscode.TextEdit(
      new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + length)),
      content.toString()
    );
    const we = new vscode.WorkspaceEdit();
    we.set(doc.uri, [edit]);
    await vscode.workspace.applyEdit(we);

    // update
    this._onUpdate(doc, att, doc.getText());
  }

  watch(
    uri: Uri,
    options: {
      readonly recursive: boolean;
      readonly excludes: readonly string[];
    }
  ): vscode.Disposable {
    throw new Error("Method not implemented.");
  }

  // --- manage files/folders

  rename(_oldUri: Uri, _newUri: Uri, _options: { overwrite: boolean }): void {
    throw new Error("unsupported");
  }

  delete(_uri: Uri): void {
    throw new Error("unsupported");
  }

  createDirectory(_uri: Uri): void {
    throw new Error("unsupported");
  }

  _lookup(uri: Uri): Fragment | undefined {
    const [_, frag] = this._lookup0(uri);
    return frag;
  }

  _lookup0(uri: Uri): [TextDocumentAttachments, Fragment?] {
    let key = vdoc2orig(uri);
    key = key.toLowerCase(); // DEFENSIVE
    const att = this.files.get(key);
    const idx = vdocGetIndex(uri);
    return [att, att?.fragments[idx]];
  }

  _getOrMakeAtt(primary: Uri) {
    const key = canonOrigUri(primary);
    let res = this.files.get(key);
    if (!res) {
      res = new TextDocumentAttachments();
      this.files.set(key, res);
    }
    return res;
  }
}
