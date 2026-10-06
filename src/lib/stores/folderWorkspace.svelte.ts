import { invoke } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import { settings } from './settings.svelte.js';
import { MARKDOWN_LINK_EXTENSIONS } from '../utils/markdownLinks.js';
import {
	ancestorsToReveal,
	flattenTree,
	isSameOrInside,
	pathKey,
	remapPath,
	type FolderListing,
	type FolderSearchResult,
	type FolderTreeFilter,
	type ListingState,
	type TreeRow,
} from '../utils/folderTree.js';

/*
 * The folder this window has open, and everything the sidebar shows of it.
 *
 * Per window, unlike the sidebar's settings: two windows can have two folders
 * open, and the main window's folder is persisted with its tabs (see
 * `attachFolderToSnapshot`). The decisions that are pure functions of paths
 * live in `folderTree.ts`; this module holds the state they are asked about
 * and does the I/O.
 *
 * NOTHING IS LISTED UNTIL IT IS ON SCREEN. Opening a folder reads one level;
 * expanding a directory reads the next. The watcher follows the same rule —
 * it covers the root and the expanded directories, and is re-armed whenever
 * that set changes — so a huge tree costs what the user looks at.
 *
 * EVERY ANSWER IS CHECKED AGAINST THE ROOT IT WAS ASKED FOR. A listing or a
 * search can come back after the user has opened another folder, closed this
 * one, or typed another letter; each await is followed by a check that the
 * question is still the current one, so a stale answer is dropped instead of
 * painted over the new state.
 */

type Backend = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class FolderWorkspace {
	/** The open folder as the user picked it, or null when none is. */
	root = $state<string | null>(null);
	/** Keyed by `pathKey`. */
	readonly listings = new SvelteMap<string, ListingState>();
	/** Expanded directories: `pathKey` → the path as the listing spelled it. */
	readonly expanded = new SvelteMap<string, string>();

	searchQuery = $state('');
	searchResult = $state<FolderSearchResult | null>(null);
	searching = $state(false);

	readonly #filter: () => FolderTreeFilter;
	readonly #backend: Backend;
	#searchSequence = 0;
	#watchSequence = 0;
	#watchChain: Promise<unknown> = Promise.resolve();

	constructor(filter: () => FolderTreeFilter, backend: Backend = invoke) {
		this.#filter = filter;
		this.#backend = backend;
	}

	rows = $derived.by((): TreeRow[] => {
		const root = this.root;
		if (!root) return [];
		return flattenTree(root, this.listings, new Set(this.expanded.keys()), this.#filter());
	});

	isExpanded(dir: string): boolean {
		return this.expanded.has(pathKey(dir));
	}

	/** Opens `path` as this window's folder, replacing any folder already open. */
	async open(path: string): Promise<void> {
		this.root = path;
		this.listings.clear();
		this.expanded.clear();
		this.clearSearch();
		await this.#load(path);
		this.#syncWatch();
	}

	close(): void {
		if (this.root === null) return;
		this.root = null;
		this.listings.clear();
		this.expanded.clear();
		this.clearSearch();
		this.#watchSequence++;
		this.#watchChain = this.#watchChain.then(() => this.#backend('unwatch_folder').catch(() => {}));
	}

	async toggle(dir: string): Promise<void> {
		const key = pathKey(dir);
		if (this.expanded.has(key)) {
			this.expanded.delete(key);
			this.#syncWatch();
			return;
		}
		await this.expand(dir);
	}

	async expand(dir: string): Promise<void> {
		const key = pathKey(dir);
		if (!this.root || !isSameOrInside(dir, this.root)) return;
		if (!this.expanded.has(key)) {
			this.expanded.set(key, dir);
			this.#syncWatch();
		}
		if (this.listings.get(key)?.status !== 'ready') await this.#load(dir);
	}

	collapseAll(): void {
		if (this.expanded.size === 0) return;
		this.expanded.clear();
		this.#syncWatch();
	}

	/**
	 * Re-reads `dirs`, or everything on screen when none are named. Only
	 * directories that are actually shown are read: a change event for a
	 * directory the user has since collapsed has nothing to update.
	 */
	async refresh(dirs?: readonly string[]): Promise<void> {
		const root = this.root;
		if (!root) return;
		const shown = new Map<string, string>([[pathKey(root), root], ...this.expanded]);
		const targets = dirs ? dirs.map((dir) => pathKey(dir)).filter((key) => shown.has(key)) : [...shown.keys()];
		await Promise.all(targets.map((key) => this.#load(shown.get(key)!)));
		if (this.searchQuery.trim() !== '') await this.search(this.searchQuery);
	}

	/**
	 * Carries the tree's state across a rename on disk: an expanded folder that
	 * was renamed, or sits inside one, stays expanded under its new path, and
	 * cached listings under the old path are dropped rather than left to answer
	 * for a directory that no longer exists. The caller refreshes the parent.
	 */
	renamed(from: string, to: string): void {
		for (const [key, dir] of [...this.expanded]) {
			const moved = remapPath(dir, from, to);
			if (moved === null) continue;
			this.expanded.delete(key);
			this.expanded.set(pathKey(moved), moved);
		}
		for (const key of [...this.listings.keys()]) {
			if (isSameOrInside(key, from)) this.listings.delete(key);
		}
		for (const [key, dir] of this.expanded) {
			if (!this.listings.has(key)) void this.#load(dir);
		}
		this.#syncWatch();
	}

	/**
	 * Expands every directory between the root and `file`, outermost first, so
	 * the file's row is on screen. Does nothing for a file outside the folder.
	 */
	async reveal(file: string): Promise<boolean> {
		const root = this.root;
		if (!root) return false;
		const dirs = ancestorsToReveal(root, file);
		if (dirs === null) return false;
		for (const dir of dirs) {
			await this.expand(dir);
			if (this.root !== root) return false;
		}
		return true;
	}

	/**
	 * Files below the root whose relative path contains every word of `query`.
	 * An empty query clears the results instead of asking.
	 */
	async search(query: string): Promise<void> {
		this.searchQuery = query;
		const root = this.root;
		const sequence = ++this.#searchSequence;
		if (!root || query.trim() === '') {
			this.searchResult = null;
			this.searching = false;
			return;
		}
		this.searching = true;
		const filter = this.#filter();
		try {
			const result = await this.#backend<FolderSearchResult>('search_folder_files', {
				root,
				query,
				includeHidden: filter.showHidden,
				extensions: filter.showAllFiles ? null : MARKDOWN_LINK_EXTENSIONS,
			});
			if (sequence !== this.#searchSequence || this.root !== root) return;
			this.searchResult = result;
		} catch {
			if (sequence !== this.#searchSequence || this.root !== root) return;
			this.searchResult = { hits: [], truncated: false };
		} finally {
			if (sequence === this.#searchSequence) this.searching = false;
		}
	}

	clearSearch(): void {
		this.#searchSequence++;
		this.searchQuery = '';
		this.searchResult = null;
		this.searching = false;
	}

	async #load(dir: string): Promise<void> {
		const root = this.root;
		const key = pathKey(dir);
		// A refresh keeps the listing already on screen until the new one
		// lands; only a directory with nothing to show yet shows `loading`.
		if (this.listings.get(key)?.status !== 'ready') this.listings.set(key, { status: 'loading' });
		try {
			const listing = await this.#backend<FolderListing>('list_folder', { path: dir });
			if (this.root !== root) return;
			this.listings.set(key, { status: 'ready', listing });
		} catch (error) {
			if (this.root !== root) return;
			// The directory itself is gone (deleted, renamed, unmounted). Its
			// parent's next refresh drops its row; until then it reports why.
			this.listings.set(key, { status: 'error', message: String(error) });
		}
	}

	/**
	 * Re-arms the backend watcher over the root and the expanded directories.
	 *
	 * Calls are chained, and a call that a newer one has superseded does
	 * nothing: the backend runs each on its own thread, so two in flight could
	 * land in either order and leave the watcher on the older set. Best effort
	 * otherwise — a folder on a filesystem without change notification still
	 * works, it just needs the refresh button.
	 */
	#syncWatch(): void {
		const sequence = ++this.#watchSequence;
		this.#watchChain = this.#watchChain.then(async () => {
			const root = this.root;
			if (sequence !== this.#watchSequence || !root) return;
			const dirs = [root, ...this.expanded.values()];
			await this.#backend('watch_folder_dirs', { dirs }).catch(() => {});
		});
	}
}

export const folderWorkspace = new FolderWorkspace(() => ({
	showHidden: settings.folderShowHidden,
	showAllFiles: settings.folderShowAllFiles,
}));
