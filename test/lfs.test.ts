import { describe, expect, it } from 'vitest';
import { isLfsPointerBuffer, parseLfsLsFiles, parseLfsPatternsFromAttributes, parseLfsPointerText, parseLfsProgressLine, parseLfsPruneOutput, parseLfsStatusPorcelain } from '../src/main/git/lfs';

const OID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 12345\n`;

describe('parseLfsPointerText / isLfsPointerBuffer', () => {
  it('parses a well-formed pointer', () => {
    expect(parseLfsPointerText(POINTER)).toEqual({ oid: OID, size: 12345 });
  });

  it('tolerates a trailing CRLF on every line', () => {
    const crlf = POINTER.replace(/\n/g, '\r\n');
    expect(parseLfsPointerText(crlf)).toEqual({ oid: OID, size: 12345 });
  });

  it('rejects ordinary text content', () => {
    expect(parseLfsPointerText('export const value = 1;\n')).toBeNull();
  });

  it('rejects content missing the oid or size line', () => {
    expect(parseLfsPointerText('version https://git-lfs.github.com/spec/v1\noid sha256:abc\n')).toBeNull();
  });

  it('isLfsPointerBuffer returns null for large buffers even if they start with the marker', () => {
    const big = Buffer.from(POINTER + 'x'.repeat(2000));
    expect(isLfsPointerBuffer(big)).toBeNull();
  });

  it('isLfsPointerBuffer returns null for a null buffer', () => {
    expect(isLfsPointerBuffer(null)).toBeNull();
  });

  it('isLfsPointerBuffer parses a normal-sized pointer buffer', () => {
    expect(isLfsPointerBuffer(Buffer.from(POINTER))?.size).toBe(12345);
  });
});

describe('parseLfsPatternsFromAttributes', () => {
  it('extracts patterns marked filter=lfs', () => {
    const content = '*.psd filter=lfs diff=lfs merge=lfs -text\n*.png binary\n*.zip filter=lfs -text\n';
    expect(parseLfsPatternsFromAttributes(content)).toEqual(['*.psd', '*.zip']);
  });

  it('ignores comments and blank lines', () => {
    const content = '# LFS patterns\n\n*.mp4 filter=lfs -text\n';
    expect(parseLfsPatternsFromAttributes(content)).toEqual(['*.mp4']);
  });

  it('returns an empty array when nothing uses the lfs filter', () => {
    expect(parseLfsPatternsFromAttributes('*.md text\n')).toEqual([]);
  });
});

describe('parseLfsLsFiles', () => {
  it('parses a present object with a size', () => {
    const out = '4c48b98b4d * README.psd (4.0 MB)\n';
    expect(parseLfsLsFiles(out)).toEqual([{ oid: '4c48b98b4d', present: true, path: 'README.psd', size: 4 * 1024 * 1024 }]);
  });

  it('parses a missing (pointer-only) object', () => {
    const out = '4c48b98b4d - assets/big.bin (128 KB)\n';
    const [f] = parseLfsLsFiles(out);
    expect(f.present).toBe(false);
    expect(f.size).toBe(128 * 1024);
  });

  it('parses a line with no size suffix', () => {
    expect(parseLfsLsFiles('4c48b98b4d * file.bin\n')).toEqual([{ oid: '4c48b98b4d', present: true, path: 'file.bin', size: null }]);
  });

  it('handles multiple files and blank lines', () => {
    const out = '4c48b98b4d * a.psd (1 KB)\n\n5d59c99c5e - b.psd (2 KB)\n';
    expect(parseLfsLsFiles(out)).toHaveLength(2);
  });
});

describe('parseLfsStatusPorcelain', () => {
  it('parses a staged modification (two-column form)', () => {
    expect(parseLfsStatusPorcelain('M  file.psd\n')).toEqual([{ path: 'file.psd', staged: true, unstaged: false, status: 'modified' }]);
  });

  it('parses an unstaged modification (two-column form)', () => {
    expect(parseLfsStatusPorcelain(' M file.psd\n')).toEqual([{ path: 'file.psd', staged: false, unstaged: true, status: 'modified' }]);
  });

  it('parses git-lfs single-letter lines with a trailing size', () => {
    expect(parseLfsStatusPorcelain('A  new.psd 12345\n')).toEqual([{ path: 'new.psd', staged: true, unstaged: false, status: 'added' }]);
    expect(parseLfsStatusPorcelain('m  images/photo 2.psd 999\n')[0]).toMatchObject({ path: 'images/photo 2.psd', status: 'modified' });
  });

  it('takes the destination of a rename', () => {
    expect(parseLfsStatusPorcelain('R  old.psd -> new.psd 42\n')[0]).toMatchObject({ path: 'new.psd', status: 'renamed' });
  });
});

describe('parseLfsProgressLine', () => {
  it('extracts a percentage from a download progress line', () => {
    expect(parseLfsProgressLine('Downloading LFS objects: 45% (3/7), 1.2 MB | 500 KB/s')).toEqual({ percent: 0.45, description: 'Downloading LFS objects: 45% (3/7), 1.2 MB | 500 KB/s' });
  });

  it('matches a percentage embedded in an otherwise different message', () => {
    expect(parseLfsProgressLine('Filtering content: 100% (7/7), done.')).not.toBeNull();
  });

  it('returns null when no percentage is present', () => {
    expect(parseLfsProgressLine('nothing to see here')).toBeNull();
  });

  it('returns the latest match when a chunk has multiple lines', () => {
    const chunk = 'Downloading LFS objects: 10% (1/10)\nDownloading LFS objects: 20% (2/10)';
    expect(parseLfsProgressLine(chunk)?.percent).toBe(0.2);
  });
});

describe('parseLfsPruneOutput', () => {
  it('parses the dry-run summary', () => {
    expect(parseLfsPruneOutput('prune: 5 local object(s), 2 retained, done.\nprune: 3 file(s) would be pruned (1.2 MB)\n')).toEqual({ objects: 3, bytes: Math.round(1.2 * 1024 * 1024) });
  });

  it('parses the real-run deletion line', () => {
    expect(parseLfsPruneOutput('prune: 5 local object(s), 2 retained, done.\nprune: Deleting objects: 100% (3/3), done.\n')).toEqual({ objects: 3, bytes: 0 });
  });

  it('parses an objects+size summary', () => {
    expect(parseLfsPruneOutput('prune: 3 local objects, 1.2 MB')).toEqual({ objects: 3, bytes: Math.round(1.2 * 1024 * 1024) });
  });

  it('returns zero for unrecognised output', () => {
    expect(parseLfsPruneOutput('')).toEqual({ objects: 0, bytes: 0 });
  });
});
