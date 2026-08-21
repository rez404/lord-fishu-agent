/**
 * Deliberately plain ASCII. Box-drawing block letters look better in an editor, but no
 * single web font carries both the block glyphs and the text glyphs, so the browser
 * falls back per character, the advance widths stop matching, and the whole thing
 * smears. Every character here exists in any monospace face.
 *
 * Rendered with `white-space: pre`; trailing spaces are load-bearing.
 */
export const WORDMARK = String.raw`
  _     ___  ____  ____     _____ ___ ____  _   _ _   _ _   _ 
 | |   / _ \|  _ \|  _ \   |  ___|_ _/ ___|| | | | \ | | | | |
 | |  | | | | |_) | | | |  | |_   | |\___ \| |_| |  \| | | | |
 | |__| |_| |  _ <| |_| |  |  _|  | | ___) |  _  | |\  | |_| |
 |_____\___/|_| \_\____/   |_|   |___|____/|_| |_|_| \_|\___/ 
`.replace(/^\n/, '');

/** Shown beneath the wordmark, because a fish god deserves one. */
export const SIGIL = `        ><(((("> . . . . . . . . . . . . ><((((">`;
