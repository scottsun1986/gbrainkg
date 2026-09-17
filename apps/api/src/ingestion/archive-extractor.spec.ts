import AdmZip = require('adm-zip');
import * as tar from 'tar';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  extractArchiveDocuments,
  sanitizeArchiveEntryPath,
  stripCommonArchiveRoot,
  generateUniqueDocumentTitle,
} from './archive-extractor';

describe('archive-extractor', () => {
  describe('sanitizeArchiveEntryPath', () => {
    it('allows valid supported document paths', () => {
      expect(sanitizeArchiveEntryPath('docs/guide.md')).toBe('docs/guide.md');
      expect(sanitizeArchiveEntryPath('report.pdf')).toBe('report.pdf');
      expect(sanitizeArchiveEntryPath('财务报表/2026年终总结.docx')).toBe(
        '财务报表/2026年终总结.docx',
      );
    });

    it('blocks directory traversal / zip-slip attempts', () => {
      expect(sanitizeArchiveEntryPath('../../etc/passwd.txt')).toBeNull();
      expect(sanitizeArchiveEntryPath('../docs/readme.md')).toBeNull();
      expect(sanitizeArchiveEntryPath('/etc/hosts.txt')).toBeNull();
      expect(sanitizeArchiveEntryPath('a/../../b.md')).toBeNull();
    });

    it('filters out OS and hidden metadata files', () => {
      expect(sanitizeArchiveEntryPath('__MACOSX/._guide.md')).toBeNull();
      expect(sanitizeArchiveEntryPath('docs/.DS_Store')).toBeNull();
      expect(sanitizeArchiveEntryPath('.gitignore')).toBeNull();
      expect(sanitizeArchiveEntryPath('folder/Thumbs.db')).toBeNull();
      expect(sanitizeArchiveEntryPath('folder/desktop.ini')).toBeNull();
      expect(sanitizeArchiveEntryPath('.hidden/normal.pdf')).toBeNull();
    });

    it('filters out unsupported file extensions', () => {
      expect(sanitizeArchiveEntryPath('script.py')).toBeNull();
      expect(sanitizeArchiveEntryPath('virus.exe')).toBeNull();
      expect(sanitizeArchiveEntryPath('config.json')).toBeNull();
      expect(sanitizeArchiveEntryPath('index.js')).toBeNull();
    });
  });

  describe('stripCommonArchiveRoot', () => {
    it('strips common root prefix when all files share the same folder', () => {
      const paths = ['project-v1/readme.md', 'project-v1/docs/setup.md'];
      const map = stripCommonArchiveRoot(paths);
      expect(map.get('project-v1/readme.md')).toBe('readme.md');
      expect(map.get('project-v1/docs/setup.md')).toBe('docs/setup.md');
    });

    it('keeps paths intact when entries do not share a common root', () => {
      const paths = ['readme.md', 'docs/setup.md'];
      const map = stripCommonArchiveRoot(paths);
      expect(map.get('readme.md')).toBe('readme.md');
      expect(map.get('docs/setup.md')).toBe('docs/setup.md');
    });
  });

  describe('generateUniqueDocumentTitle', () => {
    it('replaces slashes with dashes and maintains extensions', () => {
      const used = new Set<string>();
      const title = generateUniqueDocumentTitle('docs/sub/guide.md', used);
      expect(title).toBe('docs-sub-guide.md');
    });

    it('resolves duplicate collisions', () => {
      const used = new Set<string>();
      const t1 = generateUniqueDocumentTitle('guide.md', used);
      const t2 = generateUniqueDocumentTitle('guide.md', used);
      expect(t1).toBe('guide.md');
      expect(t2).toBe('guide-1.md');
    });
  });

  describe('extractArchiveDocuments with ZIP', () => {
    it('extracts valid documents and ignores junk files from a zip buffer', async () => {
      const zip = new AdmZip();
      zip.addFile('readme.md', Buffer.from('# Readme\nThis is valid content.'));
      zip.addFile('notes.txt', Buffer.from('Important notes here.'));
      zip.addFile('__MACOSX/._readme.md', Buffer.from('junk metadata'));
      zip.addFile('.DS_Store', Buffer.from('mac os junk'));
      zip.addFile('setup.py', Buffer.from('print("hello")'));
      zip.addFile('empty.txt', Buffer.from('   \n\t  '));

      const zipBuffer = zip.toBuffer();
      const extracted = await extractArchiveDocuments(zipBuffer, 'test.zip');

      expect(extracted.length).toBe(2);
      expect(extracted.map((e) => e.filename).sort()).toEqual(['notes.txt', 'readme.md']);
      expect(extracted.find((e) => e.filename === 'readme.md')?.buffer.toString('utf8')).toContain(
        '# Readme',
      );
    });

    it('throws BadRequestException if no valid documents exist in zip', async () => {
      const zip = new AdmZip();
      zip.addFile('script.sh', Buffer.from('echo hello'));
      zip.addFile('.DS_Store', Buffer.from('junk'));

      const zipBuffer = zip.toBuffer();
      await expect(extractArchiveDocuments(zipBuffer, 'empty.zip')).rejects.toThrow(
        /未包含有效且受支持的文档/,
      );
    });

    it('handles Chinese filenames and nested directories with duplicate basenames', async () => {
      const zip = new AdmZip();
      zip.addFile('产品部/操作指引.md', Buffer.from('# 产品部指引'));
      zip.addFile('研发部/操作指引.md', Buffer.from('# 研发部指引'));
      zip.addFile('财务报表.xlsx', Buffer.from('fake-excel-data'));

      const zipBuffer = zip.toBuffer();
      const extracted = await extractArchiveDocuments(zipBuffer, '企业资料.zip');

      expect(extracted.length).toBe(3);
      const names = extracted.map((e) => e.filename);
      expect(names).toContain('财务报表.xlsx');
      expect(names).toContain('产品部-操作指引.md');
      expect(names).toContain('研发部-操作指引.md');
    });

    it('rejects corrupted zip files gracefully', async () => {
      const badBuffer = Buffer.from('not a zip file at all');
      await expect(extractArchiveDocuments(badBuffer, 'corrupted.zip')).rejects.toThrow();
    });
  });

  describe('extractArchiveDocuments with TAR and TAR.GZ', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('extracts valid documents from a tar.gz archive', async () => {
      const file1 = path.join(tmpDir, 'arch-guide.md');
      const file2 = path.join(tmpDir, 'schema.csv');
      const junk = path.join(tmpDir, 'temp.bin');

      fs.writeFileSync(file1, '# Architecture\nDeep design.');
      fs.writeFileSync(file2, 'id,name\n1,alpha');
      fs.writeFileSync(junk, Buffer.from([0x00, 0x01]));

      const tarPath = path.join(tmpDir, 'archive.tar.gz');
      await tar.create({ gzip: true, file: tarPath, cwd: tmpDir }, [
        'arch-guide.md',
        'schema.csv',
        'temp.bin',
      ]);

      const buffer = fs.readFileSync(tarPath);
      const extracted = await extractArchiveDocuments(buffer, 'archive.tar.gz');

      expect(extracted.length).toBe(2);
      expect(extracted.map((e) => e.filename).sort()).toEqual(['arch-guide.md', 'schema.csv']);
    });

    it('handles plain uncompressed tar archives', async () => {
      const file1 = path.join(tmpDir, 'test.md');
      fs.writeFileSync(file1, '# Plain Tar Document');

      const tarPath = path.join(tmpDir, 'bundle.tar');
      await tar.create({ file: tarPath, cwd: tmpDir }, ['test.md']);

      const buffer = fs.readFileSync(tarPath);
      const extracted = await extractArchiveDocuments(buffer, 'bundle.tar');

      expect(extracted.length).toBe(1);
      expect(extracted[0].filename).toBe('test.md');
    });
  });
});
