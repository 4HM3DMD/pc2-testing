//! Render mode — static asset rendering.
//!
//! Each sub-module takes decrypted plaintext bytes and produces either:
//!   * lossy pixel output (JPEG/WebP/PNG) with watermark — "pixel-lock" tier
//!   * sanitized HTML (EPUB reflowable) — "html-lock" tier
//!
//! Both tiers honour the same `DRMProvider.render()` capsule contract:
//! the returned bytes are opaque to the caller and carry their own MIME
//! type via `RenderResult.content_type`.

#[cfg(feature = "image-render")]
pub mod image;

#[cfg(feature = "text-render")]
pub mod text;

#[cfg(feature = "pdf-render")]
pub mod pdf;

#[cfg(feature = "code-render")]
pub mod code;

#[cfg(feature = "epub-render")]
pub mod epub;

#[cfg(feature = "cbz-render")]
pub mod cbz;
