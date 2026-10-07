// Compiles this OS's native computer helper while packaging so the first
// computer call does not pay for the compiler. A local failure is not fatal:
// the app builds the helper itself on first use. A CI Mac build fails,
// because a downloaded Mac app cannot count on swiftc (Windows ships csc).
const path = require('node:path');

const driver = { darwin: 'computer.cjs', win32: 'win-computer.cjs' }[process.platform];
if (!driver) {
  console.log(`No native computer helper to build on ${process.platform}.`);
} else {
  require(path.join(__dirname, '..', 'src', driver)).ensureBinary().then(
    (file) => console.log(`Built ${file}`),
    (error) => {
      console.warn(`Computer helper not prebuilt, it will build on first use: ${String(error.message).split('\n')[0]}`);
      if (process.env.CI && process.platform === 'darwin') process.exitCode = 1;
    },
  );
}
