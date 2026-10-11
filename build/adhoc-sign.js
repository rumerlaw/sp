/* Gives the Mac app a basic (ad-hoc) signature. Without any signature, macOS on newer Macs says the app is "damaged". */
const path = require('path');
const { execFileSync } = require('child_process');
exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
