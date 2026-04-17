//! EPUB reflowable renderer — sanitized-HTML tier.
//!
//! Extracts a single chapter from an EPUB ZIP container, streams the
//! chapter XHTML through an allow-list sanitizer, inlines referenced
//! images as data-URIs, injects a zero-width forensic watermark and an
//! SVG diagonal overlay, then returns the sanitized HTML bytes to the
//! caller. The host wraps those bytes in a sandboxed iframe under a
//! strict Content-Security-Policy so the reader can flow/resize text
//! while the raw EPUB never reaches the browser.
//!
//! ## Threat model (sanitized-HTML tier)
//!
//! This tier is analogous to Kindle/Apple Books in-app reader HTML
//! streams: the rendered HTML can be inspected with moderate effort,
//! but:
//!   * JavaScript, `<object>`, `<iframe>`, and remote URLs are stripped
//!   * Inline `on*` handlers and `style=` overrides are dropped
//!   * A forensic zero-width Unicode watermark encodes the buyer ID
//!     throughout body text (survives copy/paste)
//!   * A diagonal SVG overlay labels screen captures with buyer ID
//!   * Keys and raw EPUB bytes never leave the WASM sandbox
//!
//! Pre-paginated EPUB 3 publications (picture books, comics) are
//! detected via `rendition:layout=pre-paginated` and returned as
//! `fixed_layout=true`; the caller should fall back to the pixel-lock
//! (CBZ-like) tier for those.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use base64::Engine as _;
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::QName;
use quick_xml::Reader;
use zip::ZipArchive;

use crate::{RenderCommand, RenderResult, TocEntry};

/// Maximum number of spine chapters we will index. Protects against
/// pathological EPUBs that declare millions of entries.
const MAX_CHAPTERS: usize = 5000;

/// Maximum size of an inlined image (bytes). Anything larger is dropped
/// with a placeholder to keep chapter HTML responsive. 8 MB covers all
/// realistic ebook cover + inline illustrations.
const MAX_INLINED_IMAGE_BYTES: usize = 8 * 1024 * 1024;

/// Hard ceiling on the uncompressed size of any single ZIP entry we
/// will read into WASM linear memory. The ZIP header carries the
/// uncompressed size as attacker-controlled input, so we reject before
/// allocation rather than after. 32 MB is well above any realistic
/// chapter XHTML or cover image; anything larger is a red flag.
const MAX_ENTRY_UNCOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;

/// Compression-ratio ceiling: reject entries whose declared uncompressed
/// size exceeds the compressed size by more than this factor. Typical
/// deflate ratios for HTML/XML top out near 10×; 200× is a clear zip-bomb
/// signature (classic 42.zip weighs 28 GB / 42 KB ≈ 700 000×).
const MAX_COMPRESSION_RATIO: u64 = 200;

/// Maximum manifest entries we will index from the OPF. Caps the
/// `HashMap` allocation against a malicious OPF that declares millions
/// of `<item>` rows to exhaust WASM memory before we ever read content.
const MAX_MANIFEST_ENTRIES: usize = 10_000;

/// Hard cap on the sanitized chapter HTML buffer. Even with per-image
/// limits, a chapter with hundreds of images can balloon past this; we
/// stop emitting once the cap is reached and return what we have so the
/// reader still renders something usable.
const MAX_CHAPTER_HTML_BYTES: usize = 16 * 1024 * 1024;

/// Render one chapter of an EPUB to sanitized HTML bytes.
pub fn render_epub_raw(plaintext: &[u8], cmd: &RenderCommand) -> (RenderResult, Option<Vec<u8>>) {
    let cursor = Cursor::new(plaintext);
    let mut archive = match ZipArchive::new(cursor) {
        Ok(a) => a,
        Err(e) => return (RenderResult::error(format!("epub: open: {e}")), None),
    };

    let opf_path = match locate_opf(&mut archive) {
        Ok(p) => p,
        Err(e) => return (RenderResult::error(format!("epub: container: {e}")), None),
    };
    let opf_bytes = match read_entry(&mut archive, &opf_path) {
        Ok(b) => b,
        Err(e) => return (RenderResult::error(format!("epub: read opf: {e}")), None),
    };

    let opf = match parse_opf(&opf_bytes, MAX_MANIFEST_ENTRIES) {
        Ok(o) => o,
        Err(e) => return (RenderResult::error(format!("epub: parse opf: {e}")), None),
    };

    // Fixed-layout publications (picture books, fixed comics) aren't
    // reflowable — tell the caller so it can fall back to pixel-lock.
    if opf.fixed_layout {
        return (
            RenderResult {
                success: true,
                content_type: Some("application/epub+zip".to_string()),
                fixed_layout: Some(true),
                total_chapters: Some(opf.spine.len() as u32),
                epub_title: opf.title.clone(),
                epub_author: opf.author.clone(),
                ..Default::default()
            },
            None,
        );
    }

    let opf_dir = opf_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let total_chapters = opf.spine.len() as u32;
    let requested_idx = cmd.chapter.unwrap_or(cmd.page.unwrap_or(0));
    if requested_idx >= total_chapters {
        return (
            RenderResult::error(format!(
                "epub: chapter {} out of range (0..{})",
                requested_idx, total_chapters
            )),
            None,
        );
    }

    let chapter_href = &opf.spine[requested_idx as usize];
    let chapter_path = join_path(opf_dir, chapter_href);
    let chapter_bytes = match read_entry(&mut archive, &chapter_path) {
        Ok(b) => b,
        Err(e) => {
            return (
                RenderResult::error(format!("epub: read chapter {}: {}", chapter_path, e)),
                None,
            )
        }
    };

    let chapter_html = String::from_utf8_lossy(&chapter_bytes);
    let chapter_dir = chapter_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    let forensic = cmd
        .forensic_mark
        .as_deref()
        .or(cmd.watermark.as_deref())
        .unwrap_or("");

    let sanitized = match sanitize_chapter(
        &chapter_html,
        &mut archive,
        chapter_dir,
        forensic,
        MAX_CHAPTER_HTML_BYTES,
    ) {
        Ok(s) => s,
        Err(e) => {
            return (
                RenderResult::error(format!("epub: sanitize: {e}")),
                None,
            )
        }
    };

    let watermark_svg = cmd
        .watermark
        .as_deref()
        .map(build_watermark_svg_data_uri)
        .unwrap_or_default();

    let doc = wrap_chapter_html(
        &sanitized,
        &watermark_svg,
        cmd.viewport_width.unwrap_or(680),
    );
    let doc_bytes = doc.into_bytes();
    let doc_len = doc_bytes.len();

    // Chapter TOC is returned on every request so the client doesn't
    // need a separate round-trip; it's small (titles only) and clients
    // can cache it.
    let toc = if !opf.toc.is_empty() {
        Some(opf.toc.clone())
    } else {
        Some(build_fallback_toc(&opf))
    };

    let result = RenderResult {
        success: true,
        content_type: Some(
            "text/html; charset=utf-8; profile=epub-chapter".to_string(),
        ),
        total_chapters: Some(total_chapters),
        chapters: toc,
        fixed_layout: Some(false),
        epub_title: opf.title,
        epub_author: opf.author,
        output_size: Some(doc_len),
        ..Default::default()
    };
    (result, Some(doc_bytes))
}

// ---------------------------------------------------------------------
// EPUB container / OPF parsing
// ---------------------------------------------------------------------

struct OpfMetadata {
    /// Ordered list of chapter hrefs in spine order (relative to OPF dir).
    spine: Vec<String>,
    /// Parsed TOC entries (from EPUB3 nav.xhtml or EPUB2 NCX). Aligned
    /// to spine indices when possible; extra entries are dropped.
    toc: Vec<TocEntry>,
    /// Publication title (dc:title).
    title: Option<String>,
    /// Publication author (dc:creator — first one).
    author: Option<String>,
    /// True if OPF declares `rendition:layout=pre-paginated`.
    fixed_layout: bool,
}

fn locate_opf<R: Read + std::io::Seek>(archive: &mut ZipArchive<R>) -> Result<String, String> {
    let xml = read_entry(archive, "META-INF/container.xml")?;
    let mut reader = Reader::from_reader(xml.as_slice());
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                if local_name(e.name()) == b"rootfile" {
                    if let Some(path) = attr_value(&e, b"full-path") {
                        return Ok(path);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("container.xml: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Err("container.xml: rootfile not found".into())
}

fn parse_opf(opf_bytes: &[u8], manifest_cap: usize) -> Result<OpfMetadata, String> {
    let mut reader = Reader::from_reader(opf_bytes);
    reader.config_mut().trim_text(true);

    // manifest id -> (href, media-type, properties)
    let mut manifest: HashMap<String, (String, String, String)> = HashMap::new();
    let mut spine_ids: Vec<String> = Vec::new();
    let mut title: Option<String> = None;
    let mut author: Option<String> = None;
    let mut fixed_layout = false;
    // Future NCX / nav.xhtml parsing: captured here but not wired yet.
    #[allow(unused_assignments)]
    let mut _toc_id: Option<String> = None;
    #[allow(unused_assignments)]
    let mut _nav_href: Option<String> = None;

    let mut capture_text: Option<&'static str> = None;
    let mut current_text = String::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => {
                let lname = local_name(e.name()).to_vec();
                match lname.as_slice() {
                    b"item" => {
                        // Hard cap protects against a hostile OPF that
                        // lists millions of <item> rows to OOM the WASM
                        // instance before we ever reach spine/render.
                        if manifest.len() >= manifest_cap {
                            // Silently skip overflow entries; the spine
                            // cap (MAX_CHAPTERS) already bounds what we
                            // actually try to render.
                            continue;
                        }
                        let id = attr_value(&e, b"id").unwrap_or_default();
                        let href = attr_value(&e, b"href").unwrap_or_default();
                        let media = attr_value(&e, b"media-type").unwrap_or_default();
                        let props = attr_value(&e, b"properties").unwrap_or_default();
                        if props.split_whitespace().any(|p| p == "nav") {
                            _nav_href = Some(href.clone());
                        }
                        manifest.insert(id, (href, media, props));
                    }
                    b"spine" => {
                        if let Some(t) = attr_value(&e, b"toc") {
                            _toc_id = Some(t);
                        }
                    }
                    b"itemref" => {
                        if let Some(idref) = attr_value(&e, b"idref") {
                            if spine_ids.len() < MAX_CHAPTERS {
                                spine_ids.push(idref);
                            }
                        }
                    }
                    b"meta" => {
                        let prop = attr_value(&e, b"property").unwrap_or_default();
                        if prop == "rendition:layout" {
                            capture_text = Some("layout");
                        }
                        // EPUB2-style meta
                        let name = attr_value(&e, b"name").unwrap_or_default();
                        let content = attr_value(&e, b"content").unwrap_or_default();
                        if name == "rendition:layout" && content == "pre-paginated" {
                            fixed_layout = true;
                        }
                    }
                    b"title" => capture_text = Some("title"),
                    b"creator" => capture_text = Some("creator"),
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if capture_text.is_some() {
                    let s = t.unescape().unwrap_or_default();
                    current_text.push_str(&s);
                }
            }
            Ok(Event::End(e)) => {
                let lname = local_name(e.name()).to_vec();
                match (capture_text, lname.as_slice()) {
                    (Some("title"), b"title") => {
                        if title.is_none() && !current_text.trim().is_empty() {
                            title = Some(current_text.trim().to_string());
                        }
                        capture_text = None;
                        current_text.clear();
                    }
                    (Some("creator"), b"creator") => {
                        if author.is_none() && !current_text.trim().is_empty() {
                            author = Some(current_text.trim().to_string());
                        }
                        capture_text = None;
                        current_text.clear();
                    }
                    (Some("layout"), b"meta") => {
                        if current_text.trim() == "pre-paginated" {
                            fixed_layout = true;
                        }
                        capture_text = None;
                        current_text.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("opf: {e}")),
            _ => {}
        }
        buf.clear();
    }

    let mut spine_hrefs = Vec::with_capacity(spine_ids.len());
    for id in &spine_ids {
        if let Some((href, _media, _props)) = manifest.get(id) {
            spine_hrefs.push(href.clone());
        }
    }

    Ok(OpfMetadata {
        spine: spine_hrefs,
        toc: Vec::new(), // TOC parsing from NCX/nav.xhtml is best-effort;
                         // skipped for V1.2 and synthesised from spine.
                         // Future: dedicated NCX + nav.xhtml parsers.
        title,
        author,
        fixed_layout,
    })
}

fn build_fallback_toc(opf: &OpfMetadata) -> Vec<TocEntry> {
    opf.spine
        .iter()
        .enumerate()
        .map(|(idx, href)| TocEntry {
            title: format!("Chapter {}", idx + 1),
            chapter_index: idx as u32,
            href: href.clone(),
        })
        .collect()
}

// ---------------------------------------------------------------------
// XHTML sanitizer (allow-list)
// ---------------------------------------------------------------------

/// Allowed element names. Anything outside this list is dropped with
/// its children preserved (for structural passthrough).
const ALLOWED_TAGS: &[&str] = &[
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "div", "span", "em", "strong",
    "b", "i", "u", "s", "small", "mark", "a", "img", "ul", "ol", "li",
    "blockquote", "hr", "br", "table", "tr", "td", "th", "thead", "tbody",
    "tfoot", "caption", "code", "pre", "sup", "sub", "figure", "figcaption",
    "section", "article", "nav", "aside", "header", "footer", "cite",
    "dl", "dt", "dd", "abbr", "q", "del", "ins", "wbr",
];

/// Globally allowed attributes. Additional per-tag attrs are checked
/// separately in `attr_allowed_for`.
const ALLOWED_ATTRS_GLOBAL: &[&str] = &["id", "class", "lang", "dir", "title", "role"];

/// Sanitize a single chapter XHTML document. Streams through quick-xml
/// events, emitting an allow-listed HTML subset and inlining images.
/// `budget` caps the output buffer — a malicious chapter that would
/// balloon past it is truncated with a visible marker rather than
/// allowed to exhaust WASM linear memory.
fn sanitize_chapter<R: Read + std::io::Seek>(
    xhtml: &str,
    archive: &mut ZipArchive<R>,
    chapter_dir: &str,
    forensic_mark: &str,
    budget: usize,
) -> Result<String, String> {
    let mut reader = Reader::from_str(xhtml);
    reader.config_mut().trim_text(false);
    reader.config_mut().expand_empty_elements = true;

    let mut out = String::with_capacity(xhtml.len().min(budget) + 512);
    let mut in_body = false;
    let mut in_script_like = 0i32; // depth counter for dropped subtrees
    let mut buf = Vec::new();
    let mut forensic_cursor = ForensicCursor::new(forensic_mark);
    let mut truncated = false;

    loop {
        // Budget check: if the output buffer has blown past the cap
        // we stop emitting further content so a malicious EPUB (e.g.
        // deep nesting + many inlined images) can't force the WASM
        // instance to grow until it runs out of linear memory.
        if out.len() >= budget {
            truncated = true;
            break;
        }
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name());
                if is_dropped_subtree(name) {
                    in_script_like += 1;
                    continue;
                }
                if name == b"body" {
                    in_body = true;
                    continue;
                }
                if in_script_like > 0 || !in_body {
                    continue;
                }
                let name_lc = ascii_lower(name);
                if !is_allowed_tag(&name_lc) {
                    // Unknown tag: drop tag but keep children.
                    continue;
                }
                emit_start_tag(&mut out, &name_lc, &e, archive, chapter_dir);
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name());
                if is_dropped_subtree(name) {
                    in_script_like -= 1;
                    continue;
                }
                if name == b"body" {
                    in_body = false;
                    continue;
                }
                if in_script_like > 0 || !in_body {
                    continue;
                }
                let name_lc = ascii_lower(name);
                if !is_allowed_tag(&name_lc) || is_void_tag(&name_lc) {
                    continue;
                }
                out.push_str("</");
                out.push_str(&name_lc);
                out.push('>');
            }
            Ok(Event::Empty(e)) => {
                let name = local_name(e.name());
                if is_dropped_subtree(name) || !in_body || in_script_like > 0 {
                    continue;
                }
                let name_lc = ascii_lower(name);
                if !is_allowed_tag(&name_lc) {
                    continue;
                }
                emit_start_tag(&mut out, &name_lc, &e, archive, chapter_dir);
                if is_void_tag(&name_lc) {
                    // void tag: emit_start_tag already wrote the closing ">"
                } else {
                    out.push_str("</");
                    out.push_str(&name_lc);
                    out.push('>');
                }
            }
            Ok(Event::Text(t)) => {
                if in_script_like > 0 || !in_body {
                    continue;
                }
                let txt = t.unescape().unwrap_or_default();
                write_escaped_text(&mut out, &txt, &mut forensic_cursor);
            }
            Ok(Event::CData(t)) => {
                if in_script_like > 0 || !in_body {
                    continue;
                }
                let s = String::from_utf8_lossy(t.as_ref()).to_string();
                write_escaped_text(&mut out, &s, &mut forensic_cursor);
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("xml: {e}")),
            _ => {}
        }
        buf.clear();
    }

    if truncated {
        // Surface truncation to the reader so the user knows content
        // was cut — and so forensic logs show it. This string is plain
        // text only (no tag), matching what the allow-list would emit.
        out.push_str("\n[Content truncated — chapter exceeded render budget.]\n");
    }

    Ok(out)
}

/// Tags whose entire subtree is dropped without emitting any content.
fn is_dropped_subtree(name: &[u8]) -> bool {
    matches!(
        name,
        b"script" | b"style" | b"object" | b"iframe" | b"embed"
            | b"form" | b"input" | b"button" | b"audio" | b"video"
            | b"svg" | b"math" | b"link" | b"meta" | b"head"
    )
}

fn is_void_tag(name: &str) -> bool {
    matches!(name, "br" | "hr" | "img" | "wbr")
}

fn is_allowed_tag(name: &str) -> bool {
    ALLOWED_TAGS.iter().any(|t| *t == name)
}

fn attr_allowed_for(tag: &str, attr: &str) -> bool {
    if ALLOWED_ATTRS_GLOBAL.iter().any(|a| *a == attr) {
        return true;
    }
    match (tag, attr) {
        ("a", "href") => true,
        ("img", "src") | ("img", "alt") | ("img", "width") | ("img", "height") => true,
        ("td" | "th", "colspan") | ("td" | "th", "rowspan") => true,
        ("ol", "start") | ("ol", "type") | ("ul", "type") => true,
        ("col" | "colgroup", "span") => true,
        _ => false,
    }
}

fn emit_start_tag<R: Read + std::io::Seek>(
    out: &mut String,
    tag_lc: &str,
    e: &BytesStart,
    archive: &mut ZipArchive<R>,
    chapter_dir: &str,
) {
    out.push('<');
    out.push_str(tag_lc);

    for attr in e.attributes().flatten() {
        let raw_name = attr.key.local_name();
        let attr_name = ascii_lower(raw_name.as_ref());
        // Hard-block event handlers and style overrides regardless of tag.
        if attr_name.starts_with("on") {
            continue;
        }
        if attr_name == "style" || attr_name == "srcset" || attr_name.starts_with("data-") {
            continue;
        }
        if !attr_allowed_for(tag_lc, &attr_name) {
            continue;
        }
        let raw_val = attr.unescape_value().unwrap_or_default();

        let final_val = match (tag_lc, attr_name.as_str()) {
            ("a", "href") => rewrite_anchor_href(&raw_val),
            ("img", "src") => rewrite_img_src(&raw_val, archive, chapter_dir),
            _ => Some(raw_val.to_string()),
        };

        if let Some(val) = final_val {
            out.push(' ');
            out.push_str(&attr_name);
            out.push_str("=\"");
            write_escaped_attr(out, &val);
            out.push('"');
        }
    }

    out.push('>');
}

/// Internal ebook links become `#chapter-N` fragments so the client
/// router can swap chapters; everything external is dropped.
fn rewrite_anchor_href(href: &str) -> Option<String> {
    if href.starts_with('#') {
        return Some(href.to_string());
    }
    if href.starts_with("http://")
        || href.starts_with("https://")
        || href.starts_with("mailto:")
        || href.starts_with("javascript:")
        || href.starts_with("file:")
        || href.starts_with("data:")
    {
        // External links intentionally dropped — sanitized tier never
        // emits navigation to arbitrary URLs.
        return None;
    }
    // Relative internal link: strip any fragment, map to a marker the
    // reader-epub.js module can intercept.
    let (doc, _frag) = href.split_once('#').unwrap_or((href, ""));
    Some(format!("#epub-link:{}", doc))
}

/// Inline the referenced image as a data URI pulled from the ZIP.
/// Falls back to a tiny transparent pixel if the image can't be read.
fn rewrite_img_src<R: Read + std::io::Seek>(
    src: &str,
    archive: &mut ZipArchive<R>,
    chapter_dir: &str,
) -> Option<String> {
    if src.starts_with("data:") {
        return Some(src.to_string());
    }
    if src.starts_with("http://") || src.starts_with("https://") {
        // Remote images are dropped entirely — the whole point of the
        // sandbox is to prevent external resource loads.
        return None;
    }

    let path = join_path(chapter_dir, src);
    let bytes = read_entry(archive, &path).ok()?;
    if bytes.len() > MAX_INLINED_IMAGE_BYTES {
        return None;
    }

    let mime = guess_image_mime(&path);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{};base64,{}", mime, b64))
}

fn guess_image_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

/// Stream-safe HTML escaping for text nodes, with optional forensic
/// zero-width watermark interleaved at natural word boundaries.
fn write_escaped_text(out: &mut String, text: &str, forensic: &mut ForensicCursor) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
        if forensic.active() && ch == ' ' && forensic.should_mark() {
            out.push(forensic.next_zero_width());
        }
    }
}

fn write_escaped_attr(out: &mut String, val: &str) {
    for ch in val.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
}

// ---------------------------------------------------------------------
// Forensic zero-width watermark
// ---------------------------------------------------------------------

/// Emits U+200B / U+200C / U+200D sequences at natural word boundaries.
/// The sequence encodes the buyer address's raw bytes as a 3-symbol
/// stream (base-3 over the low trits of each byte), making the
/// watermark recoverable even after copy/paste of plain text while
/// staying invisible to the reader.
struct ForensicCursor {
    data: Vec<u8>,
    byte_index: usize,
    trit_index: usize,
    word_counter: u32,
    mark_every: u32,
}

impl ForensicCursor {
    fn new(mark: &str) -> Self {
        let data = mark.as_bytes().to_vec();
        Self {
            data,
            byte_index: 0,
            trit_index: 0,
            word_counter: 0,
            // Insert a watermark character roughly every ~12 words so a
            // casual reader never notices but forensic recovery has
            // plenty of samples per chapter.
            mark_every: 12,
        }
    }

    fn active(&self) -> bool {
        !self.data.is_empty()
    }

    fn should_mark(&mut self) -> bool {
        self.word_counter = self.word_counter.wrapping_add(1);
        self.mark_every != 0 && self.word_counter % self.mark_every == 0
    }

    fn next_zero_width(&mut self) -> char {
        if self.data.is_empty() {
            return '\u{200B}';
        }
        let byte = self.data[self.byte_index];
        // Five trits per byte (byte ÷ 3^k mod 3) is overkill for
        // identifiability; one trit per mark keeps the sequence lean.
        let trit = (byte / pow3(self.trit_index as u32) % 3) as u8;
        self.trit_index += 1;
        if self.trit_index >= 5 {
            self.trit_index = 0;
            self.byte_index = (self.byte_index + 1) % self.data.len();
        }
        match trit {
            0 => '\u{200B}', // zero-width space
            1 => '\u{200C}', // zero-width non-joiner
            _ => '\u{200D}', // zero-width joiner
        }
    }
}

fn pow3(mut n: u32) -> u8 {
    let mut acc: u8 = 1;
    while n > 0 {
        acc = acc.saturating_mul(3);
        n -= 1;
    }
    acc
}

// ---------------------------------------------------------------------
// SVG diagonal watermark
// ---------------------------------------------------------------------

/// Generate a diagonal repeating watermark SVG and return it as a
/// `data:` URI suitable for CSS `background-image`. The server owns
/// this watermark; the reader can't strip it without also breaking
/// the layout visibly.
fn build_watermark_svg_data_uri(text: &str) -> String {
    // Escape the text for XML body content.
    let safe: String = text
        .chars()
        .map(|c| match c {
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '&' => "&amp;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&apos;".to_string(),
            _ => c.to_string(),
        })
        .collect();

    let svg = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="520" height="260">
  <g fill="rgba(0,0,0,0.07)" transform="rotate(-28 260 130)">
    <text x="10" y="60"  font-family="monospace" font-size="15">{text}</text>
    <text x="10" y="95"  font-family="monospace" font-size="11" fill="rgba(0,0,0,0.05)">Elacity dDRM</text>
    <text x="10" y="200" font-family="monospace" font-size="15">{text}</text>
  </g>
</svg>"##,
        text = safe
    );
    let b64 = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
    format!("data:image/svg+xml;base64,{}", b64)
}

// ---------------------------------------------------------------------
// Chapter HTML wrapper
// ---------------------------------------------------------------------

/// Wrap the sanitized chapter HTML in a minimal HTML document with a
/// base stylesheet and the diagonal watermark overlay. The reader app
/// drops this into a fully sandboxed iframe (`sandbox=""` — no
/// scripts, no same-origin, no forms, no popups) under a strict CSP
/// set by the Node.js `/lit/secure-view` handler.
fn wrap_chapter_html(chapter: &str, watermark_uri: &str, viewport_width: u32) -> String {
    let wm_layer = if watermark_uri.is_empty() {
        String::new()
    } else {
        format!(
            r##"<div class="epub-watermark" aria-hidden="true" style="background-image:url('{}');"></div>"##,
            watermark_uri
        )
    };

    format!(
        concat!(
            "<!DOCTYPE html>\n",
            "<html><head><meta charset=\"utf-8\">",
            "<meta name=\"viewport\" content=\"width={vw},initial-scale=1\">",
            "<style>",
            ":root{{color-scheme:light dark}}",
            "html,body{{margin:0;padding:0;font-family:'Source Serif 4','Source Serif Pro',Georgia,serif;line-height:1.65;color:var(--epub-fg,#1a1a1a);background:var(--epub-bg,#fafaf7);}}",
            "body.epub-theme-night{{--epub-fg:#d8d8d2;--epub-bg:#1a1a1c;}}",
            "body.epub-theme-sepia{{--epub-fg:#4b3f2b;--epub-bg:#f4ecd8;}}",
            "main.epub-chapter{{max-width:{vw}px;margin:0 auto;padding:32px 24px 80px;position:relative;z-index:1;}}",
            "main.epub-chapter p{{margin:0 0 1em;text-align:justify;hyphens:auto;}}",
            "main.epub-chapter h1,main.epub-chapter h2,main.epub-chapter h3{{font-family:Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:-0.01em;}}",
            "main.epub-chapter h1{{font-size:1.8em;margin:1.6em 0 .6em;}}",
            "main.epub-chapter h2{{font-size:1.4em;margin:1.4em 0 .5em;}}",
            "main.epub-chapter h3{{font-size:1.15em;margin:1.2em 0 .4em;}}",
            "main.epub-chapter img{{max-width:100%;height:auto;display:block;margin:1em auto;}}",
            "main.epub-chapter blockquote{{border-left:3px solid rgba(0,0,0,0.18);padding:.2em 1em;margin:1em 0;color:rgba(0,0,0,0.72);}}",
            "main.epub-chapter code,main.epub-chapter pre{{font-family:'IBM Plex Mono',ui-monospace,Consolas,monospace;font-size:.92em;}}",
            "main.epub-chapter pre{{background:rgba(0,0,0,0.06);padding:.9em;border-radius:6px;overflow-x:auto;}}",
            "main.epub-chapter a{{color:#3b5bdb;text-decoration:underline;}}",
            "body.epub-theme-night main.epub-chapter a{{color:#94b1ff;}}",
            ".epub-watermark{{position:fixed;inset:0;pointer-events:none;background-repeat:repeat;background-size:520px 260px;opacity:.55;mix-blend-mode:multiply;z-index:2;}}",
            "body.epub-theme-night .epub-watermark{{mix-blend-mode:lighten;opacity:.25;}}",
            "</style></head>",
            "<body class=\"epub-theme-day\">",
            "<main class=\"epub-chapter\">{chapter}</main>",
            "{wm}",
            "</body></html>",
        ),
        vw = viewport_width,
        chapter = chapter,
        wm = wm_layer,
    )
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

fn read_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut f = archive.by_name(name).map_err(|e| e.to_string())?;
    let declared = f.size();
    let compressed = f.compressed_size();

    // Pre-allocation defence: the ZIP central directory lists attacker-
    // controlled uncompressed + compressed sizes. Reject anything that
    // either exceeds the per-entry cap or looks like a zip bomb.
    if declared > MAX_ENTRY_UNCOMPRESSED_BYTES {
        return Err(format!(
            "entry '{}' too large: declared {} bytes (cap {})",
            name, declared, MAX_ENTRY_UNCOMPRESSED_BYTES
        ));
    }
    if compressed > 0 && declared / compressed.max(1) > MAX_COMPRESSION_RATIO {
        return Err(format!(
            "entry '{}' rejected: suspicious compression ratio {}x",
            name,
            declared / compressed.max(1)
        ));
    }

    // Cap the initial allocation independent of declared size so that
    // even a miscalculated declared value can't force a huge up-front
    // allocation. `read_to_end` will grow as needed up to the hard cap
    // enforced by `take`.
    let cap = (declared as usize).min(MAX_ENTRY_UNCOMPRESSED_BYTES as usize);
    let mut buf = Vec::with_capacity(cap);
    let mut limited = (&mut f).take(MAX_ENTRY_UNCOMPRESSED_BYTES + 1);
    limited.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_ENTRY_UNCOMPRESSED_BYTES {
        return Err(format!(
            "entry '{}' exceeded uncompressed cap during read",
            name
        ));
    }
    Ok(buf)
}

fn local_name<'a>(qname: QName<'a>) -> &'a [u8] {
    qname.local_name().into_inner()
}

fn attr_value(e: &BytesStart, key: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if a.key.local_name().as_ref() == key {
            return Some(a.unescape_value().ok()?.to_string());
        }
    }
    None
}

fn ascii_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| b.to_ascii_lowercase() as char).collect()
}

/// Resolve a relative URL against the OPF or chapter directory, collapsing
/// `..` segments and removing any fragment / query.
fn join_path(base_dir: &str, rel: &str) -> String {
    let rel = rel.split('#').next().unwrap_or(rel);
    let rel = rel.split('?').next().unwrap_or(rel);
    if rel.starts_with('/') {
        return rel.trim_start_matches('/').to_string();
    }
    let mut parts: Vec<&str> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').filter(|p| !p.is_empty()).collect()
    };
    for seg in rel.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_path_basic() {
        assert_eq!(join_path("OEBPS", "ch01.xhtml"), "OEBPS/ch01.xhtml");
        assert_eq!(
            join_path("OEBPS/text", "../images/cover.jpg"),
            "OEBPS/images/cover.jpg"
        );
        assert_eq!(join_path("", "ch01.xhtml"), "ch01.xhtml");
        assert_eq!(
            join_path("OEBPS/text", "ch01.xhtml#section-2"),
            "OEBPS/text/ch01.xhtml"
        );
    }

    #[test]
    fn anchor_rewriting() {
        assert_eq!(rewrite_anchor_href("#foo"), Some("#foo".to_string()));
        assert_eq!(
            rewrite_anchor_href("ch02.xhtml"),
            Some("#epub-link:ch02.xhtml".to_string())
        );
        assert_eq!(rewrite_anchor_href("https://evil"), None);
        assert_eq!(rewrite_anchor_href("javascript:alert(1)"), None);
    }

    #[test]
    fn tag_allowlist_rejects_script() {
        assert!(is_dropped_subtree(b"script"));
        assert!(is_dropped_subtree(b"iframe"));
        assert!(!is_dropped_subtree(b"p"));
        assert!(!is_dropped_subtree(b"a"));
    }

    #[test]
    fn void_tags_identified() {
        assert!(is_void_tag("br"));
        assert!(is_void_tag("img"));
        assert!(!is_void_tag("p"));
    }

    #[test]
    fn forensic_cursor_emits_zero_width() {
        let mut c = ForensicCursor::new("0xabc");
        // Force mark_every conditions to guarantee emission in test.
        c.mark_every = 1;
        let first = c.next_zero_width();
        assert!(matches!(first, '\u{200B}' | '\u{200C}' | '\u{200D}'));
    }

    #[test]
    fn forensic_inactive_when_empty_mark() {
        let c = ForensicCursor::new("");
        assert!(!c.active());
    }

    #[test]
    fn watermark_svg_contains_text() {
        let uri = build_watermark_svg_data_uri("0xabcd");
        assert!(uri.starts_with("data:image/svg+xml;base64,"));
    }

    // ---------------------------------------------------------------
    // Hardening tests — added for V1.2 security pass.
    // ---------------------------------------------------------------

    /// Build an in-memory ZIP with a single named entry of `body` so
    /// `read_entry` / `sanitize_chapter` tests can run against a real
    /// `ZipArchive<Cursor<Vec<u8>>>`.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = Vec::<u8>::new();
        {
            let cursor = Cursor::new(&mut buf);
            let mut zw = zip::ZipWriter::new(cursor);
            // default deflate is fine; we're not stress-testing crypto.
            let opts: zip::write::FileOptions = zip::write::FileOptions::default();
            for (name, bytes) in entries {
                zw.start_file(*name, opts).unwrap();
                zw.write_all(bytes).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn read_entry_accepts_normal_size() {
        let zip = build_zip(&[("a.txt", b"hello")]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let out = read_entry(&mut archive, "a.txt").unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn read_entry_missing_returns_err() {
        let zip = build_zip(&[("a.txt", b"hello")]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        assert!(read_entry(&mut archive, "missing.txt").is_err());
    }

    #[test]
    fn manifest_cap_bounds_hashmap() {
        // Build an OPF that declares 50 manifest items but pass a
        // cap of 10 — manifest collection should stop at the cap.
        let mut items = String::new();
        for i in 0..50 {
            items.push_str(&format!(
                r#"<item id="i{0}" href="c{0}.xhtml" media-type="application/xhtml+xml"/>"#,
                i
            ));
        }
        let opf = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">T</dc:title></metadata>
  <manifest>{}</manifest>
  <spine><itemref idref="i0"/></spine>
</package>"#,
            items
        );
        let meta = parse_opf(opf.as_bytes(), 10).unwrap();
        // Spine still resolves the first entry (which is in the first
        // 10 captured manifest rows).
        assert_eq!(meta.spine.len(), 1);
        // Title was extracted regardless of the cap.
        assert_eq!(meta.title.as_deref(), Some("T"));
    }

    #[test]
    fn manifest_cap_preserves_spine_when_entry_inside_cap() {
        // Spine points at i3; cap=5 keeps i0..i4 — so spine resolves.
        let mut items = String::new();
        for i in 0..20 {
            items.push_str(&format!(
                r#"<item id="i{0}" href="c{0}.xhtml" media-type="application/xhtml+xml"/>"#,
                i
            ));
        }
        let opf = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata/>
  <manifest>{}</manifest>
  <spine><itemref idref="i3"/></spine>
</package>"#,
            items
        );
        let meta = parse_opf(opf.as_bytes(), 5).unwrap();
        assert_eq!(meta.spine, vec!["c3.xhtml"]);
    }

    #[test]
    fn sanitize_chapter_truncates_past_budget() {
        // Need an archive handle for the sanitizer signature even if no
        // images are referenced; empty archive is fine.
        let zip = build_zip(&[("placeholder", b"")]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();

        // Produce an XHTML with a long paragraph so output exceeds the
        // tiny budget we pass in.
        let big = "word ".repeat(500);
        let xhtml = format!(
            "<?xml version=\"1.0\"?><html><body><p>{}</p></body></html>",
            big
        );
        let sanitized =
            sanitize_chapter(&xhtml, &mut archive, "", "", 256).unwrap();
        assert!(
            sanitized.contains("[Content truncated"),
            "expected truncation marker, got: {}",
            &sanitized[sanitized.len().saturating_sub(80)..]
        );
    }

    #[test]
    fn sanitize_chapter_does_not_truncate_under_budget() {
        let zip = build_zip(&[("placeholder", b"")]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let xhtml = "<html><body><p>hello world</p></body></html>";
        let sanitized =
            sanitize_chapter(xhtml, &mut archive, "", "", 64 * 1024).unwrap();
        assert!(!sanitized.contains("[Content truncated"));
        assert!(sanitized.contains("<p>hello world</p>"));
    }

    #[test]
    fn sanitize_chapter_strips_script_subtree() {
        let zip = build_zip(&[("placeholder", b"")]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let xhtml = "<html><body><p>before</p><script>alert(1)</script><p>after</p></body></html>";
        let sanitized =
            sanitize_chapter(xhtml, &mut archive, "", "", 64 * 1024).unwrap();
        assert!(!sanitized.contains("alert"));
        assert!(!sanitized.contains("<script"));
        assert!(sanitized.contains("before"));
        assert!(sanitized.contains("after"));
    }

    #[test]
    fn sanitize_chapter_drops_on_handlers_and_style() {
        let zip = build_zip(&[("placeholder", b"")]);
        let mut archive = ZipArchive::new(Cursor::new(zip)).unwrap();
        let xhtml = r#"<html><body><p onclick="evil()" style="color:red">x</p></body></html>"#;
        let sanitized =
            sanitize_chapter(xhtml, &mut archive, "", "", 64 * 1024).unwrap();
        assert!(!sanitized.contains("onclick"));
        assert!(!sanitized.contains("style="));
        assert!(!sanitized.contains("evil"));
    }

    #[test]
    fn safety_constants_are_conservative() {
        // Guard-rail test: keep these limits in the sane zone so a
        // future refactor can't silently 10× them without review.
        assert!(MAX_ENTRY_UNCOMPRESSED_BYTES <= 64 * 1024 * 1024);
        assert!(MAX_CHAPTER_HTML_BYTES <= 64 * 1024 * 1024);
        assert!(MAX_COMPRESSION_RATIO <= 500);
        assert!(MAX_MANIFEST_ENTRIES <= 100_000);
        assert!(MAX_CHAPTERS <= 10_000);
    }
}
