'use strict';
// Compare a clean npm ci installation without following links, including .env.
const fs = require('node:fs');
const path = require('node:path');
function equal(a, b) {
  const x = fs.lstatSync(a),
    y = fs.lstatSync(b);
  if (x.mode !== y.mode) return false;
  if (x.isSymbolicLink()) return fs.readlinkSync(a) === fs.readlinkSync(b);
  if (x.isFile()) return x.size === y.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  if (!x.isDirectory()) return false;
  const left = fs.readdirSync(a).sort(),
    right = fs.readdirSync(b).sort();
  return (
    left.length === right.length &&
    left.every((n, i) => n === right[i] && equal(path.join(a, n), path.join(b, n)))
  );
}
if (require.main === module) process.exitCode = equal(process.argv[2], process.argv[3]) ? 0 : 1;
module.exports = { equal };
