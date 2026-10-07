/**
 * `FolderWorkspace`, run for real: a runes module, so it lives under vitest,
 * where `$derived` is the compiler's and `rows` recomputes the way the sidebar
 * sees it. The backend is a fake handed to the constructor; only the settings
 * store's boot (`get_os_type`) goes through the Tauri stub.
 */

import assert from 'node:assert/strict';

import { flushSync } from 'svelte';
import { test } from 'vitest';

(window as any).__TAURI_INTERNALS__ = {
	metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
	invoke: (command: string) => Promise.resolve(command === 'get_os_type' ? 'linux' : null),
	transformCallback: (fn: unknown) => fn,
};

const { FolderWorkspace } = await import('../src/lib/stores/folderWorkspace.svelte.js');
const { settings } = await import('../src/lib/stores/settings.svelte.js');
const {
	moveRecentFiles,
	promoteRecentFile,
	readStoredRecentFiles,
	readStoredRecentFolders,
	updateStoredRecentFolders,
	isRecentFoldersStorageEvent,
	isRecentFilesStorageEvent,
} = await import('../src/lib/utils/recentFiles.js');
const { remapPath } = await import('../src/lib/utils/folderTree.js');

type Entry = { name: string; path: string; isDir: boolean; isHidden: boolean };
type Call = { command: string; args: Record<string, unknown> };

const entry = (path: string, isDir = false, isHidden = false): Entry => ({
	name: path.split('/').pop()!,
	path,
	isDir,
	isHidden,
});

/** A fake disk: listings by directory, every call recorded, answers optionally held. */
function makeBackend(tree: Record<string, Entry[]>) {
	const calls: Call[] = [];
	const held = new Map<string, Array<() => void>>();
	let holding: string | null = null;
	const backend = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
		calls.push({ command, args });
		if (holding && command === 'list_folder' && args.path === holding) {
			await new Promise<void>((resolve) => held.set(holding!, [...(held.get(holding!) ?? []), resolve]));
		}
		if (command === 'list_folder') {
			const entries = tree[args.path as string];
			if (!entries) throw new Error('Not a directory');
			return { entries, truncated: false } as T;
		}
		if (command === 'search_folder_files') {
			const query = String(args.query).toLowerCase();
			const hits = Object.values(tree)
				.flat()
				.filter((e) => !e.isDir && e.path.toLowerCase().includes(query))
				.map((e) => ({ name: e.name, path: e.path, relativePath: e.path.replace(/^\/n\//, '') }));
			return { hits, truncated: false } as T;
		}
		return undefined as T;
	};
	return {
		backend,
		calls,
		hold(path: string) {
			holding = path;
		},
		release(path: string) {
			holding = null;
			for (const resolve of held.get(path) ?? []) resolve();
			held.delete(path);
		},
		watched(): unknown {
			const watches = calls.filter((call) => call.command === 'watch_folder_dirs');
			return watches.at(-1)?.args.dirs;
		},
	};
}

const TREE: Record<string, Entry[]> = {
	'/n': [entry('/n/journal', true), entry('/n/.git', true, true), entry('/n/index.md'), entry('/n/logo.png')],
	'/n/journal': [entry('/n/journal/2024', true), entry('/n/journal/today.md')],
	'/n/journal/2024': [entry('/n/journal/2024/jan.md')],
	'/m': [entry('/m/other.md')],
};

function names(workspace: InstanceType<typeof FolderWorkspace>): string[] {
	flushSync();
	return workspace.rows.map((row) =>
		row.kind === 'entry' ? `${'  '.repeat(row.depth)}${row.entry.name}` : `${'  '.repeat(row.depth)}(${row.status})`,
	);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('opening a folder lists one level and watches only the root', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');
	await settle();

	assert.deepEqual(names(workspace), ['journal', 'index.md']);
	assert.deepEqual(
		disk.calls.filter((c) => c.command === 'list_folder').map((c) => c.args.path),
		['/n'],
		'nothing below the root is read until it is expanded',
	);
	assert.deepEqual(disk.watched(), ['/n']);
});

test('expanding reads the next level and widens the watch; collapsing narrows it again', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');
	await workspace.toggle('/n/journal');
	await settle();

	assert.deepEqual(names(workspace), ['journal', '  2024', '  today.md', 'index.md']);
	assert.deepEqual(disk.watched(), ['/n', '/n/journal']);

	await workspace.toggle('/n/journal');
	await settle();
	assert.deepEqual(names(workspace), ['journal', 'index.md']);
	assert.deepEqual(disk.watched(), ['/n']);
});

test('the filter is read live: a settings change redraws without re-reading the disk', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(
		() => ({ showHidden: settings.folderShowHidden, showAllFiles: settings.folderShowAllFiles }),
		disk.backend,
	);
	await workspace.open('/n');
	assert.deepEqual(names(workspace), ['journal', 'index.md']);
	const reads = disk.calls.length;

	settings.folderShowHidden = true;
	settings.folderShowAllFiles = true;
	try {
		assert.deepEqual(names(workspace), ['journal', '.git', 'index.md', 'logo.png']);
		assert.equal(disk.calls.length, reads);
	} finally {
		settings.folderShowHidden = false;
		settings.folderShowAllFiles = false;
	}
});

test('a slow listing from a folder that was replaced is dropped, not painted over the new one', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	disk.hold('/n');
	const first = workspace.open('/n');
	await settle();
	await workspace.open('/m');
	disk.release('/n');
	await first;

	assert.equal(workspace.root, '/m');
	assert.deepEqual(names(workspace), ['other.md']);
	assert.equal(workspace.listings.has('/n'), false, 'the late answer is not cached under the new folder either');
});

test('a refresh keeps the listing on screen until the new one lands, and skips collapsed folders', async () => {
	const tree = structuredClone(TREE);
	const disk = makeBackend(tree);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');

	tree['/n'] = [...tree['/n'], entry('/n/new.md')];
	disk.hold('/n');
	const refreshing = workspace.refresh(['/n', '/n/journal']);
	await settle();
	assert.deepEqual(names(workspace), ['journal', 'index.md'], 'no loading flash while refreshing');
	disk.release('/n');
	await refreshing;

	assert.deepEqual(names(workspace), ['journal', 'index.md', 'new.md']);
	assert.ok(
		!disk.calls.some((c) => c.command === 'list_folder' && c.args.path === '/n/journal'),
		'a change in a collapsed folder has nothing on screen to update',
	);
});

test('revealing a file expands every folder above it', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');
	assert.equal(await workspace.reveal('/n/journal/2024/jan.md'), true);
	assert.deepEqual(names(workspace), ['journal', '  2024', '    jan.md', '  today.md', 'index.md']);
	assert.equal(await workspace.reveal('/elsewhere/x.md'), false);
});

test('a renamed folder stays expanded under its new name', async () => {
	const tree = structuredClone(TREE);
	const disk = makeBackend(tree);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');
	await workspace.reveal('/n/journal/2024/jan.md');

	tree['/n'] = [entry('/n/diary', true), entry('/n/index.md')];
	tree['/n/diary'] = [entry('/n/diary/2024', true), entry('/n/diary/today.md')];
	tree['/n/diary/2024'] = [entry('/n/diary/2024/jan.md')];
	delete tree['/n/journal'];
	delete tree['/n/journal/2024'];

	workspace.renamed('/n/journal', '/n/diary');
	await workspace.refresh(['/n']);
	await settle();

	assert.deepEqual(names(workspace), ['diary', '  2024', '    jan.md', '  today.md', 'index.md']);
	assert.ok(workspace.isExpanded('/n/diary/2024'));
	assert.ok(!workspace.isExpanded('/n/journal'));
	assert.deepEqual(disk.watched(), ['/n', '/n/diary', '/n/diary/2024']);
});

test('search passes the document extensions unless every file is shown, and drops stale answers', async () => {
	const disk = makeBackend(TREE);
	let showAllFiles = false;
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles }), disk.backend);
	await workspace.open('/n');

	await workspace.search('jan');
	assert.deepEqual(workspace.searchResult?.hits.map((h) => h.relativePath), ['journal/2024/jan.md']);
	const args = disk.calls.filter((c) => c.command === 'search_folder_files').at(-1)!.args;
	assert.equal(args.root, '/n');
	assert.ok(Array.isArray(args.extensions) && (args.extensions as string[]).includes('md'));

	showAllFiles = true;
	await workspace.search('logo');
	assert.equal(disk.calls.filter((c) => c.command === 'search_folder_files').at(-1)!.args.extensions, null);

	// An answer to an older query never replaces a newer one.
	const older = workspace.search('today');
	workspace.clearSearch();
	await older;
	assert.equal(workspace.searchResult, null);
	assert.equal(workspace.searching, false);
});

test('watch requests are applied in order, and a superseded one is never sent', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');
	await settle();
	const before = disk.calls.filter((c) => c.command === 'watch_folder_dirs').length;

	// Three changes in one tick: only the last set reaches the backend.
	void workspace.expand('/n/journal');
	void workspace.expand('/n/journal/2024');
	workspace.collapseAll();
	await settle();
	await settle();

	const watches = disk.calls.filter((c) => c.command === 'watch_folder_dirs').slice(before);
	assert.deepEqual(watches.map((c) => c.args.dirs), [['/n']]);
});

test('closing the folder clears it and stops the watcher', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/n');
	workspace.close();
	await settle();
	assert.equal(workspace.root, null);
	assert.deepEqual(names(workspace), []);
	assert.equal(disk.calls.at(-1)?.command, 'unwatch_folder');
});

test('a folder that cannot be read says why instead of showing nothing', async () => {
	const disk = makeBackend(TREE);
	const workspace = new FolderWorkspace(() => ({ showHidden: false, showAllFiles: false }), disk.backend);
	await workspace.open('/missing');
	assert.deepEqual(names(workspace), ['(error)']);
});

// ---------------------------------------------------------------- recent lists

test('recent folders are their own list, and their storage events are their own', () => {
	localStorage.clear();
	updateStoredRecentFolders((current) => promoteRecentFile(current, '/n'));
	updateStoredRecentFolders((current) => promoteRecentFile(current, '/m'));
	assert.deepEqual(readStoredRecentFolders(), ['/m', '/n']);
	assert.deepEqual(readStoredRecentFiles(), [], 'the recent-file list is untouched');

	assert.equal(isRecentFoldersStorageEvent({ key: 'recent-folders', storageArea: null }), true);
	assert.equal(isRecentFoldersStorageEvent({ key: 'recent-files', storageArea: null }), false);
	assert.equal(isRecentFilesStorageEvent({ key: 'recent-folders', storageArea: null }), false);
});

test('recent files follow a renamed folder, without leaving two entries for one file', () => {
	const moved = moveRecentFiles(['/n/old/a.md', '/x.md', '/n/new/a.md'], (path) => remapPath(path, '/n/old', '/n/new'));
	assert.deepEqual(moved, ['/n/new/a.md', '/x.md']);
});
