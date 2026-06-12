/**
 * image — pure helpers for the /antigravity:image command.
 *
 * agy `--print` returns only natural-language text (no structured tool output),
 * so the model is asked to end its reply with an `IMAGE_PATH:` marker line and
 * we recover the saved file path from that text. This module owns that parsing
 * so the command module stays a thin wire-up around runAgyPrint.
 */

const MARKER_PATTERN = /^[ \t]*IMAGE_PATH:[ \t]*(\S.*?)[ \t]*$/gim;
const SCRAPE_PATTERN = /\/\S+\.(?:png|jpg|jpeg|webp)\b/i;

/**
 * Extract the saved image path from agy's textual reply.
 *
 * Strategy mirrors the contract we ask the model to honor: prefer the explicit
 * `IMAGE_PATH:` marker (last one wins, since agy echoes the prompt's own
 * contract line first); if the model skips the marker, scrape the first
 * image-looking path out of the prose.
 *
 * @param {string} stdout - agy's full --print response.
 * @returns {{ imagePath: string|null, source: 'marker'|'scrape'|null }}
 */
export function extractImagePath(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';

  const markers = [...text.matchAll(MARKER_PATTERN)];
  if (markers.length > 0) {
    return { imagePath: markers[markers.length - 1][1], source: 'marker' };
  }

  const scraped = text.match(SCRAPE_PATTERN);
  if (scraped) {
    return { imagePath: scraped[0], source: 'scrape' };
  }

  return { imagePath: null, source: null };
}
