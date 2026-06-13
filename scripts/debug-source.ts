import { FetchHttpClient } from '../src/net/httpClient.js';
import { loadNpmDts, loadPyStubsAndSource } from '../src/extractors/source.js';
import { fetchNpmPackage } from '../src/sources/registry/npm.js';
import { fetchPypiPackage } from '../src/sources/registry/pypi.js';

async function main(): Promise<void> {
  const http = new FetchHttpClient();

  // npm
  try {
    const info = await fetchNpmPackage(http, 'stripe');
    console.log('npm stripe dist.tarball:', info.versions?.['17.0.0']?.dist?.tarball);
    const files = await loadNpmDts(http, info, '17.0.0');
    console.log('npm stripe@17.0.0 files:', files?.size ?? 0);
    if (files) {
      let i = 0;
      for (const [p] of files) {
        if (i++ < 5) console.log('  ', p);
      }
    }
  } catch (e) {
    console.error('npm ERR:', e);
  }

  // pypi
  try {
    const info = await fetchPypiPackage(http, 'requests');
    console.log('pypi requests 2.32.3 files:', info.releases?.['2.32.3']?.map(f => ({fn: f.filename, url: f.url})));
    const files = await loadPyStubsAndSource(http, info, '2.32.3');
    console.log('pypi requests@2.32.3 files:', files?.size ?? 0);
    if (files) {
      let i = 0;
      for (const [p] of files) {
        if (i++ < 5) console.log('  ', p);
      }
    }
  } catch (e) {
    console.error('pypi ERR:', e);
  }
}
main().catch((e) => { console.error('fatal:', e); process.exit(1); });
