import * as vscode from 'vscode';
import { Uri } from 'vscode';

export const FS_SCHEME = "fragments";

// js, py, cpp, etc.
// The thing that is put into @LANGUAGE:__@ and into vdoc Uri
export type LangFileExtension = "js" | "ts" | "py" | "cpp" | "sql";
// javascript, python, cpp, etc.
// The thing extensions & syntaxes registers to provide
export type LangId = "javascript" | "typescript" | "python" | "cpp" | "sql";

export interface Region {
  langFileExt: LangFileExtension;
  start: number;
  end: number;
}

export function filterDocContent(doc: string, regions: Iterable<Region>): string {
  let content = doc.replace(/[^\n]/g, " ");
  for (const r of regions) {
    content =
      content.slice(0, r.start) +
      doc.slice(r.start, r.end) +
      content.slice(r.end);
  }
  return content;
}

interface FragmentDelims {
  sbeg: RegExp,
  send: RegExp,
}

// HERE BE DRAGON: RegExp.lastIndex is the only state of the matching machinery, and since this is single-threaded, we don't care about sharing RegExp objects
export const fragdelimsFor: Record<LangId, FragmentDelims> = {
  'cpp': { sbeg: /R"""\(/g, send: /\)"""/g },
  'python': { sbeg: /"""/g, send: /"""/g },
  // HERE BE DRAGON: just ignore escaped \` for this demo...
  'javascript': { sbeg: /`/g, send: /`/g },
  'typescript': { sbeg: /`/g, send: /`/g },
  'sql': undefined,
};

// TODO support only parse for begin delimiter on the next line, to prevent misuses
export function parseInjections(doc: string, rx: FragmentDelims): Region[] {
  const rxInjectionTag = /@LANGUAGE:([^@]*)@/g;
  let match: RegExpExecArray;
  const regions: Region[] = [];
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

    regions.push({
      langFileExt: match[1] as LangFileExtension,
      start: sbeg.index + sbeg[0].length,
      end: send.index,
    });
    // Look for injection annotation after this snippet
    rxInjectionTag.lastIndex = send.index;
  }
  return regions;
}

export function parseMarkdownInjections(doc: string): Region[] {
  const rxInjectionBeg = /```([^\n]+)\n/g;
  let match: RegExpExecArray;
  const regions: Region[] = [];
  while ((match = rxInjectionBeg.exec(doc)) !== null) {
    // FIXME(rtk0c): markdown probably has a way to escape ``` inside a codeblock
    const rxInjectionEnd = /```/g;
    rxInjectionEnd.lastIndex = match.index + match[0].length;
    const end = rxInjectionEnd.exec(doc);
    if (!end) {
      break;
    }

    regions.push({
      langFileExt: match[1] as LangFileExtension,
      start: match.index + match[0].length,
      end: end.index,
    });
  }
  return regions;
}

class TextDocumentAttachments {
  fragments = new Map<LangFileExtension, Fragment>;
  injections: Region[] = [];
}

export class Fragment implements vscode.FileStat {
  get type() { return vscode.FileType.File; }

  ctime: number;
  mtime: number;
  langFileExt: LangFileExtension;
  fileContent: Uint8Array;

  constructor(
    langFileExt: LangFileExtension,
    ctime: number,
    mtime: number,
    fileContent: Uint8Array
  ) {
    this.langFileExt = langFileExt;
    this.ctime = ctime;
    this.mtime = mtime;
    this.fileContent = fileContent;
  }

  get size() { return this.fileContent.byteLength; }
}

export function vdoc2orig(uri: Uri): string {
  // Apparently, if an encoded URI component is used, that part becomes the authority, instead a part of the path?
  // const preStrip = uri.path.slice(1);
  // const postStrip = preStrip.slice(0, preStrip.lastIndexOf("/"));
  // return decodeURIComponent(postStrip);
  return uri.authority;
}

export function vdocGetLang(uri: Uri): string {
  return uri.path.slice(uri.path.lastIndexOf(".") + 1);
}

export function orig2vdoc(uri: Uri, langExt: LangFileExtension): Uri {
  const originalUri = encodeURIComponent(canonOrigUri(uri));
  const vdocUriString = `${FS_SCHEME}://${originalUri}/frag.${langExt}`;
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

  updateDocument(document: vscode.TextDocument, delta?: readonly vscode.TextDocumentContentChangeEvent[]) {
    const primary = document.uri;

    // apply changes in order, as said by docs
    let docText = document.getText();
    for (const change of delta || []) {
      docText =
        docText.slice(0, change.rangeOffset) +
        change.text +
        docText.slice(change.rangeOffset + change.rangeLength);
    }

    const att = this._getOrMakeAtt(primary);

    // reparse 
    if (document.languageId == "markdown") {
      att.injections = parseMarkdownInjections(docText);
    } else {
      att.injections = parseInjections(docText, fragdelimsFor[document.languageId]);
    }

    // injections to fragments
    const distinctLangs = new Set<LangFileExtension>();
    for (const r of att.injections) {
      distinctLangs.add(r.langFileExt);
    }
    // get rid of current list of fragments
    att.fragments = new Map<LangFileExtension, Fragment>();
    const now = Date.now();
    const events = [];
    for (const lang of distinctLangs) {
      att.fragments.set(
        lang,
        new Fragment(
          lang,
          // TODO(rtk0c): diff old and new injections so emit correct mtime/ctime/file events
          now,  // mtime
          now,  // ctime
          Buffer.from(filterDocContent(
            docText,
            att.injections.filter(x => x.langFileExt === lang)
          ))
        ));
      events.push({
        type: vscode.FileChangeType.Changed,
        uri: orig2vdoc(primary, lang),
      });
    }
    this.onDidChangeFileEmitter.fire(events);
  }

  removeDocument(primary: Uri) {
    const key = canonOrigUri(primary);
    const events = [];
    for (const fragment of this.files.get(key).fragments.values()) {
      events.push({
        type: vscode.FileChangeType.Deleted,
        uri: orig2vdoc(primary, fragment.langFileExt),
      });
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

  writeFile(uri: Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): void {
    const fragment = this._lookup(uri);
    if (!fragment) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    // TODO options
    fragment.fileContent = content;
    fragment.mtime = Date.now();
  }

  watch(uri: Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
    throw new Error('Method not implemented.');
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
    let key = vdoc2orig(uri);
    key = key.toLowerCase(); // DEFENSIVE
    const lang = vdocGetLang(uri) as LangFileExtension;
    return this.files.get(key)?.fragments.get(lang);
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
