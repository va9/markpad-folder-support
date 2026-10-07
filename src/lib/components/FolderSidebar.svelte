<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte';
	import { folderWorkspace } from '../stores/folderWorkspace.svelte.js';
	import { settings, FOLDER_SIDEBAR_WIDTH_RANGE } from '../stores/settings.svelte.js';
	import { t } from '../utils/i18n.js';
	import {
		folderName,
		invalidEntryName,
		isDocumentName,
		isSameOrInside,
		isSamePath,
		joinPath,
		parentPath,
		pathKey,
		withDocumentExtension,
		type FolderEntry,
		type TreeRow,
	} from '../utils/folderTree.js';

	let {
		activePath,
		onopen,
		onrenamed,
		onprompt,
		onerror,
		oninfo,
	} = $props<{
		/** The active tab's file, highlighted and revealed in the tree. */
		activePath: string;
		onopen: (path: string) => void;
		/** A file or folder was renamed on disk; open tabs under it need repointing. */
		onrenamed: (from: string, to: string) => void;
		onprompt: (message: string, options: { title: string; initial?: string }) => Promise<string | null>;
		/** Already translated: every message is built with t() in this component. */
		onerror: (message: string) => void;
		oninfo: (message: string) => void;
	}>();

	const RESIZE_STEP = 16;
	const SEARCH_DEBOUNCE_MS = 150;

	let lang = $derived(settings.language);
	let root = $derived(folderWorkspace.root);
	let rows = $derived(folderWorkspace.rows);
	let entryRows = $derived(rows.filter((row): row is Extract<TreeRow, { kind: 'entry' }> => row.kind === 'entry'));

	let treeEl = $state<HTMLElement | null>(null);
	let searchInputEl = $state<HTMLInputElement | null>(null);
	let focusedKey = $state<string | null>(null);
	let searchText = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let isResizing = $state(false);

	let menu = $state<{ show: boolean; x: number; y: number; items: ContextMenuItem[] }>({ show: false, x: 0, y: 0, items: [] });

	// The row that keyboard focus sits on. Falls back to the active file, then
	// to the first row, so Tab into the tree always lands somewhere.
	let rovingKey = $derived.by(() => {
		if (focusedKey && entryRows.some((row) => row.key === focusedKey)) return focusedKey;
		const active = activePath ? entryRows.find((row) => isSamePath(row.entry.path, activePath)) : undefined;
		return active?.key ?? entryRows[0]?.key ?? null;
	});

	/*
	 * Follow the active tab: switching to a document inside the folder expands
	 * its ancestors and scrolls its row into view, the way an editor's explorer
	 * tracks the open file. A file outside the folder leaves the tree alone.
	 */
	$effect(() => {
		const path = activePath;
		const currentRoot = root;
		if (!path || !currentRoot || !isSameOrInside(path, currentRoot)) return;
		// Untracked: `reveal` reads the expanded set on its way in, and tracking
		// that would re-reveal the file every time the user collapsed one of its
		// folders, making that folder impossible to close.
		untrack(() => {
			void folderWorkspace.reveal(path).then(async (revealed) => {
				if (!revealed) return;
				await tick();
				scrollRowIntoView(pathKey(path));
			});
		});
	});

	// A different folder starts with an empty search box.
	$effect(() => {
		void root;
		searchText = '';
		focusedKey = null;
	});

	function scrollRowIntoView(key: string) {
		const row = treeEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
		row?.scrollIntoView({ block: 'nearest' });
	}

	function focusRow(key: string) {
		focusedKey = key;
		void tick().then(() => {
			const row = treeEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
			row?.focus();
			row?.scrollIntoView({ block: 'nearest' });
		});
	}

	function activate(entry: FolderEntry) {
		if (entry.isDir) void folderWorkspace.toggle(entry.path);
		else onopen(entry.path);
	}

	function onRowKeydown(event: KeyboardEvent, row: Extract<TreeRow, { kind: 'entry' }>) {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const index = entryRows.findIndex((candidate) => candidate.key === row.key);
		const { entry } = row;
		switch (event.key) {
			case 'ArrowDown':
				if (index < entryRows.length - 1) focusRow(entryRows[index + 1].key);
				break;
			case 'ArrowUp':
				if (index > 0) focusRow(entryRows[index - 1].key);
				else searchInputEl?.focus();
				break;
			case 'Home':
				if (entryRows.length) focusRow(entryRows[0].key);
				break;
			case 'End':
				if (entryRows.length) focusRow(entryRows[entryRows.length - 1].key);
				break;
			case 'ArrowRight':
				if (!entry.isDir) return;
				if (!row.expanded) void folderWorkspace.expand(entry.path);
				else if (entryRows[index + 1]?.depth === row.depth + 1) focusRow(entryRows[index + 1].key);
				break;
			case 'ArrowLeft': {
				if (entry.isDir && row.expanded) {
					void folderWorkspace.toggle(entry.path);
					break;
				}
				// Up to the folder that holds this row.
				const parent = entryRows
					.slice(0, index)
					.reverse()
					.find((candidate) => candidate.depth === row.depth - 1);
				if (parent) focusRow(parent.key);
				break;
			}
			case 'Enter':
			case ' ':
				activate(entry);
				break;
			case 'F2':
				void renameEntry(entry);
				break;
			case 'ContextMenu':
				openEntryMenu(event, entry);
				break;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	// ------------------------------------------------------------ search

	function onSearchInput() {
		clearTimeout(searchTimer);
		const query = searchText;
		searchTimer = setTimeout(() => void folderWorkspace.search(query), SEARCH_DEBOUNCE_MS);
	}

	function clearSearch() {
		clearTimeout(searchTimer);
		searchText = '';
		folderWorkspace.clearSearch();
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (searchText) {
				clearSearch();
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (event.key === 'Enter') {
			const first = folderWorkspace.searchResult?.hits[0];
			if (first) onopen(first.path);
			event.preventDefault();
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (searchText.trim()) {
				treeEl?.querySelector<HTMLElement>('.search-hit')?.focus();
			} else if (rovingKey) {
				focusRow(rovingKey);
			}
		}
	}

	function onHitKeydown(event: KeyboardEvent, path: string) {
		const target = event.currentTarget as HTMLElement;
		if (event.key === 'ArrowDown') {
			(target.nextElementSibling as HTMLElement | null)?.focus();
		} else if (event.key === 'ArrowUp') {
			const previous = target.previousElementSibling as HTMLElement | null;
			if (previous?.classList.contains('search-hit')) previous.focus();
			else searchInputEl?.focus();
		} else if (event.key === 'Enter' || event.key === ' ') {
			onopen(path);
		} else if (event.key === 'Escape') {
			clearSearch();
			searchInputEl?.focus();
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	}

	/** `notes/2024/jan.md` → `notes/2024`: the hit's folder, shown under its name. */
	function hitFolder(relativePath: string): string {
		const index = relativePath.lastIndexOf('/');
		return index < 0 ? '' : relativePath.slice(0, index);
	}

	// ------------------------------------------------------------ file operations

	function nameError(name: string): string | null {
		return invalidEntryName(name) === null ? null : t('folder.invalidName', lang);
	}

	async function createEntry(dir: string, kind: 'file' | 'folder') {
		const typed = await onprompt(kind === 'file' ? t('folder.newFilePrompt', lang) : t('folder.newFolderPrompt', lang), {
			title: kind === 'file' ? t('folder.newFile', lang) : t('folder.newFolder', lang),
		});
		if (typed === null) return;
		const error = nameError(typed);
		if (error) return onerror(error);
		const name = kind === 'file' ? withDocumentExtension(typed) : typed.trim();
		const path = joinPath(dir, name);
		try {
			await invoke(kind === 'file' ? 'create_file' : 'create_directory', { path });
		} catch (failure) {
			return onerror(t('folder.createFailed', lang).replace('{{name}}', name).replace('{{error}}', String(failure)));
		}
		if (root && !isSamePath(dir, root)) await folderWorkspace.expand(dir);
		await folderWorkspace.refresh([dir]);
		if (kind === 'file') onopen(path);
		else await folderWorkspace.expand(path);
		focusRow(pathKey(path));
	}

	async function renameEntry(entry: FolderEntry) {
		const typed = await onprompt(t('folder.renamePrompt', lang), {
			title: t('folder.rename', lang),
			initial: entry.name,
		});
		if (typed === null) return;
		const name = typed.trim();
		if (name === entry.name) return;
		const error = nameError(name);
		if (error) return onerror(error);
		const parent = parentPath(entry.path);
		if (!parent) return;
		const newPath = joinPath(parent, name);
		try {
			await invoke('rename_file', { oldPath: entry.path, newPath });
		} catch (failure) {
			return onerror(t('folder.renameFailed', lang).replace('{{name}}', entry.name).replace('{{error}}', String(failure)));
		}
		folderWorkspace.renamed(entry.path, newPath);
		onrenamed(entry.path, newPath);
		await folderWorkspace.refresh([parent]);
		focusRow(pathKey(newPath));
	}

	async function reveal(path: string) {
		try {
			await invoke('open_file_folder', { path });
		} catch (failure) {
			console.error('Failed to reveal', path, failure);
			onerror(t('toast.openFailed', lang).replace('{{target}}', path));
		}
	}

	async function copyText(text: string) {
		try {
			await invoke('clipboard_write_text', { text });
			oninfo(t('folder.copied', lang));
		} catch (failure) {
			console.error('Failed to copy a path', failure);
		}
	}

	function relativeTo(path: string): string {
		if (!root) return path;
		const trimmedRoot = root.replace(/[/\\]+$/, '');
		return path.slice(trimmedRoot.length).replace(/^[/\\]+/, '');
	}

	// ------------------------------------------------------------ menus

	function showMenu(event: MouseEvent | KeyboardEvent, items: ContextMenuItem[]) {
		event.preventDefault();
		event.stopPropagation();
		let x: number;
		let y: number;
		if (event instanceof MouseEvent && event.type === 'contextmenu') {
			x = event.clientX;
			y = event.clientY;
		} else {
			const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
			x = rect.left + 12;
			y = rect.bottom;
		}
		menu = { show: true, x, y, items };
	}

	function openEntryMenu(event: MouseEvent | KeyboardEvent, entry: FolderEntry) {
		const dir = entry.isDir ? entry.path : (parentPath(entry.path) ?? root ?? entry.path);
		const items: ContextMenuItem[] = [];
		if (!entry.isDir) {
			items.push({ label: t('folder.open', lang), onClick: () => onopen(entry.path) });
			items.push({ separator: true });
		}
		items.push(
			{ label: t('folder.newFile', lang), onClick: () => void createEntry(dir, 'file') },
			{ label: t('folder.newFolder', lang), onClick: () => void createEntry(dir, 'folder') },
			{ separator: true },
			{ label: t('folder.rename', lang), shortcut: 'F2', onClick: () => void renameEntry(entry) },
			{ separator: true },
			{ label: t('folder.reveal', lang), onClick: () => void reveal(entry.path) },
			{ label: t('folder.copyPath', lang), onClick: () => void copyText(entry.path) },
			{ label: t('folder.copyRelativePath', lang), onClick: () => void copyText(relativeTo(entry.path)) },
		);
		if (entry.isDir) {
			items.push({ separator: true }, { label: t('folder.refresh', lang), onClick: () => void folderWorkspace.refresh([entry.path]) });
		}
		focusedKey = pathKey(entry.path);
		showMenu(event, items);
	}

	function openRootMenu(event: MouseEvent | KeyboardEvent) {
		if (!root) return;
		const currentRoot = root;
		showMenu(event, [
			{ label: t('folder.newFile', lang), onClick: () => void createEntry(currentRoot, 'file') },
			{ label: t('folder.newFolder', lang), onClick: () => void createEntry(currentRoot, 'folder') },
			{ separator: true },
			{ label: t('folder.showAllFiles', lang), checked: settings.folderShowAllFiles, onClick: () => { settings.folderShowAllFiles = !settings.folderShowAllFiles; } },
			{ label: t('folder.showHidden', lang), checked: settings.folderShowHidden, onClick: () => { settings.folderShowHidden = !settings.folderShowHidden; } },
			{ separator: true },
			{ label: t('folder.refresh', lang), onClick: () => void folderWorkspace.refresh() },
			{ label: t('folder.collapseAll', lang), onClick: () => folderWorkspace.collapseAll() },
			{ label: t('folder.reveal', lang), onClick: () => void reveal(currentRoot) },
			{ label: t('folder.copyPath', lang), onClick: () => void copyText(currentRoot) },
			{ separator: true },
			{ label: t('folder.closeFolder', lang), onClick: () => folderWorkspace.close() },
		]);
	}

	// A search answered under one filter is stale under another.
	$effect(() => {
		void settings.folderShowAllFiles;
		void settings.folderShowHidden;
		untrack(() => {
			const query = folderWorkspace.searchQuery;
			if (query.trim()) void folderWorkspace.search(query);
		});
	});

	// ------------------------------------------------------------ resize

	function startResize(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		isResizing = true;
		const startX = event.clientX;
		const startWidth = settings.folderSidebarWidth;
		const move = (e: PointerEvent) => settings.setFolderSidebarWidth(startWidth + e.clientX - startX);
		const end = () => {
			isResizing = false;
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	function onResizeKeydown(event: KeyboardEvent) {
		const width = settings.folderSidebarWidth;
		if (event.key === 'ArrowLeft') settings.setFolderSidebarWidth(width - RESIZE_STEP);
		else if (event.key === 'ArrowRight') settings.setFolderSidebarWidth(width + RESIZE_STEP);
		else if (event.key === 'Home') settings.setFolderSidebarWidth(FOLDER_SIDEBAR_WIDTH_RANGE.min);
		else if (event.key === 'End') settings.setFolderSidebarWidth(FOLDER_SIDEBAR_WIDTH_RANGE.max);
		else return;
		event.preventDefault();
		event.stopPropagation();
	}

	function statusText(row: Extract<TreeRow, { kind: 'status' }>): string {
		switch (row.status) {
			case 'loading':
				return t('folder.loading', lang);
			case 'error':
				return t('folder.listError', lang);
			case 'empty':
				return t(settings.folderShowAllFiles ? 'folder.emptyFolder' : 'folder.emptyDocuments', lang);
			case 'truncated':
				return t('folder.truncated', lang);
		}
	}
</script>

{#if root}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<aside
		class="folder-sidebar"
		class:resizing={isResizing}
		style:width="{settings.folderSidebarWidth}px"
		aria-label={t('folder.sidebarLabel', lang)}
		oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
		<div class="folder-header">
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="folder-title" title={root} oncontextmenu={openRootMenu}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
					><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
				<span class="folder-title-text">{folderName(root)}</span>
			</div>
			<div class="folder-actions">
				<button class="folder-action" title={t('folder.newFile', lang)} aria-label={t('folder.newFile', lang)} onclick={() => root && createEntry(root, 'file')}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
						><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
				</button>
				<button class="folder-action" title={t('folder.newFolder', lang)} aria-label={t('folder.newFolder', lang)} onclick={() => root && createEntry(root, 'folder')}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
						><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>
				</button>
				<button class="folder-action" title={t('folder.refresh', lang)} aria-label={t('folder.refresh', lang)} onclick={() => folderWorkspace.refresh()}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
						><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15A9 9 0 1 1 18 5.64L23 10"></path></svg>
				</button>
				<button class="folder-action" title={t('folder.collapseAll', lang)} aria-label={t('folder.collapseAll', lang)} onclick={() => folderWorkspace.collapseAll()}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
						><polyline points="7 13 12 8 17 13"></polyline><polyline points="7 19 12 14 17 19"></polyline></svg>
				</button>
				<button class="folder-action" title={t('folder.more', lang)} aria-label={t('folder.more', lang)} aria-haspopup="menu" onclick={openRootMenu}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
						><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>
				</button>
			</div>
		</div>

		<div class="folder-search">
			<svg class="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
				><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
			<input
				bind:this={searchInputEl}
				bind:value={searchText}
				type="search"
				spellcheck="false"
				autocomplete="off"
				placeholder={t('folder.searchPlaceholder', lang)}
				aria-label={t('folder.searchPlaceholder', lang)}
				oninput={onSearchInput}
				onkeydown={onSearchKeydown} />
			{#if searchText}
				<button class="search-clear" aria-label={t('folder.clearSearch', lang)} title={t('folder.clearSearch', lang)} onclick={() => { clearSearch(); searchInputEl?.focus(); }}>×</button>
			{/if}
		</div>

		<div class="folder-body" bind:this={treeEl}>
			{#if searchText.trim()}
				<div class="search-results" role="listbox" aria-label={t('folder.searchPlaceholder', lang)}>
					{#if folderWorkspace.searchResult}
						{#each folderWorkspace.searchResult.hits as hit (hit.path)}
							<div
								class="search-hit"
								class:active={activePath && isSamePath(hit.path, activePath)}
								role="option"
								aria-selected={activePath !== '' && isSamePath(hit.path, activePath)}
								tabindex="-1"
								title={hit.relativePath}
								onclick={() => onopen(hit.path)}
								onkeydown={(e) => onHitKeydown(e, hit.path)}
								oncontextmenu={(e) => openEntryMenu(e, { name: hit.name, path: hit.path, isDir: false, isHidden: false })}>
								<span class="hit-name">{hit.name}</span>
								{#if hitFolder(hit.relativePath)}
									<span class="hit-folder">{hitFolder(hit.relativePath)}</span>
								{/if}
							</div>
						{/each}
						{#if folderWorkspace.searchResult.hits.length === 0 && !folderWorkspace.searching}
							<div class="tree-status">{t('folder.noResults', lang)}</div>
						{/if}
						{#if folderWorkspace.searchResult.truncated}
							<div class="tree-status">{t('folder.moreResults', lang)}</div>
						{/if}
					{:else}
						<div class="tree-status">{t('folder.searching', lang)}</div>
					{/if}
				</div>
			{:else}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					class="tree"
					role="tree"
					aria-label={folderName(root)}
					tabindex="-1"
					oncontextmenu={(e) => { if (e.target === e.currentTarget) openRootMenu(e); }}>
					{#each rows as row (row.key)}
						{#if row.kind === 'entry'}
							{@const isActive = !row.entry.isDir && activePath !== '' && isSamePath(row.entry.path, activePath)}
							<div
								class="tree-row"
								class:active={isActive}
								class:dimmed={row.entry.isHidden || (!row.entry.isDir && !isDocumentName(row.entry.name))}
								data-key={row.key}
								role="treeitem"
								aria-level={row.depth + 1}
								aria-expanded={row.entry.isDir ? row.expanded : undefined}
								aria-selected={isActive}
								tabindex={row.key === rovingKey ? 0 : -1}
								title={row.entry.path}
								style:padding-left="{8 + row.depth * 14}px"
								onclick={() => { focusedKey = row.key; activate(row.entry); }}
								onfocus={() => (focusedKey = row.key)}
								onkeydown={(e) => onRowKeydown(e, row)}
								oncontextmenu={(e) => openEntryMenu(e, row.entry)}>
								{#if row.entry.isDir}
									<svg class="chevron" class:open={row.expanded} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
										><polyline points="9 6 15 12 9 18"></polyline></svg>
									<svg class="entry-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
										><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
								{:else}
									<span class="chevron-spacer"></span>
									<svg class="entry-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
										><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
								{/if}
								<span class="entry-name">{row.entry.name}</span>
							</div>
						{:else}
							<div class="tree-status" class:error={row.status === 'error'} style:padding-left="{8 + row.depth * 14 + 26}px" title={row.message ?? ''}>
								{statusText(row)}
							</div>
						{/if}
					{/each}
				</div>
			{/if}
		</div>

		<!-- A focusable separator is the ARIA pattern for a resizer (the outline's
		     handle does the same); svelte's check does not know the role is a widget here. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="sidebar-resize-handle"
			role="separator"
			aria-orientation="vertical"
			aria-label={t('folder.resize', lang)}
			aria-valuemin={FOLDER_SIDEBAR_WIDTH_RANGE.min}
			aria-valuemax={FOLDER_SIDEBAR_WIDTH_RANGE.max}
			aria-valuenow={settings.folderSidebarWidth}
			tabindex="0"
			onpointerdown={startResize}
			onkeydown={onResizeKeydown}
			ondblclick={() => settings.setFolderSidebarWidth(FOLDER_SIDEBAR_WIDTH_RANGE.default)}>
		</div>
	</aside>

	<ContextMenu {...menu} onhide={() => (menu.show = false)} />
{/if}

<style>
	.folder-sidebar {
		position: absolute;
		top: 36px;
		left: 0;
		bottom: 0;
		display: flex;
		flex-direction: column;
		box-sizing: border-box;
		background: var(--color-canvas-subtle);
		border-right: 1px solid var(--color-border-default);
		font-family: var(--win-font);
		font-size: 13px;
		color: var(--color-fg-default);
		user-select: none;
		z-index: 20;
	}

	.folder-header {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 6px 4px 8px;
	}

	.folder-title {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-fg-default);
		font: inherit;
		font-weight: 600;
		text-align: left;
		cursor: default;
	}

	.folder-title-text,
	.entry-name,
	.hit-name,
	.hit-folder {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.folder-actions {
		display: flex;
		gap: 1px;
		opacity: 0.55;
		transition: opacity 0.15s ease;
	}

	.folder-sidebar:hover .folder-actions,
	.folder-actions:focus-within {
		opacity: 1;
	}

	.folder-action,
	.search-clear {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--color-fg-muted);
		cursor: default;
	}

	.folder-action:hover,
	.search-clear:hover {
		background: var(--color-neutral-muted);
		color: var(--color-fg-default);
	}

	.folder-search {
		position: relative;
		margin: 0 8px 6px;
	}

	.search-icon {
		position: absolute;
		left: 8px;
		top: 50%;
		transform: translateY(-50%);
		color: var(--color-fg-muted);
		pointer-events: none;
	}

	.folder-search input {
		width: 100%;
		box-sizing: border-box;
		height: 26px;
		padding: 0 24px 0 26px;
		border: 1px solid var(--color-border-default);
		border-radius: 5px;
		background: var(--color-canvas-default);
		color: var(--color-fg-default);
		font: inherit;
		font-size: 12px;
		outline: none;
	}

	.folder-search input::-webkit-search-cancel-button {
		display: none;
	}

	.folder-search input:focus {
		border-color: var(--color-accent-fg);
	}

	.search-clear {
		position: absolute;
		right: 2px;
		top: 2px;
		font-size: 15px;
		line-height: 1;
	}

	.folder-body {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding-bottom: 12px;
	}

	.tree {
		min-height: 100%;
		outline: none;
	}

	.tree-row,
	.search-hit {
		display: flex;
		align-items: center;
		gap: 4px;
		min-height: 24px;
		padding-right: 8px;
		margin: 0 4px;
		border-radius: 4px;
		cursor: default;
		outline: none;
	}

	.search-hit {
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: 0;
		padding: 3px 10px;
	}

	.tree-row:hover,
	.search-hit:hover {
		background: var(--color-neutral-muted);
	}

	.tree-row:focus-visible,
	.search-hit:focus-visible {
		box-shadow: inset 0 0 0 1px var(--color-accent-fg);
	}

	.tree-row.active,
	.search-hit.active {
		background: var(--color-accent-subtle, var(--color-neutral-muted));
		color: var(--color-accent-fg);
	}

	.tree-row.dimmed .entry-name {
		opacity: 0.6;
	}

	.chevron {
		flex: none;
		color: var(--color-fg-muted);
		transition: transform 0.12s ease;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.chevron-spacer {
		flex: none;
		width: 12px;
	}

	.entry-icon {
		flex: none;
		color: var(--color-fg-muted);
	}

	.tree-row.active .entry-icon {
		color: inherit;
	}

	.hit-folder {
		font-size: 11px;
		color: var(--color-fg-muted);
	}

	.tree-status {
		min-height: 22px;
		display: flex;
		align-items: center;
		padding: 0 12px;
		font-size: 12px;
		font-style: italic;
		color: var(--color-fg-muted);
	}

	.tree-status.error {
		color: var(--color-danger-fg, var(--color-fg-muted));
	}

	.sidebar-resize-handle {
		position: absolute;
		top: 0;
		right: -3px;
		width: 6px;
		height: 100%;
		cursor: col-resize;
		z-index: 1;
		outline: none;
	}

	.sidebar-resize-handle:hover,
	.sidebar-resize-handle:focus-visible,
	.folder-sidebar.resizing .sidebar-resize-handle {
		background: var(--color-accent-fg);
		opacity: 0.4;
	}
</style>
