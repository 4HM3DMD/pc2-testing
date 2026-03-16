//! Render mode — static asset rendering (images, text, PDFs, code).
//!
//! Each sub-module takes decrypted plaintext bytes and produces
//! a lossy pixel output (JPEG/WebP/PNG) with optional watermark.

#[cfg(feature = "image-render")]
pub mod image;

#[cfg(feature = "text-render")]
pub mod text;

#[cfg(feature = "pdf-render")]
pub mod pdf;

#[cfg(feature = "code-render")]
pub mod code;
