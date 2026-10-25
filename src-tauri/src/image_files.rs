//! Destructive image operations are confined to the application's flat image directory.
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// All current instances sharing a profile must acquire this before capture or
/// cleanup. The OS releases ownership after a crash; never delete the lock file.
#[derive(Clone)]
pub struct ImageDirectoryOwner {
    _file: std::sync::Arc<File>,
}

impl ImageDirectoryOwner {
    pub fn acquire(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir).map_err(|e| format!("Cannot create app data: {e}"))?;
        let path = data_dir.join(".image-owner.lock");
        match fs::symlink_metadata(&path) {
            Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
                return Err("Image ownership lock must be a regular file".into())
            }
            Err(error) if error.kind() != ErrorKind::NotFound => return Err(error.to_string()),
            _ => {}
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| format!("Cannot open image ownership lock: {e}"))?;
        file.try_lock().map_err(|e| {
            format!("Cannot own image storage (another SuperPaste instance may be running): {e}")
        })?;
        Ok(Self {
            _file: std::sync::Arc::new(file),
        })
    }
}

/// Only application-generated flat PNG names are eligible for orphan recovery.
/// Legacy versions allocated independent UUIDs for original and thumbnail.
fn is_generated_image_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".png") else {
        return false;
    };
    let id = stem.strip_suffix("_thumb").unwrap_or(stem);
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Caller holds the capture mutex throughout enumeration. Files being written
/// or awaiting SQLite persistence must be supplied in protected_paths.
pub fn orphan_candidates(
    images_dir: &Path,
    protected_paths: &HashSet<PathBuf>,
) -> Result<Vec<PathBuf>, String> {
    let metadata = match fs::symlink_metadata(images_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot inspect image directory: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Image directory must be a real directory, not a symlink".into());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(images_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !entry
            .file_name()
            .to_str()
            .is_some_and(is_generated_image_name)
            || protected_paths.contains(&path)
        {
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_file() && !kind.is_symlink() {
            validate_image_path(images_dir, &path)?;
            candidates.push(path);
        }
    }
    Ok(candidates)
}

/// Validate every path before deleting any of them. Missing app-owned files are
/// already cleaned up, but permission errors and unsafe paths must be reported.
pub fn delete_owned_images(images_dir: &Path, paths: &[PathBuf]) -> Result<(), String> {
    delete_unreferenced_images(images_dir, paths, &[])
}

pub fn delete_unreferenced_images(
    images_dir: &Path,
    paths: &[PathBuf],
    references: &[PathBuf],
) -> Result<(), String> {
    let validated = paths
        .iter()
        .map(|path| validate_image_path(images_dir, path))
        .collect::<Result<Vec<_>, _>>()?;
    // DB paths from older versions may use different casing, symlink ancestors,
    // or Windows path prefixes. Compare file identities, not just SQL strings.
    let mut protected = HashSet::new();
    for reference in references {
        match fs::canonicalize(reference) {
            Ok(path) => {
                protected.insert(path);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot verify referenced image: {error}")),
        }
    }
    for path in validated.into_iter().flatten() {
        if protected.contains(&path) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Failed to remove image: {error}")),
        }
    }
    Ok(())
}

/// A failed encoder/write must not leave either half of a newly allocated image
/// pair behind. The caller supplies fresh paths inside the owned directory.
pub fn write_image_pair(
    image_path: &Path,
    thumbnail_path: &Path,
    write: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Err(error) = write() {
        let mut cleanup_errors = Vec::new();
        for path in [image_path, thumbnail_path] {
            if let Err(cleanup_error) = fs::remove_file(path) {
                if cleanup_error.kind() != ErrorKind::NotFound {
                    cleanup_errors.push(cleanup_error.to_string());
                }
            }
        }
        return if cleanup_errors.is_empty() {
            Err(error)
        } else {
            Err(format!(
                "{error}; partial-file cleanup failed: {}",
                cleanup_errors.join("; ")
            ))
        };
    }
    Ok(())
}

fn validate_image_path(images_dir: &Path, path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || path.file_name().is_none()
    {
        return Err("Image path must be an absolute app-owned file without traversal".into());
    }

    // All files written by this application live directly in images/, never in
    // subdirectories. Reject alternate/symlinked parent paths before resolving.
    if path.parent() != Some(images_dir) {
        return Err("Image path is outside the application's image directory".into());
    }
    let root_metadata = match fs::symlink_metadata(images_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect image directory: {error}")),
    };
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Image directory must be a real directory, not a symlink".into());
    }
    let root = fs::canonicalize(images_dir)
        .map_err(|error| format!("Cannot resolve image directory: {error}"))?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect image file: {error}")),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(
            "Image deletion only accepts regular files, not symlinks or directories".into(),
        );
    }
    let canonical =
        fs::canonicalize(path).map_err(|error| format!("Cannot resolve image file: {error}"))?;
    if canonical.parent() != Some(root.as_path()) {
        return Err("Resolved image path is outside the application's image directory".into());
    }
    Ok(Some(canonical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_DIRECTORY: AtomicUsize = AtomicUsize::new(0);

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "superpaste-image-test-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("images")).unwrap();
            Self(root)
        }
        fn images(&self) -> PathBuf {
            self.0.join("images")
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn deletes_owned_files_and_tolerates_missing_files() {
        let dir = TestDirectory::new();
        let image = dir.images().join("sample.png");
        fs::write(&image, b"test").unwrap();
        delete_owned_images(&dir.images(), &[image.clone()]).unwrap();
        assert!(!image.exists());
        delete_owned_images(&dir.images(), &[image]).unwrap();
    }

    #[test]
    fn validates_the_whole_batch_before_removing_anything() {
        let dir = TestDirectory::new();
        let image = dir.images().join("sample.png");
        let outside = dir.0.join("private.txt");
        fs::write(&image, b"test").unwrap();
        fs::write(&outside, b"private").unwrap();
        assert!(delete_owned_images(&dir.images(), &[image.clone(), outside.clone()]).is_err());
        assert!(image.exists());
        assert!(outside.exists());
    }

    #[test]
    fn rejects_traversal_directories_and_relative_paths() {
        let dir = TestDirectory::new();
        assert!(
            delete_owned_images(&dir.images(), &[dir.images().join("../private.txt")]).is_err()
        );
        assert!(delete_owned_images(&dir.images(), &[PathBuf::from("sample.png")]).is_err());
        let nested = dir.images().join("nested");
        fs::create_dir(&nested).unwrap();
        assert!(delete_owned_images(&dir.images(), &[nested]).is_err());
    }

    #[test]
    fn failed_pair_write_removes_original_and_partial_thumbnail() {
        let dir = TestDirectory::new();
        let image = dir.images().join("image.png");
        let thumbnail = dir.images().join("thumbnail.png");
        let result = write_image_pair(&image, &thumbnail, || {
            fs::write(&image, b"original").unwrap();
            fs::write(&thumbnail, b"partial").unwrap();
            Err("thumbnail write failed".into())
        });
        assert_eq!(result, Err("thumbnail write failed".into()));
        assert!(!image.exists());
        assert!(!thumbnail.exists());
    }

    #[test]
    fn successful_pair_write_keeps_both_files() {
        let dir = TestDirectory::new();
        let image = dir.images().join("image.png");
        let thumbnail = dir.images().join("thumbnail.png");
        write_image_pair(&image, &thumbnail, || {
            fs::write(&image, b"original").unwrap();
            fs::write(&thumbnail, b"thumbnail").unwrap();
            Ok(())
        })
        .unwrap();
        assert!(image.exists());
        assert!(thumbnail.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_and_symlinked_image_directory() {
        use std::os::unix::fs::symlink;
        let dir = TestDirectory::new();
        let outside = dir.0.join("private.txt");
        let link = dir.images().join("link.png");
        fs::write(&outside, b"private").unwrap();
        symlink(&outside, &link).unwrap();
        assert!(delete_owned_images(&dir.images(), &[link]).is_err());
        let alias = dir.0.join("alias");
        symlink(dir.images(), &alias).unwrap();
        assert!(delete_owned_images(&alias, &[alias.join("missing.png")]).is_err());
        assert!(outside.exists());
    }
    const ID_A: &str = "11111111-1111-4111-8111-111111111111";
    const ID_B: &str = "22222222-2222-4222-8222-222222222222";

    #[test]
    fn scanner_recovers_legacy_separate_ids_and_partial_pairs_but_not_unknown_files() {
        let dir = TestDirectory::new();
        let original = dir.images().join(format!("{ID_A}.png"));
        let legacy_thumb = dir.images().join(format!("{ID_B}_thumb.png"));
        for file in [
            &original,
            &legacy_thumb,
            &dir.images().join("user-photo.png"),
            &dir.images().join("notes.txt"),
        ] {
            fs::write(file, b"data").unwrap();
        }
        fs::create_dir(
            dir.images()
                .join("33333333-3333-4333-8333-333333333333.png"),
        )
        .unwrap();
        let found = orphan_candidates(&dir.images(), &HashSet::new()).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found.contains(&original));
        assert!(found.contains(&legacy_thumb));
        let protected = HashSet::from([original.clone()]);
        assert_eq!(
            orphan_candidates(&dir.images(), &protected).unwrap(),
            vec![legacy_thumb]
        );
        assert!(original.exists());
    }

    #[test]
    fn scanner_only_accepts_exact_generated_names() {
        for name in [format!("{ID_A}.png"), format!("{ID_A}_thumb.png")] {
            assert!(is_generated_image_name(&name));
        }
        for name in [
            "photo.png",
            "../11111111-1111-4111-8111-111111111111.png",
            "11111111111141118111111111111111.png",
            "11111111-1111-4111-8111-11111111111z.png",
            "11111111-1111-4111-8111-111111111111.png.tmp",
        ] {
            assert!(!is_generated_image_name(name));
        }
    }

    #[cfg(unix)]
    #[test]
    fn scan_ignores_symlinks_and_preserves_referenced_alias_identity() {
        use std::os::unix::fs::symlink;
        let dir = TestDirectory::new();
        let original = dir.images().join(format!("{ID_A}.png"));
        fs::write(&original, b"real").unwrap();
        let link = dir.images().join(format!("{ID_B}.png"));
        symlink(&original, &link).unwrap();
        assert_eq!(
            orphan_candidates(&dir.images(), &HashSet::new()).unwrap(),
            vec![original.clone()]
        );
        let alias = dir.0.join("alias");
        symlink(dir.images(), &alias).unwrap();
        delete_unreferenced_images(
            &dir.images(),
            &[original.clone()],
            &[alias.join(format!("{ID_A}.png"))],
        )
        .unwrap();
        assert!(original.exists());
        assert!(orphan_candidates(&alias, &HashSet::new()).is_err());
        assert!(delete_unreferenced_images(&dir.images(), &[link], &[]).is_err());
    }

    #[test]
    fn lock_is_exclusive_across_handles_and_released_after_owner_drop() {
        let dir = TestDirectory::new();
        let owner = ImageDirectoryOwner::acquire(&dir.0).unwrap();
        assert!(ImageDirectoryOwner::acquire(&dir.0).is_err());
        drop(owner);
        assert!(ImageDirectoryOwner::acquire(&dir.0).is_ok());
        assert!(dir.0.join(".image-owner.lock").exists());
    }

    #[test]
    fn lock_child_probe() {
        if let Some(path) = std::env::var_os("SUPERPASTE_LOCK_TEST_PATH") {
            assert!(ImageDirectoryOwner::acquire(Path::new(&path)).is_err());
        }
    }

    #[test]
    fn lock_prevents_second_process_ownership() {
        let dir = TestDirectory::new();
        let _owner = ImageDirectoryOwner::acquire(&dir.0).unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "image_files::tests::lock_child_probe",
                "--nocapture",
            ])
            .env("SUPERPASTE_LOCK_TEST_PATH", &dir.0)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // The test name is module-qualified in cargo; standalone compilation
        // uses tests:: below and is exercised separately by the same probe.
        if String::from_utf8_lossy(&output.stdout).contains("0 tests") {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "tests::lock_child_probe", "--nocapture"])
                .env("SUPERPASTE_LOCK_TEST_PATH", &dir.0)
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn lock_rejects_symlink_instead_of_locking_external_file() {
        use std::os::unix::fs::symlink;
        let dir = TestDirectory::new();
        let outside = dir.0.join("outside");
        fs::write(&outside, b"untouched").unwrap();
        symlink(&outside, dir.0.join(".image-owner.lock")).unwrap();
        assert!(ImageDirectoryOwner::acquire(&dir.0).is_err());
        assert_eq!(fs::read(outside).unwrap(), b"untouched");
    }
}
