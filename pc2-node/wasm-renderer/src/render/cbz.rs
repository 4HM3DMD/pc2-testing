//! CBZ comic-book renderer — pixel-lock tier.
//!
//! Enumerates the ZIP archive for image entries, sorts them in natural
//! (human) order so `page10.jpg` follows `page2.jpg`, then decodes the
//! requested page, resizes, applies the buyer watermark, and re-encodes
//! as a lossy JPEG. Output contract matches the image renderer so the
//! viewer can display comics with the same pixel-lock guarantees as PDFs.

use std::io::{Cursor, Read};

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, RgbaImage};
use zip::ZipArchive;

use crate::watermark::apply_watermark;
use crate::{RenderCommand, RenderResult};

const DEFAULT_MAX_WIDTH: u32 = 1600;
const DEFAULT_MAX_HEIGHT: u32 = 2400;
const DEFAULT_JPEG_QUALITY: u8 = 85;

/// Supported page image extensions inside CBZ archives.
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp"];

/// Hard ceiling on uncompressed size of any single page we read into
/// WASM memory. 48 MB covers double-spread high-DPI scans; anything
/// beyond is treated as a zip-bomb header and rejected.
const MAX_PAGE_UNCOMPRESSED_BYTES: u64 = 48 * 1024 * 1024;

/// Compression-ratio ceiling — see equivalent constant in `epub.rs`.
const MAX_COMPRESSION_RATIO: u64 = 200;

/// Maximum number of page entries we will index in a CBZ. No real
/// comic archive approaches this; the cap blocks a hostile ZIP with
/// millions of `__MACOSX/`-style decoy filenames from blowing memory
/// during enumeration.
const MAX_PAGES: usize = 10_000;

/// Render one page of a CBZ archive to a watermarked JPEG.
pub fn render_cbz_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let cursor = Cursor::new(plaintext);
    let mut archive = match ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(e) => return (RenderResult::error(format!("cbz: open archive: {e}")), None),
    };

    let pages = enumerate_pages(&mut archive);
    if pages.is_empty() {
        return (RenderResult::error("cbz: no image pages found"), None);
    }

    let total = pages.len() as u32;
    let requested = cmd.page.unwrap_or(0).min(total.saturating_sub(1));
    let page_name = &pages[requested as usize];

    let img_bytes = match read_zip_entry(&mut archive, page_name) {
        Ok(b) => b,
        Err(e) => return (RenderResult::error(format!("cbz: read page: {e}")), None),
    };

    let img = match image::load_from_memory(&img_bytes) {
        Ok(i) => i,
        Err(e) => return (RenderResult::error(format!("cbz: decode page: {e}")), None),
    };

    let max_w = cmd.max_width.unwrap_or(DEFAULT_MAX_WIDTH);
    let max_h = cmd.max_height.unwrap_or(DEFAULT_MAX_HEIGHT);
    let img = resize_if_needed(img, max_w, max_h);

    let mut rgba: RgbaImage = img.to_rgba8();
    if let Some(ref wm) = cmd.watermark {
        apply_watermark(&mut rgba, wm);
    }

    let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
    let mut buf = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, DEFAULT_JPEG_QUALITY);
    if let Err(e) = encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    ) {
        return (RenderResult::error(format!("cbz: jpeg encode: {e}")), None);
    }

    let result = RenderResult {
        success: true,
        content_type: Some("image/jpeg".to_string()),
        total_pages: Some(total),
        output_size: Some(buf.len()),
        ..Default::default()
    };
    (result, Some(buf))
}

/// Enumerate all image entries in the archive and sort them by natural
/// human order (e.g. page2.jpg < page10.jpg).
fn enumerate_pages<R: Read + std::io::Seek>(archive: &mut ZipArchive<R>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for i in 0..archive.len() {
        if names.len() >= MAX_PAGES {
            break;
        }
        if let Ok(file) = archive.by_index(i) {
            if file.is_dir() {
                continue;
            }
            let name = file.name().to_string();
            if is_image_name(&name) && !is_osx_junk(&name) {
                names.push(name);
            }
        }
    }
    names.sort_by(|a, b| natural_cmp(a, b));
    names
}

fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IMAGE_EXTS.iter().any(|ext| lower.ends_with(&format!(".{ext}")))
}

/// Skip macOS metadata files that some CBZ archives contain.
fn is_osx_junk(name: &str) -> bool {
    name.starts_with("__MACOSX/") || name.contains("/.DS_Store") || name.ends_with(".DS_Store")
}

fn read_zip_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut entry = archive.by_name(name).map_err(|e| e.to_string())?;
    let declared = entry.size();
    let compressed = entry.compressed_size();

    // Pre-allocation defence — ZIP sizes are attacker-controlled.
    if declared > MAX_PAGE_UNCOMPRESSED_BYTES {
        return Err(format!(
            "page '{}' too large: declared {} bytes (cap {})",
            name, declared, MAX_PAGE_UNCOMPRESSED_BYTES
        ));
    }
    if compressed > 0 && declared / compressed.max(1) > MAX_COMPRESSION_RATIO {
        return Err(format!(
            "page '{}' rejected: suspicious compression ratio {}x",
            name,
            declared / compressed.max(1)
        ));
    }

    let cap = (declared as usize).min(MAX_PAGE_UNCOMPRESSED_BYTES as usize);
    let mut buf = Vec::with_capacity(cap);
    let mut limited = (&mut entry).take(MAX_PAGE_UNCOMPRESSED_BYTES + 1);
    limited.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_PAGE_UNCOMPRESSED_BYTES {
        return Err(format!(
            "page '{}' exceeded uncompressed cap during read",
            name
        ));
    }
    Ok(buf)
}

fn resize_if_needed(img: DynamicImage, max_w: u32, max_h: u32) -> DynamicImage {
    let (w, h) = (img.width(), img.height());
    if w <= max_w && h <= max_h {
        return img;
    }
    let ratio_w = max_w as f64 / w as f64;
    let ratio_h = max_h as f64 / h as f64;
    let ratio = ratio_w.min(ratio_h);
    let new_w = (w as f64 * ratio).max(1.0) as u32;
    let new_h = (h as f64 * ratio).max(1.0) as u32;
    img.resize_exact(new_w, new_h, FilterType::Lanczos3)
}

/// Natural (human) filename comparison: splits into runs of digits and
/// non-digits, comparing digit runs numerically so `p2 < p10`.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let mut i = 0usize;
    let mut j = 0usize;

    while i < a_bytes.len() && j < b_bytes.len() {
        let ad = a_bytes[i].is_ascii_digit();
        let bd = b_bytes[j].is_ascii_digit();
        if ad && bd {
            let (a_num, a_end) = take_number(a_bytes, i);
            let (b_num, b_end) = take_number(b_bytes, j);
            match a_num.cmp(&b_num) {
                Ordering::Equal => {}
                ord => return ord,
            }
            i = a_end;
            j = b_end;
        } else {
            let ac = a_bytes[i].to_ascii_lowercase();
            let bc = b_bytes[j].to_ascii_lowercase();
            match ac.cmp(&bc) {
                Ordering::Equal => {}
                ord => return ord,
            }
            i += 1;
            j += 1;
        }
    }

    a_bytes.len().cmp(&b_bytes.len())
}

fn take_number(s: &[u8], start: usize) -> (u128, usize) {
    let mut n: u128 = 0;
    let mut i = start;
    while i < s.len() && s[i].is_ascii_digit() {
        // Saturate at u128::MAX to avoid panic on absurd filenames; any
        // real-world comic archive is far below that bound.
        n = n.saturating_mul(10).saturating_add((s[i] - b'0') as u128);
        i += 1;
    }
    (n, i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_sort_pages() {
        let mut v = vec!["page10.jpg", "page2.jpg", "page1.jpg", "page20.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["page1.jpg", "page2.jpg", "page10.jpg", "page20.jpg"]);
    }

    #[test]
    fn natural_sort_mixed() {
        let mut v = vec!["ch2/p10.jpg", "ch2/p2.jpg", "ch10/p1.jpg", "ch1/p5.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec!["ch1/p5.jpg", "ch2/p2.jpg", "ch2/p10.jpg", "ch10/p1.jpg"]
        );
    }

    #[test]
    fn is_image_name_works() {
        assert!(is_image_name("page01.jpg"));
        assert!(is_image_name("PAGE01.PNG"));
        assert!(!is_image_name("readme.txt"));
        assert!(!is_image_name("cover.xml"));
    }

    #[test]
    fn osx_junk_skipped() {
        assert!(is_osx_junk("__MACOSX/page01.jpg"));
        assert!(is_osx_junk("foo/.DS_Store"));
        assert!(!is_osx_junk("chapter/page01.jpg"));
    }

    #[test]
    fn safety_constants_are_conservative() {
        // Guard-rail — keeps future edits from silently widening the caps.
        assert!(MAX_PAGE_UNCOMPRESSED_BYTES <= 128 * 1024 * 1024);
        assert!(MAX_COMPRESSION_RATIO <= 500);
        assert!(MAX_PAGES <= 100_000);
    }
}
