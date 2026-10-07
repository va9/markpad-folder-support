//! The folder sidebar's backend: listing a directory one level at a time,
//! searching an open folder by file name, creating files and folders in it,
//! and watching the directories the tree currently shows.
//!
//! Nothing here walks a whole tree up front. The sidebar asks for a level when
//! the user expands it, so opening `~` or a checkout with a `node_modules`
//! costs one `read_dir`, and the watcher covers exactly the directories on
//! screen rather than everything under the root. The one recursive walk is
//! `search_folder_files`, which is bounded both in what it visits and in what
//! it returns.

use crate::commands::blocking;
use crate::window_runtime::{coalesced, lock_recover};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// More entries than this in one directory are not listed. A tree row per file
/// stops being a way to find anything long before this, and a directory of a
/// million cache files would otherwise be a million-element IPC payload.
const MAX_LISTED_ENTRIES: usize = 5_000;

/// Directory entries a search may look at before it gives up. Enough for any
/// notes vault; a search started at `/` stops instead of walking the disk.
const MAX_SEARCH_VISITS: usize = 100_000;

/// The most hits a search hands back. The sidebar shows a list, not a report.
const MAX_SEARCH_RESULTS: usize = 200;

/// Directories a search never descends into, even when hidden entries are
/// included. Each is a build or dependency tree that can hold more files than
/// everything else in a project together, none of them notes.
const SEARCH_SKIPPED_DIRS: &[&str] = &["node_modules", "target", "__pycache__"];

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub entries: Vec<FolderEntry>,
    /// The directory held more than `MAX_LISTED_ENTRIES`, and `entries` is a
    /// subset of it.
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderSearchHit {
    pub name: String,
    pub path: String,
    /// The path below the searched root, `/`-separated on every platform.
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSearchResult {
    pub hits: Vec<FolderSearchHit>,
    /// The walk stopped early — at the visit budget or the result cap — so a
    /// file that is not listed may still exist.
    pub truncated: bool,
}

/// Dot-files everywhere; on Windows also anything carrying the Hidden
/// attribute, which is how that platform hides `AppData` and friends.
fn is_hidden_entry(name: &str, metadata: Option<&fs::Metadata>) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Some(metadata) = metadata {
            return metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = metadata;
    false
}

/// File-manager order: digits compare by value, so `note 2` sorts before
/// `note 10`, and letters compare without case, so `Zeta` does not jump ahead
/// of `alpha`. Ties fall back to the raw bytes so the order is total and
/// stable across platforms.
pub(crate) fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut xs = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    xs.push(c);
                    ai.next();
                }
                let mut ys = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    ys.push(c);
                    bi.next();
                }
                let (xt, yt) = (xs.trim_start_matches('0'), ys.trim_start_matches('0'));
                let ordering = xt.len().cmp(&yt.len()).then_with(|| xt.cmp(yt));
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            (Some(x), Some(y)) => {
                let ordering = x.to_lowercase().cmp(y.to_lowercase());
                if ordering != Ordering::Equal {
                    return ordering;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

fn sort_entries(entries: &mut [FolderEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
}

pub(crate) fn list_folder_blocking(dir: &Path) -> Result<FolderListing, String> {
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        // A name that is not valid Unicode could not be handed back to any
        // other command as a `String` path, so listing it would only produce a
        // row that fails to open.
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(path) = entry.path().to_str().map(str::to_string) else {
            continue;
        };
        if entries.len() >= MAX_LISTED_ENTRIES {
            truncated = true;
            break;
        }
        // `fs::metadata` follows a symlink, so a link to a directory expands
        // like one. A dangling link falls back to the link's own metadata and
        // shows as a file — which fails to open with the OS's own error.
        let metadata = fs::metadata(entry.path()).ok();
        let is_dir = metadata.as_ref().map(fs::Metadata::is_dir).unwrap_or(false);
        let is_hidden = is_hidden_entry(&name, metadata.as_ref());
        entries.push(FolderEntry {
            name,
            path,
            is_dir,
            is_hidden,
        });
    }
    sort_entries(&mut entries);
    Ok(FolderListing { entries, truncated })
}

/// One level of `path`, directories first, in natural order.
///
/// Async because a directory on a share that has gone away blocks `read_dir`
/// for the full network timeout.
#[tauri::command]
pub async fn list_folder(path: String) -> Result<FolderListing, String> {
    blocking(move || list_folder_blocking(Path::new(&path))).await
}

/// Whether `path` names a directory. Lets the frontend route a path that came
/// from argv, a second instance or a drop to the folder sidebar instead of
/// trying to read it as a document.
#[tauri::command]
pub async fn path_is_directory(path: String) -> Result<bool, String> {
    blocking(move || Ok(Path::new(&path).is_dir())).await
}

fn has_wanted_extension(name: &str, extensions: Option<&[String]>) -> bool {
    let Some(extensions) = extensions else {
        return true;
    };
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    extensions
        .iter()
        .any(|wanted| wanted.eq_ignore_ascii_case(ext))
}

/// Every whitespace-separated term of `query`, case-folded, must occur in the
/// file's path below the root. Matching the path and not just the name is what
/// lets `journal 2024` find `journal/2024-01.md`.
fn search_terms(query: &str) -> Vec<String> {
    query.split_whitespace().map(str::to_lowercase).collect()
}

/// Lower ranks first: a hit whose name contains every term beats one that
/// only matches through its folders, and among equals the shallower, shorter
/// path wins.
fn hit_rank(hit: &FolderSearchHit, terms: &[String]) -> (bool, usize, usize) {
    let name = hit.name.to_lowercase();
    let name_matches = terms.iter().all(|term| name.contains(term.as_str()));
    let depth = hit.relative_path.matches('/').count();
    (!name_matches, depth, hit.relative_path.len())
}

pub(crate) fn search_folder_blocking(
    root: &Path,
    query: &str,
    include_hidden: bool,
    extensions: Option<&[String]>,
) -> Result<FolderSearchResult, String> {
    if !root.is_dir() {
        return Err("Not a directory".to_string());
    }
    let terms = search_terms(query);
    if terms.is_empty() {
        return Ok(FolderSearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }

    let mut hits = Vec::new();
    let mut visits = 0_usize;
    let mut truncated = false;
    let mut pending: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];

    'walk: while let Some((dir, prefix)) = pending.pop() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read {
            let Ok(entry) = entry else { continue };
            visits += 1;
            if visits > MAX_SEARCH_VISITS {
                truncated = true;
                break 'walk;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // `file_type` does NOT follow symlinks, which is the point here: a
            // link back up the tree would otherwise be walked forever.
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let metadata = if cfg!(target_os = "windows") {
                entry.metadata().ok()
            } else {
                None
            };
            if !include_hidden && is_hidden_entry(&name, metadata.as_ref()) {
                continue;
            }
            let relative = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if file_type.is_dir() {
                if !SEARCH_SKIPPED_DIRS.contains(&name.as_str()) {
                    pending.push((entry.path(), relative));
                }
                continue;
            }
            if !has_wanted_extension(&name, extensions) {
                continue;
            }
            let haystack = relative.to_lowercase();
            if !terms.iter().all(|term| haystack.contains(term.as_str())) {
                continue;
            }
            let Some(path) = entry.path().to_str().map(str::to_string) else {
                continue;
            };
            hits.push(FolderSearchHit {
                name,
                path,
                relative_path: relative,
            });
            // Collect past the cap before ranking, so the best hits are not
            // simply the first ones the walk happened to reach; stop at four
            // times the cap so a one-letter query cannot gather the whole disk.
            if hits.len() >= MAX_SEARCH_RESULTS * 4 {
                truncated = true;
                break 'walk;
            }
        }
    }

    hits.sort_by(|a, b| {
        hit_rank(a, &terms)
            .cmp(&hit_rank(b, &terms))
            .then_with(|| natural_cmp(&a.relative_path, &b.relative_path))
    });
    if hits.len() > MAX_SEARCH_RESULTS {
        hits.truncate(MAX_SEARCH_RESULTS);
        truncated = true;
    }
    Ok(FolderSearchResult { hits, truncated })
}

/// Files below `root` whose relative path contains every term of `query`.
///
/// `extensions`, when given, keeps only files with one of those extensions
/// (no dot, any case) — the sidebar passes the Markdown list unless it is set
/// to show every file.
#[tauri::command]
pub async fn search_folder_files(
    root: String,
    query: String,
    include_hidden: bool,
    extensions: Option<Vec<String>>,
) -> Result<FolderSearchResult, String> {
    blocking(move || {
        search_folder_blocking(
            Path::new(&root),
            &query,
            include_hidden,
            extensions.as_deref(),
        )
    })
    .await
}

/// Refuses an existing target outright: the sidebar's New File must never
/// truncate a file that happens to have the typed name.
pub(crate) fn create_file_blocking(path: &Path) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map(|_| ())
        .map_err(|e| already_exists_message(path, e))
}

pub(crate) fn create_directory_blocking(path: &Path) -> Result<(), String> {
    fs::create_dir(path).map_err(|e| already_exists_message(path, e))
}

fn already_exists_message(path: &Path, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        format!("\"{name}\" already exists")
    } else {
        error.to_string()
    }
}

#[tauri::command]
pub async fn create_file(path: String) -> Result<(), String> {
    blocking(move || create_file_blocking(Path::new(&path))).await
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    blocking(move || create_directory_blocking(Path::new(&path))).await
}

/// One watcher per window, covering the directories its tree has expanded.
pub struct FolderWatcherState {
    pub(crate) watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl FolderWatcherState {
    pub fn new() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
        }
    }
}

/// Which of the watched directories an event path belongs to, spelled the way
/// the frontend spelled it.
///
/// An event names the entry that changed; the listing that has to be re-read
/// is its parent's. The comparison is against both the spelling the frontend
/// sent and its canonical form, because the platforms do not agree on how to
/// report a directory back (macOS answers `/private/var/...` for `/var/...`).
fn owning_directory(event_path: &Path, watched: &[(String, PathBuf)]) -> Option<String> {
    let parent = event_path.parent()?;
    watched
        .iter()
        .find(|(given, canonical)| Path::new(given) == parent || canonical == parent)
        .map(|(given, _)| given.clone())
}

/// Replaces this window's folder watcher with one over `dirs`.
///
/// Each change is reported as `folder-changed`, carrying the list of watched
/// directories whose listing changed, after a short coalescing delay so a
/// `git checkout` is one refresh rather than hundreds. A directory that cannot
/// be watched — deleted in the meantime, or on a filesystem without change
/// notification — is skipped rather than failing the others.
#[tauri::command]
pub async fn watch_folder_dirs(
    window: tauri::Window,
    handle: AppHandle,
    dirs: Vec<String>,
) -> Result<(), String> {
    blocking(move || {
        let label = window.label().to_string();
        let watched: Vec<(String, PathBuf)> = dirs
            .into_iter()
            .map(|dir| {
                let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| PathBuf::from(&dir));
                (dir, canonical)
            })
            .collect();

        let changed: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let emit_changed = changed.clone();
        let emit_handle = handle.clone();
        let emit_label = label.clone();
        let emit = coalesced(Duration::from_millis(200), move || {
            let dirs: Vec<String> = lock_recover(&emit_changed).drain().collect();
            if !dirs.is_empty() {
                let _ = emit_handle.emit_to(emit_label.as_str(), "folder-changed", dirs);
            }
        });

        let callback_watched = watched.clone();
        let mut watcher = RecommendedWatcher::new(
            move |result: Result<notify::Event, notify::Error>| {
                let Ok(event) = result else { return };
                if matches!(event.kind, notify::EventKind::Access(_)) {
                    return;
                }
                let mut any = false;
                {
                    let mut pending = lock_recover(&changed);
                    for path in &event.paths {
                        if let Some(dir) = owning_directory(path, &callback_watched) {
                            pending.insert(dir);
                            any = true;
                        }
                    }
                }
                if any {
                    emit();
                }
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;

        for (dir, _) in &watched {
            let _ = watcher.watch(Path::new(dir), RecursiveMode::NonRecursive);
        }

        let state = handle.state::<FolderWatcherState>();
        lock_recover(&state.watchers).insert(label, watcher);
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn unwatch_folder(
    window: tauri::Window,
    state: tauri::State<'_, FolderWatcherState>,
) -> Result<(), String> {
    lock_recover(&state.watchers).remove(window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs_safety::tests::temp_path;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = temp_path(tag);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn names(listing: &FolderListing) -> Vec<&str> {
        listing.entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn natural_order_compares_numbers_by_value_and_letters_without_case() {
        let mut names = vec![
            "note 10.md",
            "Note 2.md",
            "alpha.md",
            "Zeta.md",
            "note 1.md",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            vec![
                "alpha.md",
                "note 1.md",
                "Note 2.md",
                "note 10.md",
                "Zeta.md"
            ]
        );
    }

    #[test]
    fn natural_order_is_total_for_names_that_differ_only_in_case_or_padding() {
        assert_ne!(natural_cmp("a.md", "A.md"), Ordering::Equal);
        assert_ne!(natural_cmp("file01", "file1"), Ordering::Equal);
        assert_eq!(natural_cmp("file01", "file2"), Ordering::Less);
    }

    #[test]
    fn a_listing_is_one_level_directories_first_and_flags_hidden_entries() {
        let dir = temp_dir("folder-list");
        fs::write(dir.join("b.md"), "b").unwrap();
        fs::write(dir.join("A.md"), "a").unwrap();
        fs::write(dir.join(".hidden.md"), "h").unwrap();
        fs::create_dir(dir.join("zdocs")).unwrap();
        fs::write(dir.join("zdocs").join("inner.md"), "i").unwrap();

        let listing = list_folder_blocking(&dir).unwrap();
        assert!(!listing.truncated);
        assert_eq!(names(&listing), vec!["zdocs", ".hidden.md", "A.md", "b.md"]);
        let zdocs = &listing.entries[0];
        assert!(zdocs.is_dir);
        assert_eq!(Path::new(&zdocs.path), dir.join("zdocs"));
        assert!(listing.entries[1].is_hidden);
        assert!(!listing.entries[2].is_hidden);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn listing_a_file_or_a_missing_path_is_an_error() {
        let dir = temp_dir("folder-list-err");
        let file = dir.join("note.md");
        fs::write(&file, "x").unwrap();
        assert!(list_folder_blocking(&file).is_err());
        assert!(list_folder_blocking(&dir.join("missing")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_directory_lists_as_a_directory() {
        let dir = temp_dir("folder-list-link");
        fs::create_dir(dir.join("real")).unwrap();
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).unwrap();
        let listing = list_folder_blocking(&dir).unwrap();
        assert!(listing.entries.iter().all(|e| e.is_dir));
        fs::remove_dir_all(&dir).unwrap();
    }

    fn search_fixture(tag: &str) -> PathBuf {
        let dir = temp_dir(tag);
        fs::create_dir_all(dir.join("journal")).unwrap();
        fs::create_dir_all(dir.join("node_modules").join("pkg")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("journal").join("2024-01.md"), "").unwrap();
        fs::write(dir.join("journal").join("notes.txt"), "").unwrap();
        fs::write(dir.join("journal-index.md"), "").unwrap();
        fs::write(dir.join("node_modules").join("pkg").join("journal.md"), "").unwrap();
        fs::write(dir.join(".git").join("journal.md"), "").unwrap();
        fs::write(dir.join("image.png"), "").unwrap();
        dir
    }

    fn rel(result: &FolderSearchResult) -> Vec<&str> {
        result
            .hits
            .iter()
            .map(|h| h.relative_path.as_str())
            .collect()
    }

    #[test]
    fn search_matches_every_term_against_the_relative_path_and_ranks_name_hits_first() {
        let dir = search_fixture("folder-search");
        let md = vec!["md".to_string()];

        let result = search_folder_blocking(&dir, "journal", false, Some(&md)).unwrap();
        assert_eq!(rel(&result), vec!["journal-index.md", "journal/2024-01.md"]);

        let result = search_folder_blocking(&dir, "JOURNAL 2024", false, Some(&md)).unwrap();
        assert_eq!(rel(&result), vec!["journal/2024-01.md"]);
        assert!(!result.truncated);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_skips_hidden_and_dependency_trees_and_honours_the_extension_filter() {
        let dir = search_fixture("folder-search-filter");

        let all = search_folder_blocking(&dir, "journal", false, None).unwrap();
        // Neither file under `journal/` has the term in its own name, so the
        // shorter path ranks first.
        assert_eq!(
            rel(&all),
            vec![
                "journal-index.md",
                "journal/notes.txt",
                "journal/2024-01.md"
            ]
        );

        let hidden = search_folder_blocking(&dir, "journal", true, None).unwrap();
        assert!(rel(&hidden).contains(&".git/journal.md"));
        assert!(!rel(&hidden).iter().any(|p| p.starts_with("node_modules")));

        let empty = search_folder_blocking(&dir, "   ", false, None).unwrap();
        assert!(empty.hits.is_empty());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn creating_never_overwrites_an_existing_entry() {
        let dir = temp_dir("folder-create");
        let file = dir.join("new.md");
        create_file_blocking(&file).unwrap();
        fs::write(&file, "keep me").unwrap();
        let error = create_file_blocking(&file).unwrap_err();
        assert_eq!(error, "\"new.md\" already exists");
        assert_eq!(fs::read_to_string(&file).unwrap(), "keep me");

        let sub = dir.join("sub");
        create_directory_blocking(&sub).unwrap();
        assert!(sub.is_dir());
        assert_eq!(
            create_directory_blocking(&sub).unwrap_err(),
            "\"sub\" already exists"
        );
        assert!(create_directory_blocking(&file).is_err());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_event_is_attributed_to_the_watched_directory_that_lists_it() {
        let watched = vec![
            ("/notes".to_string(), PathBuf::from("/notes")),
            ("/var/x".to_string(), PathBuf::from("/private/var/x")),
        ];
        assert_eq!(
            owning_directory(Path::new("/notes/a.md"), &watched),
            Some("/notes".to_string())
        );
        assert_eq!(
            owning_directory(Path::new("/private/var/x/b.md"), &watched),
            Some("/var/x".to_string())
        );
        assert_eq!(
            owning_directory(Path::new("/notes/sub/c.md"), &watched),
            None
        );
    }
}
