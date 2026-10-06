import { MARKDOWN_LINK_EXTENSION_PATTERN } from './markdownLinks.js';

/*
 * THE FOLDER SIDEBAR'S PURE HALF.
 *
 * Everything the sidebar decides that is a function of paths and listings —
 * which entries show, in what rows, which directories have to be expanded to
 * reveal a file, where a renamed file's open tab now points — lives here, so
 * `node --test` can run it without a store, a DOM or a backend. The store
 * (`folderWorkspace.svelte.ts`) owns the state and the I/O and asks this module
 * every question that has an answer on paper.
 *
 * PATHS ARE COMPARED BY KEY, NOT BY SPELLING. A path reaches the sidebar from
 * the folder dialog, from argv, from a drop, from the Rust listing (which
 * joins with the platform separator) and from a tab. Windows hands the same
 * directory back as `C:\Notes` and `c:\notes\`, so state keyed by the raw
 * string would treat one folder as two. `pathKey` folds what the platform
 * folds — separators and trailing separators everywhere, case only for
 * Windows-shaped paths — and every map in the store is keyed by it.
 */

/** One row of a Rust `list_folder` answer. */
export type FolderEntry = {
	name: string;
	path: string;
	isDir: boolean;
	isHidden: boolean;
};

export type FolderListing = {
	entries: FolderEntry[];
	truncated: boolean;
};

export type FolderSearchHit = {
	name: string;
	path: string;
	relativePath: string;
};

export type FolderSearchResult = {
	hits: FolderSearchHit[];
	truncated: boolean;
};

/** Where one directory's listing stands. */
export type ListingState =
	| { status: 'loading' }
	| { status: 'ready'; listing: FolderListing }
	| { status: 'error'; message: string };

export type FolderTreeFilter = {
	/** Dot-files and, on Windows, entries with the Hidden attribute. */
	showHidden: boolean;
	/** Every file, rather than only the ones Markpad opens as documents. */
	showAllFiles: boolean;
};

/** One line of the rendered tree. */
export type TreeRow =
	| { kind: 'entry'; key: string; entry: FolderEntry; depth: number; expanded: boolean }
	| {
			kind: 'status';
			key: string;
			/** The directory this line reports on. */
			dir: string;
			depth: number;
			status: 'loading' | 'error' | 'empty' | 'truncated';
			message?: string;
	  };

/** A path that begins like `C:` or `\\server` follows Windows rules. */
function isWindowsShaped(path: string): boolean {
	return /^[A-Za-z]:/.test(path) || path.startsWith('\\\\');
}

/** The separator `path` already uses, so a path built from it reads alike. */
export function separatorOf(path: string): '/' | '\\' {
	if (path.includes('\\')) return '\\';
	if (path.includes('/')) return '/';
	return isWindowsShaped(path) ? '\\' : '/';
}

/** Trailing separators off, except where they are the whole root (`/`, `C:\`). */
function trimTrailingSeparators(path: string): string {
	let end = path.length;
	while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) {
		// `C:\` keeps its separator: `C:` alone means "the current directory on C".
		if (end === 3 && /^[A-Za-z]:/.test(path)) break;
		end--;
	}
	return path.slice(0, end);
}

/**
 * The identity two spellings of one path share. Not a path: never hand it to
 * the backend.
 */
export function pathKey(path: string): string {
	const trimmed = trimTrailingSeparators(path).replace(/\\/g, '/');
	return isWindowsShaped(path) ? trimmed.toLowerCase() : trimmed;
}

export function isSamePath(a: string, b: string): boolean {
	return pathKey(a) === pathKey(b);
}

/** Whether `path` is `dir` itself or anywhere below it. */
export function isSameOrInside(path: string, dir: string): boolean {
	const p = pathKey(path);
	const d = pathKey(dir);
	if (p === d) return true;
	return p.startsWith(d.endsWith('/') ? d : `${d}/`);
}

export function joinPath(dir: string, name: string): string {
	const trimmed = trimTrailingSeparators(dir);
	const last = trimmed[trimmed.length - 1];
	if (last === '/' || last === '\\') return `${trimmed}${name}`;
	return `${trimmed}${separatorOf(dir)}${name}`;
}

/** The directory holding `path`, or `null` for a root. */
export function parentPath(path: string): string | null {
	const trimmed = trimTrailingSeparators(path);
	const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
	if (index < 0 || index === trimmed.length - 1) return null;
	if (index === 0) return trimmed[0];
	// `C:\notes` → `C:\`, not `C:`.
	if (index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
	return trimmed.slice(0, index);
}

/** The last segment, ignoring trailing separators — a folder's display name. */
export function folderName(path: string): string {
	const trimmed = trimTrailingSeparators(path);
	const name = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
	return name || trimmed;
}

/** A file Markpad opens as a document: the same list the Open dialog uses. */
export function isDocumentName(name: string): boolean {
	return MARKDOWN_LINK_EXTENSION_PATTERN.test(name);
}

export function isEntryVisible(entry: FolderEntry, filter: FolderTreeFilter): boolean {
	if (entry.isHidden && !filter.showHidden) return false;
	if (entry.isDir) return true;
	return filter.showAllFiles || isDocumentName(entry.name);
}

/**
 * The tree as the lines it draws, top to bottom.
 *
 * `listings` and `expanded` are keyed by `pathKey`. A directory that is
 * expanded but whose listing has not answered yet draws one `loading` line
 * beneath it, rather than nothing, so expanding a slow share gives feedback;
 * one whose listing failed draws the reason. Empty and truncated directories
 * say so too, because a folder that expands to nothing looks broken.
 */
export function flattenTree(
	root: string,
	listings: ReadonlyMap<string, ListingState>,
	expanded: ReadonlySet<string>,
	filter: FolderTreeFilter,
): TreeRow[] {
	const rows: TreeRow[] = [];

	const walk = (dir: string, depth: number) => {
		const dirKey = pathKey(dir);
		const state = listings.get(dirKey);
		if (!state || state.status === 'loading') {
			rows.push({ kind: 'status', key: `${dirKey}\0loading`, dir, depth, status: 'loading' });
			return;
		}
		if (state.status === 'error') {
			rows.push({ kind: 'status', key: `${dirKey}\0error`, dir, depth, status: 'error', message: state.message });
			return;
		}
		const visible = state.listing.entries.filter((entry) => isEntryVisible(entry, filter));
		if (visible.length === 0) {
			rows.push({ kind: 'status', key: `${dirKey}\0empty`, dir, depth, status: 'empty' });
		}
		for (const entry of visible) {
			const key = pathKey(entry.path);
			const isExpanded = entry.isDir && expanded.has(key);
			rows.push({ kind: 'entry', key, entry, depth, expanded: isExpanded });
			if (isExpanded) walk(entry.path, depth + 1);
		}
		if (state.listing.truncated) {
			rows.push({ kind: 'status', key: `${dirKey}\0truncated`, dir, depth, status: 'truncated' });
		}
	};

	walk(root, 0);
	return rows;
}

/**
 * The directories between `root` and `file` that have to be expanded for the
 * file's row to be on screen, outermost first, spelled from `root` so they
 * match the paths the listings will report. `null` when the file is not under
 * the root at all; `[]` when it sits directly in it.
 */
export function ancestorsToReveal(root: string, file: string): string[] | null {
	if (!isSameOrInside(file, root) || isSamePath(file, root)) return null;
	const rootLength = trimTrailingSeparators(root).length;
	const rest = file.slice(rootLength).split(/[/\\]/).filter(Boolean);
	rest.pop();
	const dirs: string[] = [];
	let current = root;
	for (const segment of rest) {
		current = joinPath(current, segment);
		dirs.push(current);
	}
	return dirs;
}

/**
 * Where `path` lives after `from` was renamed to `to`: `to` itself for the
 * renamed entry, the same relative position under `to` for anything inside a
 * renamed folder, and `null` for a path the rename did not touch.
 */
export function remapPath(path: string, from: string, to: string): string | null {
	if (isSamePath(path, from)) return to;
	if (!isSameOrInside(path, from)) return null;
	const rest = path.slice(trimTrailingSeparators(from).length).replace(/^[/\\]+/, '');
	return joinPath(to, rest);
}

/** Why a typed name cannot be a file or folder name, or null if it can. */
export function invalidEntryName(name: string): 'empty' | 'invalid' | null {
	const trimmed = name.trim();
	if (trimmed === '') return 'empty';
	if (trimmed === '.' || trimmed === '..') return 'invalid';
	// The separators would create a path, not a name. The rest are the
	// characters Windows refuses; refusing them everywhere keeps a vault that
	// is synced between machines openable on all of them.
	if (/[/\\<>:"|?*\u0000-\u001f]/.test(trimmed)) return 'invalid';
	return null;
}

/**
 * The name New File creates: `.md` added when the typed name has no extension
 * of its own, because a sidebar that only shows documents would otherwise
 * create a file it then hides.
 */
export function withDocumentExtension(name: string): string {
	const trimmed = name.trim();
	const dot = trimmed.lastIndexOf('.');
	return dot > 0 && dot < trimmed.length - 1 ? trimmed : `${trimmed.replace(/\.$/, '')}.md`;
}

/**
 * The window snapshot with the open folder written into it. The snapshot is
 * `TabManager.serializeState()`'s JSON; the folder rides along as one more
 * field instead of a second persisted record, so it is saved and restored at
 * exactly the moments the tabs are.
 */
export function attachFolderToSnapshot(snapshot: string, root: string | null): string {
	if (!root) return snapshot;
	try {
		const data = JSON.parse(snapshot);
		if (!data || typeof data !== 'object' || Array.isArray(data)) return snapshot;
		return JSON.stringify({ ...data, folderRoot: root });
	} catch {
		return snapshot;
	}
}

export function folderFromSnapshot(snapshot: string): string | null {
	try {
		const data = JSON.parse(snapshot);
		return data && typeof data.folderRoot === 'string' && data.folderRoot !== '' ? data.folderRoot : null;
	} catch {
		return null;
	}
}
