import * as fs from 'fs';
import * as path from 'path';

export type StaticFileResolution =
  | { kind: 'file'; path: string }
  | { kind: 'not_found' }
  | { kind: 'forbidden' };

/** Segment-aware containment; unlike startsWith it rejects sibling prefixes. */
export function isPathContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Resolve one decoded HTTP pathname to an existing real file below root.
 * Both the root and candidate are realpath-resolved, so a symlink cannot
 * escape into a sibling directory or the rest of the filesystem.
 */
export function resolveStaticFile(
  webBuildDir: string,
  decodedPathname: string,
): StaticFileResolution {
  if (
    !decodedPathname.startsWith('/') ||
    decodedPathname.includes('\0') ||
    decodedPathname.includes('\\')
  ) return { kind: 'forbidden' };

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(webBuildDir);
  } catch {
    return { kind: 'not_found' };
  }

  const relativeRequest = decodedPathname.replace(/^\/+/, '') || 'index.html';
  const lexicalCandidate = path.resolve(realRoot, relativeRequest);
  if (!isPathContained(realRoot, lexicalCandidate)) return { kind: 'forbidden' };

  const inspected = inspectExisting(realRoot, lexicalCandidate);
  if (inspected.kind === 'forbidden') return inspected;
  if (inspected.kind === 'file') return inspected;

  // Expo's history routes fall back to the app shell; asset-like requests do
  // not. Resolve index.html with the same realpath containment checks because
  // the index itself might otherwise be an escaping symlink.
  const ext = path.extname(lexicalCandidate).toLowerCase();
  if (ext !== '' && ext !== '.html') return { kind: 'not_found' };
  return inspectExisting(realRoot, path.join(realRoot, 'index.html'));
}

function inspectExisting(root: string, candidate: string): StaticFileResolution {
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    return { kind: 'not_found' };
  }
  if (!isPathContained(root, realCandidate)) return { kind: 'forbidden' };
  try {
    if (!fs.statSync(realCandidate).isFile()) return { kind: 'not_found' };
  } catch {
    return { kind: 'not_found' };
  }
  return { kind: 'file', path: realCandidate };
}
