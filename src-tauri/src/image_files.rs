//! Destructive image operations are confined to the application's flat image directory.
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// Validate every path before deleting any of them. Missing app-owned files are
/// already cleaned up, but permission errors and unsafe paths must be reported.
pub fn delete_owned_images(images_dir: &Path, paths: &[PathBuf]) -> Result<(), String> {
    let validated = paths
        .iter()
        .map(|path| validate_image_path(images_dir, path))
        .collect::<Result<Vec<_>, _>>()?;

    for path in validated.into_iter().flatten() {
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
}
