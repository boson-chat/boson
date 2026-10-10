// electron-builder `afterSign` hook — ad-hoc signs the packaged macOS
// .app bundle using `codesign --sign -`. Runs after electron-builder
// finishes packaging the app (and after it skips its own signing path,
// because we deliberately don't configure a keychain identity for
// unsigned v0.x builds).
//
// Why this exists: passing `mac.identity: '-'` in electron-builder.yml
// looks like it should request ad-hoc signing, but electron-builder
// actually treats the value as a keychain identity *name* and
// `security find-identity` won't return anything for `-`. The result
// is that electron-builder logs "skipped macOS application code
// signing" and ships an unsigned bundle — which on Apple Silicon
// fails to load with "Boson is damaged and can't be opened."
//
// Running our own codesign step here closes that gap. Ad-hoc
// signatures don't need an Apple Developer cert; they just compute a
// content hash so the kernel will load the binary. First-launch still
// shows the "unverified developer" Gatekeeper prompt (right-click ->
// Open dismisses it). That's documented in /download#first-launch-macos
// on the website.

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function macAdhocSign(context) {
  // Only relevant for darwin builds. Linux + Windows take the same
  // afterSign hook but bail out here.
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // Developer ID build: electron-builder already signed (and, with
  // notarize on, notarized) the bundle — via CSC_LINK in CI or a keychain
  // identity locally. Re-signing ad hoc would replace that signature and
  // break notarization, so only ad-hoc sign bundles that aren't signed with
  // a real identity.
  if (developerIdSigned(appPath)) {
    console.log('[mac-adhoc-sign] bundle is Developer ID signed, skipping ad-hoc signing');
    return;
  }

  console.log(`[mac-adhoc-sign] codesign --sign - --force --deep --timestamp=none "${appPath}"`);
  // --deep is documented as discouraged for production Developer-ID
  // signing, but for ad-hoc it's the simplest way to sign the main
  // bundle plus every nested Helper.app and Framework in one pass.
  // --options runtime is intentionally OFF — Hardened Runtime requires
  // a real Developer ID to satisfy notarization.
  execFileSync(
    'codesign',
    ['--sign', '-', '--force', '--deep', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );

  // Sanity check the signature electron-builder is about to package
  // into the .dmg / .zip. If this fails the build fails — better than
  // shipping an unsigned bundle and learning about it from users.
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  );
};

// True when codesign reports a "Developer ID Application" authority for the
// bundle. codesign -dv prints its report on stderr (exit 0 when signed,
// non-zero when unsigned); an ad-hoc signature has no Authority lines.
function developerIdSigned(appPath) {
  const r = spawnSync('codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' });
  return /Authority=Developer ID Application:/.test(`${r.stdout ?? ''}${r.stderr ?? ''}`);
}
