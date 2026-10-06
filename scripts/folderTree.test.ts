import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ancestorsToReveal,
	attachFolderToSnapshot,
	flattenTree,
	folderFromSnapshot,
	folderName,
	invalidEntryName,
	isEntryVisible,
	isSameOrInside,
	isSamePath,
	joinPath,
	parentPath,
	pathKey,
	remapPath,
	withDocumentExtension,
	type FolderEntry,
	type ListingState,
	type TreeRow,
} from '../src/lib/utils/folderTree.js';
import { readRustBackend, readSource, sliceBetween } from './sourceTree.js';

// The folder sidebar's pure half, run directly, plus the contract between the
// sidebar and the Rust commands it calls — which nothing but the spelling
// connects, so it is checked as text at the end of this file.

const file = (path: string, extra: Partial<FolderEntry> = {}): FolderEntry => ({
	name: path.split(/[/\\]/).pop()!,
	path,
	isDir: false,
	isHidden: false,
	...extra,
});
const dir = (path: string, extra: Partial<FolderEntry> = {}): FolderEntry => file(path, { isDir: true, ...extra });
const ready = (...entries: FolderEntry[]): ListingState => ({ status: 'ready', listing: { entries, truncated: false } });
const DOCS_ONLY = { showHidden: false, showAllFiles: false };

function describe(rows: TreeRow[]): string[] {
	return rows.map((row) =>
		row.kind === 'entry'
			? `${'  '.repeat(row.depth)}${row.entry.isDir ? (row.expanded ? 'v ' : '> ') : ''}${row.entry.name}`
			: `${'  '.repeat(row.depth)}(${row.status})`,
	);
}

// ---------------------------------------------------------------- paths

test('a path key folds what the platform folds, and nothing else', () => {
	assert.equal(pathKey('C:\\Notes\\'), pathKey('c:/notes'));
	assert.equal(pathKey('/home/me/notes/'), '/home/me/notes');
	// POSIX paths are case-sensitive; folding them would merge two folders.
	assert.notEqual(pathKey('/home/me/Notes'), pathKey('/home/me/notes'));
	// A root keeps its separator.
	assert.equal(pathKey('/'), '/');
	assert.equal(pathKey('C:\\'), 'c:/');
});

test('inside means the same path or below it, never a sibling that shares a prefix', () => {
	assert.ok(isSameOrInside('/notes/a.md', '/notes'));
	assert.ok(isSameOrInside('/notes', '/notes/'));
	assert.ok(!isSameOrInside('/notes-archive/a.md', '/notes'));
	assert.ok(isSameOrInside('/etc/hosts', '/'));
	assert.ok(isSameOrInside('C:\\Notes\\Sub\\a.md', 'c:\\notes'));
	assert.ok(!isSameOrInside('', '/notes'), 'an untitled tab is inside nothing');
});

test('join and parent use the separator the path already has', () => {
	assert.equal(joinPath('/notes', 'a.md'), '/notes/a.md');
	assert.equal(joinPath('/notes/', 'a.md'), '/notes/a.md');
	assert.equal(joinPath('/', 'a.md'), '/a.md');
	assert.equal(joinPath('C:\\Notes', 'a.md'), 'C:\\Notes\\a.md');
	assert.equal(joinPath('C:\\', 'a.md'), 'C:\\a.md');

	assert.equal(parentPath('/notes/a.md'), '/notes');
	assert.equal(parentPath('/notes'), '/');
	assert.equal(parentPath('/'), null);
	assert.equal(parentPath('C:\\Notes\\a.md'), 'C:\\Notes');
	assert.equal(parentPath('C:\\Notes'), 'C:\\');
	assert.equal(folderName('/home/me/notes/'), 'notes');
	assert.equal(folderName('/'), '/');
});

// ---------------------------------------------------------------- filter + rows

test('by default the tree shows folders and documents, and hides hidden entries', () => {
	assert.ok(isEntryVisible(file('/n/a.md'), DOCS_ONLY));
	assert.ok(isEntryVisible(file('/n/a.TXT'), DOCS_ONLY));
	assert.ok(isEntryVisible(dir('/n/assets'), DOCS_ONLY));
	assert.ok(!isEntryVisible(file('/n/photo.png'), DOCS_ONLY));
	assert.ok(!isEntryVisible(file('/n/.draft.md', { isHidden: true }), DOCS_ONLY));
	assert.ok(!isEntryVisible(dir('/n/.git', { isHidden: true }), DOCS_ONLY));

	assert.ok(isEntryVisible(file('/n/photo.png'), { showHidden: false, showAllFiles: true }));
	assert.ok(isEntryVisible(dir('/n/.git', { isHidden: true }), { showHidden: true, showAllFiles: false }));
});

test('the tree is drawn depth-first, descending only into expanded folders', () => {
	const listings = new Map<string, ListingState>([
		['/n', ready(dir('/n/journal'), dir('/n/zettel'), file('/n/index.md'), file('/n/logo.png'))],
		['/n/journal', ready(file('/n/journal/2024.md'))],
		['/n/zettel', ready(file('/n/zettel/idea.md'))],
	]);
	const rows = flattenTree('/n', listings, new Set(['/n/journal']), DOCS_ONLY);
	assert.deepEqual(describe(rows), ['v journal', '  2024.md', '> zettel', 'index.md']);
	assert.deepEqual(
		rows.map((row) => row.key),
		['/n/journal', '/n/journal/2024.md', '/n/zettel', '/n/index.md'],
		'keys are path keys, unique per row',
	);
});

test('a folder that has not answered, failed, is empty or was cut short says so', () => {
	const listings = new Map<string, ListingState>([
		['/n', ready(dir('/n/slow'), dir('/n/gone'), dir('/n/images'), dir('/n/huge'))],
		['/n/gone', { status: 'error', message: 'No such file or directory' }],
		['/n/images', ready(file('/n/images/a.png'))],
		['/n/huge', { status: 'ready', listing: { entries: [file('/n/huge/a.md')], truncated: true } }],
	]);
	const expanded = new Set(['/n/slow', '/n/gone', '/n/images', '/n/huge']);
	const rows = flattenTree('/n', listings, expanded, DOCS_ONLY);
	assert.deepEqual(describe(rows), [
		'v slow',
		'  (loading)',
		'v gone',
		'  (error)',
		'v images',
		'  (empty)',
		'v huge',
		'  a.md',
		'  (truncated)',
	]);
	const error = rows.find((row) => row.kind === 'status' && row.status === 'error');
	assert.equal(error?.kind === 'status' ? error.message : null, 'No such file or directory');
});

test('the rows read their keys, so two spellings of one folder share its state', () => {
	const listings = new Map<string, ListingState>([
		[pathKey('C:\\Notes'), ready(dir('C:\\Notes\\Sub'))],
		[pathKey('C:\\Notes\\Sub'), ready(file('C:\\Notes\\Sub\\a.md'))],
	]);
	const rows = flattenTree('c:/notes/', listings, new Set([pathKey('C:\\NOTES\\sub')]), DOCS_ONLY);
	assert.deepEqual(describe(rows), ['v Sub', '  a.md']);
});

// ---------------------------------------------------------------- reveal + rename

test('revealing a file expands exactly the folders between the root and it', () => {
	assert.deepEqual(ancestorsToReveal('/n', '/n/a/b/c.md'), ['/n/a', '/n/a/b']);
	assert.deepEqual(ancestorsToReveal('/n/', '/n/c.md'), []);
	assert.deepEqual(ancestorsToReveal('C:\\Notes', 'c:\\notes\\Sub\\c.md'), ['C:\\Notes\\Sub']);
	assert.equal(ancestorsToReveal('/n', '/elsewhere/c.md'), null);
	assert.equal(ancestorsToReveal('/n', '/n'), null);
});

test('a rename moves the entry itself and everything inside a renamed folder', () => {
	assert.equal(remapPath('/n/old.md', '/n/old.md', '/n/new.md'), '/n/new.md');
	assert.equal(remapPath('/n/old/a/b.md', '/n/old', '/n/new'), '/n/new/a/b.md');
	assert.equal(remapPath('/n/older/b.md', '/n/old', '/n/new'), null, 'a sibling sharing a prefix is untouched');
	assert.equal(remapPath('', '/n/old', '/n/new'), null);
	assert.equal(remapPath('C:\\N\\Old\\a.md', 'c:\\n\\old', 'C:\\N\\New'), 'C:\\N\\New\\a.md');
});

// ---------------------------------------------------------------- names + snapshot

test('a typed name is refused when it is empty or would be a path', () => {
	assert.equal(invalidEntryName('  '), 'empty');
	assert.equal(invalidEntryName('..'), 'invalid');
	assert.equal(invalidEntryName('a/b'), 'invalid');
	assert.equal(invalidEntryName('a\\b'), 'invalid');
	assert.equal(invalidEntryName('what?.md'), 'invalid');
	assert.equal(invalidEntryName('Meeting notes 2024.md'), null);
	assert.equal(invalidEntryName('.gitignore'), null);
});

test('New File adds .md only when the name has no extension of its own', () => {
	assert.equal(withDocumentExtension('ideas'), 'ideas.md');
	assert.equal(withDocumentExtension(' ideas '), 'ideas.md');
	assert.equal(withDocumentExtension('ideas.'), 'ideas.md');
	assert.equal(withDocumentExtension('todo.txt'), 'todo.txt');
	assert.equal(withDocumentExtension('v1.2 notes.markdown'), 'v1.2 notes.markdown');
	assert.equal(withDocumentExtension('.env'), '.env.md', 'a leading dot is a hidden name, not an extension');
});

test('the open folder rides in the window snapshot and comes back out of it', () => {
	const tabs = JSON.stringify({ version: 2, activeTabId: 'a', tabs: [] });
	const withFolder = attachFolderToSnapshot(tabs, '/home/me/notes');
	assert.equal(folderFromSnapshot(withFolder), '/home/me/notes');
	assert.deepEqual(JSON.parse(withFolder).tabs, [], 'the tab fields are untouched');
	assert.equal(attachFolderToSnapshot(tabs, null), tabs, 'no folder, no change');
	assert.equal(folderFromSnapshot(tabs), null);
	assert.equal(folderFromSnapshot('not json'), null);
	assert.equal(attachFolderToSnapshot('not json', '/n'), 'not json');
});

// ---------------------------------------------------------------- contract with Rust

const rust = readRustBackend();
const registry = sliceBetween(readSource('src-tauri/src/app.rs'), 'generate_handler![', '])');
const frontend = [
	readSource('src/lib/stores/folderWorkspace.svelte.ts'),
	readSource('src/lib/components/FolderSidebar.svelte'),
	readSource('src/lib/MarkdownViewer.svelte'),
].join('\n');

test('every command the folder sidebar invokes is a registered Rust command', () => {
	const commands = [
		'list_folder',
		'path_is_directory',
		'search_folder_files',
		'create_file',
		'create_directory',
		'watch_folder_dirs',
		'unwatch_folder',
	];
	for (const command of commands) {
		assert.match(frontend, new RegExp(`['"]${command}['"]`), `${command} is invoked`);
		assert.match(rust, new RegExp(`#\\[tauri::command\\]\\n(?:pub )?(?:async )?fn ${command}\\(`), `${command} is a command`);
		assert.match(registry, new RegExp(`folder::${command}\\b`), `${command} is registered`);
	}
});

test('the commands that touch the disk run off the main thread', () => {
	for (const command of ['list_folder', 'path_is_directory', 'search_folder_files', 'create_file', 'create_directory', 'watch_folder_dirs']) {
		assert.match(rust, new RegExp(`#\\[tauri::command\\]\\npub async fn ${command}\\(`), command);
	}
});

test('the change event and the argument names are spelled alike on both sides', () => {
	assert.match(rust, /"folder-changed"/);
	assert.match(frontend, /\['folder-changed',/);
	// Tauri maps camelCase arguments to snake_case parameters.
	assert.match(rust, /fn search_folder_files\(\s*root: String,\s*query: String,\s*include_hidden: bool,\s*extensions: Option<Vec<String>>,/);
	assert.match(frontend, /includeHidden: filter\.showHidden/);
	// The listing's fields reach TypeScript in camelCase.
	const folder = readSource('src-tauri/src/folder.rs');
	for (const struct of ['FolderEntry', 'FolderListing', 'FolderSearchHit', 'FolderSearchResult']) {
		assert.match(folder, new RegExp(`#\\[serde\\(rename_all = "camelCase"\\)\\]\\npub struct ${struct}\\b`), struct);
	}
	assert.match(folder, /pub is_dir: bool/);
	assert.match(folder, /pub is_hidden: bool/);
	assert.match(folder, /pub relative_path: String/);
});

test('a window that closes takes its folder watcher with it', () => {
	const destroyed = sliceBetween(readSource('src-tauri/src/window_runtime.rs'), 'tauri::WindowEvent::Destroyed', '_ => {}');
	assert.match(destroyed, /FolderWatcherState/);
});
