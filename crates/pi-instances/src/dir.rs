//! The registry directory and its owner-only checks.
//!
//! Both publishing and listing require a real directory (never a symlink or
//! junction: listing prunes `*.json` files, so following a planted link would
//! turn it into a deletion tool). Unix: owned by the effective uid and
//! tightened to 0700 when looser (created 0700). Windows: owned by the current
//! user with a protected DACL granting only that user. Both publishing and
//! listing verify first ([`pi_ipc::winsec::verify_dir_restricted`]) and
//! repair only what is loose
//! ([`pi_ipc::winsec::restrict_dir_to_current_user`]), so steady-state polls
//! never rewrite security descriptors.

use std::{
	io,
	path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum DirError {
	#[error("insecure instance registry directory {0}: {1}")]
	Insecure(PathBuf, &'static str),
	#[error("instance registry directory {0}: {1}")]
	Io(PathBuf, #[source] io::Error),
}

/// Create `dir` (and missing parents) owner-only, then secure it like
/// [`assert_private_dir`].
pub fn ensure_private_dir(dir: &Path) -> Result<(), DirError> {
	#[cfg(unix)]
	let created = {
		use std::os::unix::fs::DirBuilderExt;
		std::fs::DirBuilder::new()
			.recursive(true)
			.mode(0o700)
			.create(dir)
	};
	#[cfg(windows)]
	let created = std::fs::create_dir_all(dir);
	created.map_err(|error| DirError::Io(dir.to_owned(), error))?;
	if assert_private_dir(dir)? {
		Ok(())
	} else {
		Err(DirError::Io(dir.to_owned(), io::ErrorKind::NotFound.into()))
	}
}

/// Secure an existing `dir`; `Ok(false)` when it does not exist.
///
/// Fails when `dir` is a link, not a directory, or (Unix) owned by another
/// user. Loose security is repaired: a Unix mode with group/other bits is
/// tightened to 0700; on Windows an owner or DACL that is not current-user
/// only is reset. A directory that is already private is only read.
pub fn assert_private_dir(dir: &Path) -> Result<bool, DirError> {
	let meta = match std::fs::symlink_metadata(dir) {
		Ok(meta) => meta,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(error) => return Err(DirError::Io(dir.to_owned(), error)),
	};
	if meta.file_type().is_symlink() {
		return Err(DirError::Insecure(dir.to_owned(), "is a symlink"));
	}
	if !meta.file_type().is_dir() {
		return Err(DirError::Insecure(dir.to_owned(), "not a directory"));
	}
	#[cfg(unix)]
	{
		let owned = pi_ipc::tighten_owned_dir(dir, &meta)
			.map_err(|error| DirError::Io(dir.to_owned(), error))?;
		if !owned {
			return Err(DirError::Insecure(dir.to_owned(), "owned by another user"));
		}
	}
	#[cfg(windows)]
	if !pi_ipc::winsec::verify_dir_restricted(dir)
		.map_err(|error| DirError::Io(dir.to_owned(), error))?
	{
		pi_ipc::winsec::restrict_dir_to_current_user(dir).map_err(|_| {
			DirError::Insecure(dir.to_owned(), "cannot restrict access to the current user")
		})?;
	}
	Ok(true)
}
